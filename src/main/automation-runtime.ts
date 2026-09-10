import { join } from 'node:path';
import { shell } from 'electron';
import type { ProjectConfig } from '../shared/contracts/project-config.js';
import { AtomicJsonFileStore } from './state/persistence.js';
import {
  EdgeProfileManager,
  EdgeStateAdapter,
  HttpCdpTransport,
  CdpConversationController,
  ContextRecoveryManager,
  SolSessionBindingStore,
  type EdgeSolObservation,
  type SolConversationIdentity,
} from './edge/index.js';
import { GovernanceChangeApplier } from './governance/change-applier.js';
import { GovernanceManifestStore } from './governance/manifest.js';
import { ArchitectureFreezeDownloader } from './architecture/freeze-downloader.js';
import { GitController } from './git/index.js';
import { CodexRunner } from './codex/index.js';
import { MainOrchestrator, type OrchestratorState } from './orchestration/index.js';
import type { NotificationService } from './notify/index.js';
import { SolPromptCompiler } from './sol/prompt-compiler.js';
import { createHash } from 'node:crypto';

const CHATGPT_URL = 'https://chatgpt.com/';
const DEFAULT_EDGE_PORT = 9227;

function validateOrchestratorState(value: unknown): OrchestratorState {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Invalid orchestrator state');
  const state = value as OrchestratorState;
  if (state.version !== 1 || typeof state.revision !== 'number' || typeof state.phase !== 'string') {
    throw new TypeError('Invalid orchestrator state');
  }
  return state;
}

export interface AutomationRuntime {
  orchestrator: MainOrchestrator;
  startPolling(): void;
  stop(): void;
}

