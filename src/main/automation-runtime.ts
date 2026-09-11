import { join } from 'node:path';
import { shell } from 'electron';
import type { ProjectConfig } from '../shared/contracts/project-config.js';
import { sanitizeDashboardSnapshot } from '../shared/contracts/dashboard.js';
import { AtomicJsonFileStore } from './state/persistence.js';
import {
  EdgeProfileManager,
  EdgeStateAdapter,
  HttpCdpTransport,
  CdpConversationController,
  ContextRecoveryManager,
  SolSessionBindingStore,
  type EdgeSolObservation,
  type EdgeProcess,
  type SolConversationIdentity,
} from './edge/index.js';
import { GovernanceChangeApplier } from './governance/change-applier.js';
import { applyGovernanceReconciliation } from './governance/reconciliation-applier.js';
import { GovernanceManifestError, GovernanceManifestStore } from './governance/manifest.js';
import { ArchitectureFreezeDownloader } from './architecture/freeze-downloader.js';
import { GitController } from './git/index.js';
import { CodexRunner } from './codex/index.js';
import { MainOrchestrator, OrchestratorError, type OrchestratorState } from './orchestration/index.js';
import type { NotificationService } from './notify/index.js';
import { SolPromptCompiler } from './sol/prompt-compiler.js';
import { assertFixedGovernanceManifestPath } from './project/config.js';
import { assertWritingBlockTemplatesValid } from './project/writing-block-templates.js';
import { parseWritingBlocks } from '../shared/protocol/writing-block.js';
import { createHash } from 'node:crypto';

const CHATGPT_URL = 'https://chatgpt.com/';
const DEFAULT_EDGE_PORT = 9227;
export const GOVERNANCE_RECONCILIATION_POLL_INTERVAL_MS = 2_000;
export const GOVERNANCE_RECONCILIATION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const GOVERNANCE_RECONCILIATION_MAX_WAIT_MS = 30 * 60 * 1000;

function isGovernanceReconciliationCandidate(observation: EdgeSolObservation): boolean {
  if (observation.status !== 'COMPLETED_CANDIDATE') return false;
  try {
    const parsed = parseWritingBlocks(observation.latestAssistantText);
    return parsed.blocks.length === 1 && parsed.governanceReconciliation !== null;
  } catch {
    return false;
  }
}

function outputKeyForObservation(observation: EdgeSolObservation): string {
  const source = `${observation.projectFingerprint ?? ''}\n${observation.url}\n${observation.latestAssistantHash ?? observation.latestAssistantText}`;
  return createHash('sha256').update(source).digest('hex');
}