export async function createAutomationRuntime(
  config: ProjectConfig,
  userDataDirectory: string,
  notifier: NotificationService,
): Promise<AutomationRuntime> {
  const stateDirectory = join(userDataDirectory, 'state');
  const profile = new EdgeProfileManager({
    userDataDirectory: join(userDataDirectory, 'edge-profile'),
    remoteDebuggingPort: DEFAULT_EDGE_PORT,
    initialUrl: CHATGPT_URL,
    onProcessExit: () =>
      notifier.notify({
        project: config.projectId,
        taskId: null,
        phase: 'EDGE',
        suggestion: '请检查专用 Edge 是否仍在运行，然后重试。',
        error: { code: 'EDGE_PROCESS_EXITED', message: '专用 Edge 进程已退出。' },
        level: 'NEEDS_USER',
      }),
  });
  let transport: HttpCdpTransport | null = null;
  let adapter: EdgeStateAdapter | null = null;
  let conversations: CdpConversationController | null = null;
  const bindingStore = new SolSessionBindingStore({
    filePath: join(stateDirectory, `${config.projectId}-sol-session.json`),
  });

  const ensureEdge = async (): Promise<void> => {
    if (transport !== null && adapter !== null && conversations !== null) {
      profile.assertUsable();
      return;
    }
    const handle = await profile.startOrReuse();
    profile.assertUsable();
    transport = new HttpCdpTransport({ port: handle.remoteDebuggingPort });
    adapter = new EdgeStateAdapter(transport);
    conversations = new CdpConversationController({ transport, adapter });
  };

  const edge = {
    observe: async (): Promise<EdgeSolObservation> => {
      await ensureEdge();
      const state = await bindingStore.load();
      const targetId = state?.conversationChain.find(
        (entry) => entry.conversationId === state.activeConversationId,
      )?.targetId;
      if (targetId === undefined || adapter === null) {
        return {
          targetId: '',
          title: '',
          url: '',
          projectFingerprint: null,
          accountFingerprint: null,
          latestAssistantText: '',
          latestAssistantHash: null,
          statusText: '',
          errorText: '',
          loginWall: false,
          sessionMissing: false,
          contextLimit: false,
          networkError: false,
          isThinking: false,
          writingBlockIncomplete: false,
          sampledAt: new Date().toISOString(),
          status: 'AMBIGUOUS',
          adapterVersion: adapter?.rules.version ?? 'uninitialized',
          consecutiveStableSamples: 0,
        };
      }
      return adapter.sample(targetId);
    },
  };

  const conversationPort = {
    createConversation: async (input: Parameters<CdpConversationController['createConversation']>[0]) => {
      await ensureEdge();
      if (conversations === null) throw new Error('Edge conversation controller is unavailable.');
      return conversations.createConversation(input);
    },
    sendMessage: async (input: Parameters<CdpConversationController['sendMessage']>[0]) => {
      await ensureEdge();
      if (conversations === null) throw new Error('Edge conversation controller is unavailable.');
      return conversations.sendMessage(input);
    },
  };
  const sol = {
    sendMessage: async (input: { text: string; observation: EdgeSolObservation }): Promise<void> => {
      await ensureEdge();
      const state = await bindingStore.load();
      const record = state?.conversationChain.find((entry) => entry.conversationId === state.activeConversationId);
      if (state === null || state === undefined || record === undefined || conversations === null) {
        throw new Error('No bound Sol conversation is available.');
      }
      const identity: SolConversationIdentity = {
        conversationId: record.conversationId,
        url: record.url,
        title: record.title,
        projectFingerprint: record.projectFingerprint,
        accountFingerprint: record.accountFingerprint,
        targetId: record.targetId,
      };
      bindingStore.assertCanSend(identity);
      await bindingStore.recordRawInput(input.text);
      await conversations.sendMessage({ conversation: identity, text: input.text });
    },
  };

  const rebind = async (): Promise<void> => {
    await ensureEdge();
    if (transport === null || adapter === null) throw new Error('Edge transport is unavailable.');
    const targets = await transport.listTargets();
    for (const target of targets) {
      if (target.type !== 'page') continue;
      const observation = await adapter.sample(target.id);
      if (
        observation.projectFingerprint !== null &&
        observation.accountFingerprint !== null &&
        observation.url.startsWith('https://')
      ) {
        await bindingStore.bind(observation);
        return;
      }
    }
    throw new Error('未找到可绑定的 ChatGPT Project 会话，请先在专用 Edge 中打开目标会话。');
  };

  const git = new GitController({
    pendingPushStatePath: join(stateDirectory, `${config.projectId}-git-pending-push.json`),
  });
  await git.recoverPendingPushes();
  const manifestStore = new GovernanceManifestStore(config.localPath, config.governanceManifestPath);
  const governance = new GovernanceChangeApplier(config.localPath, { manifestStore });
  const architecture = new ArchitectureFreezeDownloader(config.localPath);
  const codex = new CodexRunner({
    defaultModel: 'gpt-5.6-luna',
    sessionStorePath: join(stateDirectory, `${config.projectId}-codex-sessions.json`),
    streamLogDirectory: join(userDataDirectory, 'streams', config.projectId),
  });
  const stateStore = new AtomicJsonFileStore<OrchestratorState>(
    join(stateDirectory, `${config.projectId}-orchestrator.json`),
    { validate: validateOrchestratorState },
  );
  const promptCompiler = new SolPromptCompiler();
  const waitForReconciliationOutput = async (before: EdgeSolObservation): Promise<EdgeSolObservation> => {
    const beforeHash = before.latestAssistantHash ?? hashObservedText(before.latestAssistantText);
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 1_000));
      const current = await edge.observe();
      if (current.status === 'CONTEXT_LIMIT') throw new Error('GOVERNANCE_RECONCILIATION_CONTEXT_LIMIT');
      if (current.status === 'AUTH_REQUIRED') throw new Error('GOVERNANCE_RECONCILIATION_AUTH_REQUIRED');
      if (current.status === 'NETWORK_ERROR' || current.status === 'SESSION_LOST') {
        throw new Error(`GOVERNANCE_RECONCILIATION_${current.status}`);
      }
      const currentHash = current.latestAssistantHash ?? hashObservedText(current.latestAssistantText);
      if (current.status === 'COMPLETED_CANDIDATE' && currentHash !== null && currentHash !== beforeHash)
        return current;
    }
    throw new Error('GOVERNANCE_RECONCILIATION_TIMEOUT');
  };
  const orchestrator = new MainOrchestrator({
    project: {
      projectId: config.projectId,
      name: config.projectId,
      localPath: config.localPath,
      remoteUrl: config.remoteUrl,
    },
    edge,
    sol,
    contextRecovery: new ContextRecoveryManager({ bindingStore, conversations: conversationPort }),
    git,
    governance,
    architecture,
    codex,
    stateStore,
    targetBranch: config.targetBranch,
    expectedRemoteUrl: config.remoteUrl,
    notifier,
    callbacks: {
      rebind,
      governanceConsistencyCheck: async () => {
        const resumeLoop = orchestrator.getState().active;
        if (resumeLoop) await orchestrator.pause();
        try {
          const before = await edge.observe();
          const baseline = await git.captureBaseline(config.localPath, {
            ...(config.targetBranch === 'HEAD' ? {} : { expectedBranch: config.targetBranch }),
            ...(config.remoteUrl === null ? {} : { expectedRemoteUrl: config.remoteUrl }),
          });
          const prompt = promptCompiler.compileGovernanceReconciliationPrompt({
            project: config,
            baselineCommit: baseline.head,
          });
          await sol.sendMessage({ text: prompt, observation: before });
          const completed = await waitForReconciliationOutput(before);
          const result = await orchestrator.runGovernanceReconciliation({
            solOutput: completed.latestAssistantText,
            baseline,
          });
          if (result.status === 'PAUSED') {
            throw new Error(result.message);
          }
          if (resumeLoop) await orchestrator.start();
        } catch (error) {
          notifier.notify({
            project: config.projectId,
            taskId: null,
            phase: 'GOVERNANCE_RECONCILIATION',
            suggestion: '治理一致性检查未完成，请查看状态面板后重试。',
            error,
            level: 'NEEDS_USER',
          });
          throw error;
        }
      },
      openEdge: async () => {
        await ensureEdge();
      },
      openProject: async () => {
        await shell.openPath(config.localPath);
      },
      viewReport: async (reportPath) => {
        if (reportPath !== null) await shell.openPath(join(config.localPath, reportPath));
      },
    },
  });
  await orchestrator.initialize();
  let timer: NodeJS.Timeout | null = null;
  const startPolling = (): void => {
    if (timer !== null) return;
    timer = setInterval(() => {
      void orchestrator.runRound();
    }, 2_000);
    void orchestrator.runRound();
  };
  const stop = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    profile.close();
  };
  return { orchestrator, startPolling, stop };
}

function hashObservedText(value: string): string | null {
  return value === '' ? null : createHash('sha256').update(value, 'utf8').digest('hex');
}