export interface ReconciliationOutputWaitOptions {
  before: EdgeSolObservation;
  observe: () => Promise<EdgeSolObservation>;
  assertRuntimeOperationAllowed?: () => void;
  shouldContinue?: () => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export async function waitForReconciliationOutput({
  before,
  observe,
  assertRuntimeOperationAllowed = () => undefined,
  shouldContinue = () => true,
  sleep = (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
}: ReconciliationOutputWaitOptions): Promise<EdgeSolObservation> {
  const beforeHash = before.latestAssistantHash ?? hashObservedText(before.latestAssistantText);
  const startedAt = now();
  let lastProgressAt = startedAt;
  let lastHash = beforeHash;
  let lastStatus = before.status;

  while (true) {
    if (!shouldContinue())
      throw new OrchestratorError('GOVERNANCE_RECONCILIATION_CANCELLED', '治理一致性检查已被用户暂停。');
    await sleep(GOVERNANCE_RECONCILIATION_POLL_INTERVAL_MS);
    assertRuntimeOperationAllowed();
    const current = await observe();
    if (!shouldContinue())
      throw new OrchestratorError('GOVERNANCE_RECONCILIATION_CANCELLED', '治理一致性检查已被用户暂停。');
    if (current.status === 'CONTEXT_LIMIT')
      throw new OrchestratorError('GOVERNANCE_RECONCILIATION_CONTEXT_LIMIT', 'Sol 会话上下文已满。');
    if (current.status === 'AUTH_REQUIRED')
      throw new OrchestratorError('GOVERNANCE_RECONCILIATION_AUTH_REQUIRED', '需要在专用 Edge profile 中完成登录。');
    if (current.status === 'NETWORK_ERROR' || current.status === 'SESSION_LOST') {
      throw new OrchestratorError(
        `GOVERNANCE_RECONCILIATION_${current.status}`,
        current.status === 'NETWORK_ERROR' ? '读取 Sol 回复时发生网络错误。' : 'Sol 会话已丢失。',
      );
    }

    const currentHash = current.latestAssistantHash ?? hashObservedText(current.latestAssistantText);
    const currentTime = now();
    if (currentHash !== lastHash || current.status !== lastStatus) {
      lastProgressAt = currentTime;
      lastHash = currentHash;
      lastStatus = current.status;
    }
    if (current.status === 'COMPLETED_CANDIDATE' && currentHash !== null && currentHash !== beforeHash) return current;

    const exceededMaxWait = currentTime - startedAt >= GOVERNANCE_RECONCILIATION_MAX_WAIT_MS;
    const exceededIdleWait =
      !current.isThinking && currentTime - lastProgressAt >= GOVERNANCE_RECONCILIATION_IDLE_TIMEOUT_MS;
    if (exceededMaxWait || exceededIdleWait) {
      throw new OrchestratorError(
        'GOVERNANCE_RECONCILIATION_TIMEOUT',
        exceededMaxWait
          ? '等待 Sol 回复超过 30 分钟，尚未获得新的稳定输出。'
          : 'Sol 已停止思考且连续 10 分钟没有新的输出，请检查会话后重试。',
      );
    }
  }
}

function validateOrchestratorState(value: unknown): OrchestratorState {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Invalid orchestrator state');
  const state = value as OrchestratorState;
  if (state.version !== 1 || typeof state.revision !== 'number' || typeof state.phase !== 'string') {
    throw new TypeError('Invalid orchestrator state');
  }
  // Older snapshots predate Loop Graph; malformed graph input is downgraded at
  // the persistence boundary so a corrupted visual projection cannot revive work.
  return {
    ...state,
    loopGraph: sanitizeDashboardSnapshot({ loopGraph: state.loopGraph }).loopGraph,
  };
}

export interface AutomationRuntime {
  orchestrator: MainOrchestrator;
  startPolling(): void;
  executeCommand(
    command: Parameters<MainOrchestrator['executeCommand']>[0],
  ): ReturnType<MainOrchestrator['executeCommand']>;
  stop(): Promise<void>;
}

export interface RuntimeLifecycleControllerOptions {
  runRound: () => Promise<unknown>;
  isActive: () => boolean;
  isBusy: () => boolean;
  pause: () => Promise<unknown>;
  close: () => void | Promise<void>;
  intervalMs?: number;
  drainTimeoutMs?: number;
}

export interface RuntimeLifecycleController {
  startPolling(): void;
  track<T>(operation: () => Promise<T>): Promise<T>;
  withRoundExclusion<T>(operation: () => Promise<T>): Promise<T>;
  stop(): Promise<void>;
}

export function createSingleFlightEnsure<T>(
  start: () => Promise<T>,
  isBlocked: () => boolean,
  blockedError: () => Error = () => runtimeLifecycleError('RUNTIME_STOPPING', 'Runtime is stopping.'),
): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return async () => {
    if (isBlocked()) throw blockedError();
    if (inFlight !== null) return inFlight;
    const operation = start();
    inFlight = operation;
    try {
      return await operation;
    } finally {
      if (inFlight === operation) inFlight = null;
    }
  };
}

/**
 * Owns the runtime's polling and externally-triggered operations. A stop is a
 * drain barrier: it blocks new rounds, drains every in-flight round and
 * dashboard operation, pauses the orchestrator, and only then closes Edge.
 */
export function createRuntimeLifecycleController(
  options: RuntimeLifecycleControllerOptions,
): RuntimeLifecycleController {
  const operations = new Set<Promise<unknown>>();
  const rounds = new Set<Promise<unknown>>();
  const intervalMs = options.intervalMs ?? 2_000;
  const drainTimeoutMs = options.drainTimeoutMs ?? 10_000;
  let timer: NodeJS.Timeout | null = null;
  let stopping = false;
  let roundExclusions = 0;
  let stopPromise: Promise<void> | null = null;

  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    const promise = Promise.resolve().then(operation);
    operations.add(promise);
    void promise.then(
      () => operations.delete(promise),
      () => operations.delete(promise),
    );
    return promise;
  };

  const runRound = (): void => {
    if (stopping || roundExclusions > 0) return;
    const operation = track(options.runRound);
    rounds.add(operation);
    void operation.then(
      () => rounds.delete(operation),
      () => rounds.delete(operation),
    );
  };

  const startPolling = (): void => {
    if (stopping || timer !== null) return;
    timer = setInterval(runRound, intervalMs);
    runRound();
  };

  const waitForRounds = async (): Promise<void> => {
    while (rounds.size > 0) await Promise.allSettled([...rounds]);
  };

  const withRoundExclusion = async <T>(operation: () => Promise<T>): Promise<T> => {
    roundExclusions += 1;
    try {
      await waitForRounds();
      return await operation();
    } finally {
      roundExclusions -= 1;
    }
  };

  const waitForDrain = async (): Promise<void> => {
    // Let a command such as retry-current-stage publish its internal promise
    // before the busy check below. The command intentionally returns early.
    await Promise.resolve();
    const deadline = Date.now() + drainTimeoutMs;
    while (operations.size > 0 || options.isBusy()) {
      const inFlight = [...operations];
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw runtimeLifecycleError('RUNTIME_DRAIN_TIMEOUT', 'Runtime operations did not stop in time.');
      if (inFlight.length > 0) {
        await Promise.race([
          Promise.allSettled(inFlight),
          new Promise<void>((resolveDelay) => setTimeout(resolveDelay, remaining)),
        ]);
      }
      if (operations.size > 0 || options.isBusy())
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, Math.min(10, Math.max(1, remaining))));
    }
  };

  const stop = (): Promise<void> => {
    if (stopPromise !== null) return stopPromise;
    stopping = true;
    if (timer !== null) clearInterval(timer);
    timer = null;
    stopPromise = (async () => {
      const errors: unknown[] = [];
      try {
        await waitForDrain();
      } catch (error) {
        errors.push(error);
      }
      if (options.isActive() || options.isBusy()) {
        try {
          await options.pause();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await options.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Runtime did not stop cleanly.');
    })();
    return stopPromise;
  };

  return { startPolling, track, withRoundExclusion, stop };
}

function runtimeLifecycleError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export class GovernanceReconciliationPreflightError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(manifestPath: string, cause: GovernanceManifestError) {
    super(`治理 manifest ${manifestPath} 无法安全读取或解析，已停止发送治理一致性 prompt。`, { cause });
    this.name = 'GovernanceReconciliationPreflightError';
    this.code = cause.code;
    this.details =
      typeof cause === 'object' && cause !== null && 'details' in cause
        ? (cause as { details?: unknown }).details
        : { manifestPath };
  }
}

export async function validateGovernanceReconciliationTemplatesForRuntime(
  manifestStore: Pick<GovernanceManifestStore, 'load'>,
  project: ProjectConfig,
): Promise<void> {
  let manifest;
  try {
    manifest = await manifestStore.load();
  } catch (error) {
    if (error instanceof GovernanceManifestError) {
      throw new GovernanceReconciliationPreflightError(project.governanceManifestPath, error);
    }
    throw error;
  }
  if (manifest === null) {
    throw new GovernanceReconciliationPreflightError(
      project.governanceManifestPath,
      new GovernanceManifestError(
        'MANIFEST_NOT_FOUND',
        `治理 manifest ${project.governanceManifestPath} 不存在，已停止发送治理一致性 prompt。`,
      ),
    );
  }
  await assertWritingBlockTemplatesValid(project.localPath, manifest, project.governanceManifestPath);
}

export async function runGovernanceReconciliationAfterTemplatePreflight<T>(
  preflight: () => Promise<void>,
  operation: () => Promise<T>,
): Promise<T> {
  await preflight();
  return operation();
}

export async function compileGovernanceReconciliationPromptForRuntime(
  promptCompiler: Pick<SolPromptCompiler, 'compileGovernanceReconciliationPrompt'>,
  manifestStore: Pick<GovernanceManifestStore, 'load'>,
  project: ProjectConfig,
  baselineCommit: string,
): Promise<string> {
  await validateGovernanceReconciliationTemplatesForRuntime(manifestStore, project);
  return promptCompiler.compileGovernanceReconciliationPrompt({ project, baselineCommit });
}

export async function createAutomationRuntime(
  config: ProjectConfig,
  userDataDirectory: string,
  notifier: NotificationService,
): Promise<AutomationRuntime> {
  assertFixedGovernanceManifestPath(config.localPath, config.governanceManifestPath);
  const stateDirectory = join(userDataDirectory, 'state');
  let stopRequested = false;
  const profile = new EdgeProfileManager({
    userDataDirectory: join(userDataDirectory, 'edge-profile'),
    remoteDebuggingPort: DEFAULT_EDGE_PORT,
    initialUrl: CHATGPT_URL,
    onProcessExit: () =>
      stopRequested
        ? undefined
        : notifier.notify({
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
  let edgeProcess: EdgeProcess | null = null;
  const bindingStore = new SolSessionBindingStore({
    filePath: join(stateDirectory, `${config.projectId}-sol-session.json`),
  });

  const closeEdge = async (): Promise<void> => {
    const process = edgeProcess;
    edgeProcess = null;
    transport?.close();
    transport = null;
    adapter = null;
    conversations = null;
    let closeError: unknown = null;
    try {
      profile.close();
    } catch (error) {
      closeError = error;
    }
    let waitError: unknown = null;
    try {
      if (process !== null && process.exitCode === null) await waitForEdgeProcessExit(process, 10_000);
    } catch (error) {
      waitError = error;
    }
    if (closeError !== null && waitError !== null)
      throw new AggregateError([closeError, waitError], 'Edge close failed.');
    if (closeError !== null) throw closeError;
    if (waitError !== null) throw waitError;
  };

  const startEdge = async (): Promise<void> => {
    const handle = await profile.startOrReuse();
    edgeProcess = handle.process;
    profile.assertUsable();
    if (stopRequested) {
      await closeEdge();
      throw runtimeLifecycleError('RUNTIME_STOPPING', '自动化运行时正在停止，请稍候。');
    }
    const nextTransport = new HttpCdpTransport({ port: handle.remoteDebuggingPort });
    transport = nextTransport;
    adapter = new EdgeStateAdapter(nextTransport);
    conversations = new CdpConversationController({ transport: nextTransport, adapter });
  };
  const ensureEdgeStart = createSingleFlightEnsure(
    startEdge,
    () => stopRequested,
    () => runtimeLifecycleError('RUNTIME_STOPPING', '自动化运行时正在停止，请稍候.'),
  );
  const ensureEdge = async (): Promise<void> => {
    if (stopRequested) throw runtimeLifecycleError('RUNTIME_STOPPING', '自动化运行时正在停止，请稍候。');
    if (transport !== null && adapter !== null && conversations !== null) {
      profile.assertUsable();
      return;
    }
    await ensureEdgeStart();
  };
  const assertRuntimeOperationAllowed = (): void => {
    if (stopRequested) throw runtimeLifecycleError('RUNTIME_STOPPING', '自动化运行时正在停止，请稍候。');
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
      assertRuntimeOperationAllowed();
      await ensureEdge();
      if (conversations === null) throw new Error('Edge conversation controller is unavailable.');
      return conversations.createConversation(input);
    },
    sendMessage: async (input: Parameters<CdpConversationController['sendMessage']>[0]) => {
      assertRuntimeOperationAllowed();
      await ensureEdge();
      if (conversations === null) throw new Error('Edge conversation controller is unavailable.');
      return conversations.sendMessage(input);
    },
  };
  const sol = {
    sendMessage: async (input: { text: string; observation: EdgeSolObservation }): Promise<void> => {
      assertRuntimeOperationAllowed();
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
      assertRuntimeOperationAllowed();
      await conversations.sendMessage({ conversation: identity, text: input.text });
      assertRuntimeOperationAllowed();
      await bindingStore.recordRawInput(input.text);
    },
  };

  const rebind = async (): Promise<void> => {
    assertRuntimeOperationAllowed();
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
        assertRuntimeOperationAllowed();
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
    defaultReasoningEffort: 'medium',
    sessionStorePath: join(stateDirectory, `${config.projectId}-codex-sessions.json`),
    streamLogDirectory: join(userDataDirectory, 'streams', config.projectId),
  });
  const guardedGit = {
    captureBaseline: (...args: Parameters<GitController['captureBaseline']>) => {
      assertRuntimeOperationAllowed();
      return git.captureBaseline(...args);
    },
    readRepositoryStatus: (...args: Parameters<GitController['readRepositoryStatus']>) => {
      assertRuntimeOperationAllowed();
      return git.readRepositoryStatus(...args);
    },
    commitAndPushProject: (...args: Parameters<GitController['commitAndPushProject']>) => {
      assertRuntimeOperationAllowed();
      return git.commitAndPushProject(...args);
    },
    syncGovernance: (...args: Parameters<GitController['syncGovernance']>) => {
      assertRuntimeOperationAllowed();
      return git.syncGovernance(...args);
    },
    syncCode: (...args: Parameters<GitController['syncCode']>) => {
      assertRuntimeOperationAllowed();
      return git.syncCode(...args);
    },
  };
  const guardedGovernance = {
    applyAll: async (...args: Parameters<GovernanceChangeApplier['applyAll']>) => {
      assertRuntimeOperationAllowed();
      return governance.applyAll(...args);
    },
  };
  const guardedArchitecture = {
    download: async (...args: Parameters<ArchitectureFreezeDownloader['download']>) => {
      assertRuntimeOperationAllowed();
      return architecture.download(...args);
    },
  };
  const guardedCodex = {
    startTask: async (...args: Parameters<CodexRunner['startTask']>) => {
      assertRuntimeOperationAllowed();
      return codex.startTask(...args);
    },
  };
  const guardedNotifier = {
    notify: (input: Parameters<NotificationService['notify']>[0]): void => {
      if (!stopRequested) notifier.notify(input);
    },
  };
  const stateStore = new AtomicJsonFileStore<OrchestratorState>(
    join(stateDirectory, `${config.projectId}-orchestrator.json`),
    { validate: validateOrchestratorState },
  );
  const promptCompiler = new SolPromptCompiler();
  let lifecycle: RuntimeLifecycleController;
  let orchestrator: MainOrchestrator;
  orchestrator = new MainOrchestrator({
    project: {
      projectId: config.projectId,
      name: config.projectId,
      localPath: config.localPath,
      remoteUrl: config.remoteUrl,
    },
    edge,
    sol,
    contextRecovery: new ContextRecoveryManager({ bindingStore, conversations: conversationPort }),
    git: guardedGit,
    governance: guardedGovernance,
    reconciliation: {
      apply: (block) => applyGovernanceReconciliation(config.localPath, block),
    },
    architecture: guardedArchitecture,
    codex: guardedCodex,
    stateStore,
    targetBranch: config.targetBranch,
    expectedRemoteUrl: config.remoteUrl,
    notifier: guardedNotifier,
    callbacks: {
      rebind,
      governanceConsistencyCheck: (): Promise<void> =>
        orchestrator.runDashboardOperation(async () => {
          try {
            // This preflight must remain before state changes and all external
            // observations: invalid governance input must not touch Edge, Git,
            // or the pause/resume loop.
            await runGovernanceReconciliationAfterTemplatePreflight(
              () => validateGovernanceReconciliationTemplatesForRuntime(manifestStore, config),
              () =>
                lifecycle.withRoundExclusion(async () => {
                  assertRuntimeOperationAllowed();
                  const resumeLoop = orchestrator.getState().active;
                  if (resumeLoop) await orchestrator.pause();
                  assertRuntimeOperationAllowed();
                  const before = await edge.observe();
                  assertRuntimeOperationAllowed();
                  const baseline = await guardedGit.captureBaseline(config.localPath, {
                    ...(config.targetBranch === 'HEAD' ? {} : { expectedBranch: config.targetBranch }),
                    ...(config.remoteUrl === null ? {} : { expectedRemoteUrl: config.remoteUrl }),
                  });
                  if (isGovernanceReconciliationCandidate(before)) {
                    assertRuntimeOperationAllowed();
                    const result = await orchestrator.runGovernanceReconciliation({
                      solOutput: before.latestAssistantText,
                      baseline,
                      outputKey: outputKeyForObservation(before),
                    });
                    if (result.status === 'PAUSED') throw new Error(result.message);
                    if (resumeLoop && !stopRequested) await orchestrator.start();
                    return;
                  }
                  const prompt = promptCompiler.compileGovernanceReconciliationPrompt({
                    project: config,
                    baselineCommit: baseline.head,
                  });
                  assertRuntimeOperationAllowed();
                  await orchestrator.beginGovernanceReconciliationWait();
                  await sol.sendMessage({ text: prompt, observation: before });
                  const completed = await waitForReconciliationOutput({
                    before,
                    observe: () => edge.observe(),
                    assertRuntimeOperationAllowed,
                    shouldContinue: () => orchestrator.getState().active,
                  });
                  assertRuntimeOperationAllowed();
                  const result = await orchestrator.runGovernanceReconciliation({
                    solOutput: completed.latestAssistantText,
                    baseline,
                    outputKey: outputKeyForObservation(completed),
                  });
                  if (result.status === 'PAUSED') {
                    throw new Error(result.message);
                  }
                  if (resumeLoop && !stopRequested && orchestrator.getState().active) await orchestrator.start();
                }),
            );
          } catch (error) {
            if (error instanceof OrchestratorError && error.code === 'GOVERNANCE_RECONCILIATION_CANCELLED') {
              await orchestrator.pause();
              return;
            }
            await orchestrator.pauseGovernanceReconciliation(error);
            guardedNotifier.notify({
              project: config.projectId,
              taskId: null,
              phase: 'GOVERNANCE_RECONCILIATION',
              suggestion: '治理一致性检查未完成，请查看状态面板后重试。',
              error,
              level: 'NEEDS_USER',
            });
            throw error;
          }
        }),
      openEdge: async () => {
        assertRuntimeOperationAllowed();
        await ensureEdge();
      },
      openProject: async () => {
        assertRuntimeOperationAllowed();
        await shell.openPath(config.localPath);
      },
      viewReport: async (reportPath) => {
        assertRuntimeOperationAllowed();
        if (reportPath !== null) await shell.openPath(join(config.localPath, reportPath));
      },
    },
  });
  await orchestrator.initialize();
  lifecycle = createRuntimeLifecycleController({
    runRound: () => orchestrator.runRound(),
    isActive: () => orchestrator.getState().active,
    isBusy: () => Object.values(orchestrator.getDashboardSnapshot().actions).some((action) => action.busy),
    pause: () => orchestrator.pause(),
    close: closeEdge,
  });
  const executeCommand: AutomationRuntime['executeCommand'] = (command) => {
    if (stopRequested)
      return Promise.resolve({
        accepted: false,
        code: 'RUNTIME_STOPPING',
        message: '自动化运行时正在停止，请稍候。',
      });
    return lifecycle.track(async () => {
      if (stopRequested)
        return {
          accepted: false,
          code: 'RUNTIME_STOPPING',
          message: '自动化运行时正在停止，请稍候。',
        };
      return orchestrator.executeCommand(command);
    });
  };
  const stop = (): Promise<void> => {
    stopRequested = true;
    return lifecycle.stop();
  };
  return { orchestrator, executeCommand, startPolling: lifecycle.startPolling, stop };
}

function waitForEdgeProcessExit(process: EdgeProcess, timeoutMs: number): Promise<void> {
  if (process.exitCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timer = null;
      reject(runtimeLifecycleError('EDGE_CLOSE_TIMEOUT', '专用 Edge 进程未能在限定时间内退出。'));
    }, timeoutMs);
    const finish = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      resolve();
    };
    const fail = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      reject(runtimeLifecycleError('EDGE_CLOSE_ERROR', '专用 Edge 进程报告关闭错误。'));
    };
    process.once('exit', finish);
    process.once('error', fail);
    if (process.exitCode !== null) finish();
  });
}

function hashObservedText(value: string): string | null {
  return value === '' ? null : createHash('sha256').update(value, 'utf8').digest('hex');
}
