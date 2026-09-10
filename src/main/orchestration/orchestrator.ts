import { createHash } from 'node:crypto';
import {
  LOOP_GRAPH_NODE_DEFINITIONS,
  sanitizeDashboardSnapshot,
  validateDashboardCommand,
  type DashboardCommand,
  type DashboardCommandResult,
  type DashboardActions,
  type DashboardSnapshot,
  type LoopGraphNodeId,
  type LoopGraphNodeSnapshot,
  type LoopGraphNodeState,
  type LoopGraphSnapshot,
} from '../../shared/contracts/dashboard.js';
import { sanitizeSafeText } from '../../shared/contracts/safe-text.js';
import {
  parseWritingBlocks,
  type GovernanceReconciliationBlock,
  type LunaTaskBlock,
} from '../../shared/protocol/writing-block.js';
import { resolve } from 'node:path';
import type { EdgeSolObservation } from '../edge/types.js';
import type { CodexRunResult } from '../codex/types.js';
import {
  type ArchitectureOrchestratorPort,
  type ContextRecoverySource,
  type EdgeObservationSource,
  type GitOrchestratorPort,
  type GovernanceOrchestratorPort,
  type GovernanceReconciliationRunInput,
  type GovernanceReconciliationRunResult,
  type Orchestrator,
  type OrchestratorOptions,
  type OrchestratorProject,
  type OrchestratorResult,
  type OrchestratorSnapshots,
  type OrchestratorState,
  type OrchestratorStateStore,
  type PendingCodeSyncState,
  type SolMessageSource,
} from './types.js';

const DEFAULT_STATE: OrchestratorState = {
  version: 1,
  revision: 0,
  updatedAt: new Date(0).toISOString(),
  active: false,
  status: 'IDLE',
  phase: 'IDLE',
  taskId: null,
  processedOutputKey: null,
  lastContextRecoveryEventId: null,
  governanceRevision: null,
  architectureRevisions: [],
  luna: { status: 'NOT_STARTED', sessionId: null },
  commits: { local: null, remote: null },
  recentError: null,
  loopGraph: createLoopGraph(null, new Date(0).toISOString()),
  pendingCodeSync: null,
  activeSolSession: null,
};

export class OrchestratorError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OrchestratorError';
    this.code = code;
  }
}

type PendingCodeSync = PendingCodeSyncState;

export class MainOrchestrator implements Orchestrator {
  private readonly project: OrchestratorProject;
  private readonly edge: EdgeObservationSource;
  private readonly git: GitOrchestratorPort;
  private readonly codex: OrchestratorOptions['codex'];
  private readonly governance: GovernanceOrchestratorPort | undefined;
  private readonly reconciliation: OrchestratorOptions['reconciliation'];
  private readonly architecture: ArchitectureOrchestratorPort | undefined;
  private readonly sol: SolMessageSource | undefined;
  private readonly contextRecovery: ContextRecoverySource | undefined;
  private readonly snapshots: OrchestratorOptions['snapshots'];
  private readonly notifier: OrchestratorOptions['notifier'];
  private readonly callbacks: NonNullable<OrchestratorOptions['callbacks']>;
  private readonly stateStore: OrchestratorStateStore | undefined;
  private readonly targetBranch: string | undefined;
  private readonly expectedRemoteUrl: string | null | undefined;
  private readonly model: string | undefined;
  private readonly executablePath: string | undefined;
  private readonly baselineOutputHash: string | null | undefined;
  private readonly now: () => Date;
  private state: OrchestratorState = cloneState(DEFAULT_STATE);
  private baseline: Awaited<ReturnType<GitOrchestratorPort['captureBaseline']>> | null = null;
  private pendingCodeSync: PendingCodeSync | null = null;
  private loadPromise: Promise<void> | null = null;
  private initialized = false;
  private roundPromise: Promise<OrchestratorResult> | null = null;
  private reconciliationPromise: Promise<GovernanceReconciliationRunResult> | null = null;
  private dashboardOperationPromise: Promise<void> | null = null;
  private readonly dashboardNavigationPromises = new Map<'open-edge' | 'open-project', Promise<void>>();

  constructor(options: OrchestratorOptions) {
    this.project = options.project;
    this.edge = options.edge;
    this.git = options.git;
    this.codex = options.codex;
    this.governance = options.governance;
    this.reconciliation = options.reconciliation;
    this.architecture = options.architecture;
    this.sol = options.sol;
    this.contextRecovery = options.contextRecovery;
    this.snapshots = options.snapshots;
    this.notifier = options.notifier;
    this.callbacks = options.callbacks ?? {};
    this.stateStore = options.stateStore;
    this.targetBranch = options.targetBranch;
    this.expectedRemoteUrl = options.expectedRemoteUrl;
    this.model = options.model;
    this.executablePath = options.executablePath;
    this.baselineOutputHash = options.baselineOutputHash;
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.loadPromise !== null) return this.loadPromise;
    this.loadPromise = (async () => {
      const stored = await this.stateStore?.load();
      if (stored !== null && stored !== undefined && stored.version === 1) this.state = normalizeState(stored);
      this.pendingCodeSync = clonePendingCodeSync(this.state.pendingCodeSync);
      const interrupted = this.state.active || this.state.status === 'RUNNING';
      this.state.active = false;
      if (interrupted) {
        this.state.status = 'PAUSED';
        this.state.phase = 'PAUSED';
        this.pauseActiveGraphNode('应用重启后未恢复正在执行的进程。');
      }
      await this.persist();
      this.initialized = true;
    })();
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  getState(): OrchestratorState {
    return cloneState(this.state);
  }

  getDashboardSnapshot(): DashboardSnapshot {
    return sanitizeDashboardSnapshot({
      revision: this.state.revision,
      updatedAt: this.state.updatedAt,
      project: {
        projectId: this.project.projectId,
        name: this.project.name,
        localPath: this.project.localPath,
        remoteUrl: this.project.remoteUrl ?? null,
      },
      activeSolSession: this.state.activeSolSession,
      stage: this.state.phase,
      status: this.state.status,
      taskId: this.state.taskId,
      governanceRevision: this.state.governanceRevision,
      architectureRevisions: this.state.architectureRevisions,
      luna: this.state.luna,
      commits: this.state.commits,
      recentError: this.state.recentError,
      loopGraph: this.state.loopGraph,
      actions: this.dashboardActions(),
    });
  }

  private dashboardActions(): DashboardActions {
    const roundBusy = this.roundPromise !== null;
    const reconciliationBusy = this.reconciliationPromise !== null;
    const operationBusy = roundBusy || reconciliationBusy || this.dashboardOperationPromise !== null;
    const hasRecoverableError = this.pendingCodeSync !== null || isRetryableDashboardError(this.state.recentError);
    const blockedBySol = dashboardNeedsNewSol(this.state.recentError);
    const callbackAvailable = (
      name: 'rebind' | 'governanceConsistencyCheck' | 'openEdge' | 'openProject' | 'viewReport',
    ) => this.callbacks[name] !== undefined;
    const disabled = (reason: string, busy = false) => ({ enabled: false, busy, reason });
    const enabled = () => ({ enabled: true, busy: false, reason: null });

    return {
      start:
        operationBusy || this.state.status === 'RUNNING'
          ? disabled('已有编排操作正在处理中。', operationBusy)
          : blockedBySol
            ? disabled('当前输出不可重试，请让 Sol 重新输出或规划任务（需要新的 Sol 输出）。')
            : this.state.status === 'NEEDS_USER_ACTION'
              ? disabled('请先完成用户操作后再启动。')
              : enabled(),
      pause: reconciliationBusy
        ? disabled('治理一致性检查正在处理中。', true)
        : this.state.status === 'RUNNING' && this.state.active
          ? enabled()
          : disabled('编排器当前未运行。'),
      'retry-current-stage': operationBusy
        ? disabled('已有操作正在处理中。', operationBusy)
        : blockedBySol
          ? disabled('当前输出不可重试，请让 Sol 重新输出或规划任务（需要新的 Sol 输出）。')
          : hasRecoverableError
            ? enabled()
            : disabled('当前没有可重试的阶段错误。'),
      rebind: operationBusy
        ? disabled('已有操作正在处理中。', operationBusy)
        : callbackAvailable('rebind')
          ? enabled()
          : disabled('重新绑定回调不可用。'),
      'governance-consistency-check': operationBusy
        ? disabled('已有操作正在处理中。', operationBusy)
        : callbackAvailable('governanceConsistencyCheck')
          ? enabled()
          : disabled('治理一致性检查回调不可用。'),
      'open-edge': this.dashboardNavigationPromises.has('open-edge')
        ? disabled('打开 Edge 操作正在处理中。', true)
        : callbackAvailable('openEdge')
          ? enabled()
          : disabled('打开 Edge 回调不可用。'),
      'open-project': this.dashboardNavigationPromises.has('open-project')
        ? disabled('打开项目操作正在处理中。', true)
        : callbackAvailable('openProject')
          ? enabled()
          : disabled('打开项目回调不可用。'),
      'view-report':
        this.state.taskId !== null && callbackAvailable('viewReport')
          ? enabled()
          : disabled(callbackAvailable('viewReport') ? '当前没有可查看的任务报告。' : '查看报告回调不可用.'),
    };
  }

  async start(): Promise<OrchestratorResult> {
    await this.initialize();
    if (this.pendingCodeSync !== null) {
      this.state.active = true;
      this.state.status = 'RUNNING';
      this.state.phase = 'SYNCING_CODE';
      this.state.taskId = this.pendingCodeSync.taskId;
      this.activateGraphNode('sync-code', this.pendingCodeSync.taskId);
      this.state.recentError = null;
      this.touchState();
      await this.persist();
      return result('WAITING', this.state, '已恢复代码同步，等待继续执行。');
    }
    if (dashboardNeedsNewSol(this.state.recentError))
      return result('PAUSED', this.state, '当前输出不可重试，请让 Sol 重新输出或规划任务（需要新的 Sol 输出）。');
    this.state.active = true;
    this.state.status = 'RUNNING';
    this.state.phase =
      this.state.phase === 'IDLE' || this.state.phase === 'PAUSED' || this.state.phase === 'FAILED'
        ? 'WAITING_FOR_SOL'
        : this.state.phase;
    if (this.state.phase === 'WAITING_FOR_SOL') this.resumeWaitingGraph();
    this.state.recentError = null;
    this.touchState();
    await this.persist();
    return result('WAITING', this.state, '编排器已启动，等待 Sol 完成输出。');
  }

  async pause(): Promise<OrchestratorResult> {
    await this.initialize();
    this.state.active = false;
    this.state.status = 'PAUSED';
    this.state.phase = 'PAUSED';
    this.pauseActiveGraphNode('用户已暂停编排。');
    this.touchState();
    await this.persist();
    return result('PAUSED', this.state, '编排器已暂停。');
  }

  async retryCurrentStage(): Promise<OrchestratorResult> {
    await this.initialize();
    this.state.active = true;
    this.state.status = 'RUNNING';
    if (this.pendingCodeSync !== null) {
      this.state.phase = 'SYNCING_CODE';
      this.state.taskId = this.pendingCodeSync.taskId;
      this.activateGraphNode('sync-code', this.pendingCodeSync.taskId);
    } else if (this.state.phase === 'PAUSED' || this.state.phase === 'FAILED') this.state.phase = 'WAITING_FOR_SOL';
    if (this.state.phase === 'WAITING_FOR_SOL') this.resumeWaitingGraph();
    this.state.recentError = null;
    this.touchState();
    await this.persist();
    return this.runRound();
  }

  async runRound(): Promise<OrchestratorResult> {
    await this.initialize();
    if (this.roundPromise !== null) return this.roundPromise;
    this.roundPromise = this.processRound().catch((error) =>
      this.isTerminalFailure(error) ? this.failFor(error) : this.pauseFor(error, '当前阶段执行失败，已暂停。'),
    );
    try {
      return await this.roundPromise;
    } finally {
      this.roundPromise = null;
    }
  }

  async runGovernanceReconciliation(
    input: GovernanceReconciliationRunInput,
  ): Promise<GovernanceReconciliationRunResult> {
    await this.initialize();
    if (this.reconciliationPromise !== null) return this.reconciliationPromise;
    this.reconciliationPromise = (async () => {
      // A dashboard request can arrive while the polling timer has already
      // entered a round. Let that round finish before touching governance.
      if (this.roundPromise !== null) await this.roundPromise;
      return this.processGovernanceReconciliation(input);
    })().catch(async (error) => {
      const paused = await this.pauseFor(error, '治理一致性检查已暂停，请检查协议、基线和文件状态后重试。');
      return reconciliationResult('PAUSED', null, paused, null, [], [], null, null);
    });
    try {
      return await this.reconciliationPromise;
    } finally {
      this.reconciliationPromise = null;
    }
  }

  async executeCommand(command: DashboardCommand): Promise<DashboardCommandResult> {
    try {
      const validated = validateDashboardCommand(command);
      const action = this.dashboardActions()[validated.command];
      if (action.busy) return rejected('DASHBOARD_ACTION_BUSY', '该动作正在处理中，请稍候。');
      if (!action.enabled) return rejected('DASHBOARD_ACTION_UNAVAILABLE', action.reason ?? '该动作当前不可用。');
      switch (validated.command) {
        case 'start':
          await this.start();
          return accepted('OK', '编排器已启动。');
        case 'pause':
          await this.pause();
          return accepted('OK', '编排器已暂停。');
        case 'retry-current-stage':
          void this.retryCurrentStage().catch(() => undefined);
          return accepted('RETRY_ACCEPTED', '已接受当前阶段重试。');
        case 'rebind':
          return await this.invokeCallback('rebind', '重新绑定回调不可用。');
        case 'governance-consistency-check':
          return await this.invokeCallback('governanceConsistencyCheck', '治理一致性检查回调不可用。');
        case 'open-edge':
          return await this.invokeCallback('openEdge', '打开 Edge 回调不可用。');
        case 'open-project':
          return await this.invokeCallback('openProject', '打开项目回调不可用。');
        case 'view-report':
          if (this.callbacks.viewReport === undefined)
            return rejected('VIEW_REPORT_UNAVAILABLE', '查看报告回调不可用。');
          await this.callbacks.viewReport(validated.reportPath ?? this.reportPath());
          return accepted('OK', '已请求打开任务报告。');
      }
    } catch (error) {
      return rejected('DASHBOARD_COMMAND_FAILED', error instanceof Error ? error.message : '命令执行失败。');
    }
  }

  async runDashboardOperation(operation: () => Promise<void>): Promise<void> {
    if (this.dashboardOperationPromise !== null)
      throw new OrchestratorError('DASHBOARD_ACTION_BUSY', '该动作正在处理中，请稍候。');
    let tracked!: Promise<void>;
    tracked = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (this.dashboardOperationPromise === tracked) this.dashboardOperationPromise = null;
      });
    this.dashboardOperationPromise = tracked;
    return tracked;
  }

  private async processGovernanceReconciliation(
    input: GovernanceReconciliationRunInput,
  ): Promise<GovernanceReconciliationRunResult> {
    const wasActive = this.state.active;
    const outputKey = reconciliationOutputKey(input.solOutput, input.baseline.head);
    if (this.state.processedOutputKey === outputKey) {
      return reconciliationResult(
        'DUPLICATE',
        null,
        result('DUPLICATE', this.state, '该治理一致性检查输出已经处理过。'),
        null,
        [],
        [],
        this.state.commits.local,
        this.state.commits.remote,
      );
    }

    await this.setPhase('PARSING', 'RUNNING', null);
    const parsed = parseWritingBlocks(input.solOutput);
    if (parsed.blocks.length !== 1 || parsed.governanceReconciliation === null) {
      throw new OrchestratorError(
        'GOVERNANCE_RECONCILIATION_PROTOCOL_INVALID',
        '治理一致性检查必须只包含一个 GOVERNANCE_RECONCILIATION Writing Block。',
      );
    }
    const reconciliation = parsed.governanceReconciliation;
    if (reconciliation.fields.status === 'BLOCKED') {
      const paused = await this.pauseForCode(
        'GOVERNANCE_RECONCILIATION_BLOCKED',
        reconciliation.fields.reason ?? 'Sol 阻塞了治理一致性检查。',
        true,
        '请解决 Sol 报告的治理一致性阻塞项后重新发起检查。',
      );
      return reconciliationResult('PAUSED', 'BLOCKED', paused, null, [], [], null, null);
    }
    if (reconciliation.fields.status === 'PASS') {
      this.state.processedOutputKey = outputKey;
      await this.finishIndependentRound(wasActive);
      return reconciliationResult(
        'PASS',
        'PASS',
        result('NO_TASK', this.state, '治理一致性检查通过，无需修改文件。'),
        null,
        [],
        [],
        null,
        null,
      );
    }

    this.assertReconciliationBaseline(input, reconciliation);
    if (this.reconciliation === undefined) {
      throw new OrchestratorError('GOVERNANCE_RECONCILIATION_UNAVAILABLE', '治理一致性检查应用器不可用。');
    }
    await this.setPhase('APPLYING_UPDATES', 'RUNNING', null);
    const applied = await this.reconciliation.apply(reconciliation);
    await this.setPhase('SYNCING_GOVERNANCE', 'RUNNING', null);
    const sync = await this.git.syncGovernance({
      baseline: input.baseline,
      changeId: `reconciliation-${safeSyncId(applied.runId)}`,
      changedPaths: applied.changedPaths,
    });
    this.state.commits = { local: sync.commit, remote: sync.remoteCommit };
    this.state.processedOutputKey = outputKey;
    this.baseline = {
      ...input.baseline,
      head: sync.commit,
      remoteTip: sync.remoteCommit ?? input.baseline.remoteTip,
      worktree: [],
    };
    await this.finishIndependentRound(wasActive);
    return reconciliationResult(
      'COMPLETED',
      'CHANGES_REQUIRED',
      result('COMPLETED', this.state, '治理一致性修改已应用、提交并同步。'),
      applied.runId,
      applied.changedPaths,
      applied.backupPaths,
      sync.commit,
      sync.remoteCommit,
    );
  }

  private assertReconciliationBaseline(
    input: GovernanceReconciliationRunInput,
    reconciliation: GovernanceReconciliationBlock,
  ): void {
    if (reconciliation.fields.baseline_commit !== input.baseline.head) {
      throw new OrchestratorError(
        'BASELINE_CHANGED',
        '治理一致性检查的 baseline_commit 与调用方提供的 Git 基线不一致。',
      );
    }
    const projectRoot = resolve(this.project.localPath);
    const baselineRoot = resolve(input.baseline.repositoryRoot);
    if (projectRoot.toLowerCase() !== baselineRoot.toLowerCase()) {
      throw new OrchestratorError('BASELINE_CHANGED', '治理一致性检查的 Git 基线不属于当前项目。');
    }
  }

  private async finishIndependentRound(wasActive: boolean): Promise<void> {
    await this.setPhase(wasActive ? 'WAITING_FOR_SOL' : 'IDLE', wasActive ? 'RUNNING' : 'IDLE', null);
  }

  private async processRound(): Promise<OrchestratorResult> {
    if (!this.state.active) return result('IDLE', this.state, '编排器未运行。');
    if (this.pendingCodeSync !== null && this.state.phase === 'SYNCING_CODE') return this.syncPendingCode();

    const waitingForNextOutput = this.state.phase === 'WAITING_FOR_SOL' && this.state.loopGraph.roundId !== null;
    if (!waitingForNextOutput && this.state.loopGraph.roundId === null) await this.beginRound();
    let observation: EdgeSolObservation;
    try {
      observation = await this.edge.observe();
    } catch (error) {
      return this.pauseFor(error, '读取 Sol 状态失败，请稍后重试。');
    }
    if (!this.state.active) return result('PAUSED', this.state, '编排器已暂停。');

    if (waitingForNextOutput) {
      if (observation.status === 'CONTEXT_LIMIT') return this.recoverContext(observation);
      if (observation.status === 'AUTH_REQUIRED')
        return this.pauseForCode('AUTH_REQUIRED', '需要在专用 Edge profile 中完成登录。', true);
      if (observation.status === 'NETWORK_ERROR' || observation.status === 'SESSION_LOST')
        return this.pauseForCode(observation.status, 'Sol 页面或网络尚未恢复，请检查后重试。');
      if (observation.status !== 'COMPLETED_CANDIDATE') {
        const message = '等待 Sol 产生新的稳定输出。';
        await this.enterWaiting(message);
        return result('WAITING', this.state, message);
      }
      if (this.baselineOutputHash !== undefined && observation.latestAssistantHash === this.baselineOutputHash) {
        const message = '已确认绑定时的历史消息，不执行该消息。';
        await this.enterWaiting(message);
        return result('WAITING', this.state, message);
      }
      if (this.state.processedOutputKey === outputKeyFor(observation)) {
        const message = '等待 Sol 产生新的未处理输出。';
        await this.enterWaiting(message);
        return result('WAITING', this.state, message);
      }
      await this.beginRound();
    } else {
      await this.setPhase('READING_SOL', 'RUNNING');
    }

    this.updateGraphNode('read-sol', {
      summary: '已读取 Sol 当前状态。',
      details: compactDetails([
        `状态：${observation.status}`,
        observation.latestAssistantHash === null ? '' : `输出：${observation.latestAssistantHash}`,
        `采样：${observation.sampledAt}`,
      ]),
    });

    if (observation.status === 'CONTEXT_LIMIT') return this.recoverContext(observation);
    if (observation.status === 'AUTH_REQUIRED')
      return this.pauseForCode('AUTH_REQUIRED', '需要在专用 Edge profile 中完成登录。', true);
    if (observation.status === 'NETWORK_ERROR' || observation.status === 'SESSION_LOST')
      return this.pauseForCode(observation.status, 'Sol 页面或网络尚未恢复，请检查后重试。');
    if (observation.status !== 'COMPLETED_CANDIDATE') {
      this.markNodesNotApplicable([
        'parse-task',
        'apply-updates',
        'sync-governance',
        'run-luna',
        'sync-code',
        'notify-sol',
      ]);
      await this.enterWaiting('Sol 尚未产生稳定的可执行完成输出。');
      return result('WAITING', this.state, 'Sol 尚未产生稳定的可执行完成输出。');
    }
    if (
      !waitingForNextOutput &&
      this.baselineOutputHash !== undefined &&
      observation.latestAssistantHash === this.baselineOutputHash
    )
      return this.finishWaiting(observation, '已确认绑定时的历史消息，不执行该消息。');

    const outputKey = outputKeyFor(observation);
    if (!waitingForNextOutput && this.state.processedOutputKey === outputKey) {
      this.markNodesNotApplicable([
        'parse-task',
        'apply-updates',
        'sync-governance',
        'run-luna',
        'sync-code',
        'notify-sol',
      ]);
      await this.enterWaiting('该 Sol 输出已经处理过。');
      return result('DUPLICATE', this.state, '该 Sol 输出已经处理过。');
    }
    if (observation.projectFingerprint === null)
      return this.pauseForCode('SOL_PROJECT_UNKNOWN', '无法确认 Sol 输出属于绑定 Project。');

    let parsed: ReturnType<typeof parseWritingBlocks>;
    try {
      await this.setPhase('PARSING', 'RUNNING');
      parsed = parseWritingBlocks(observation.latestAssistantText);
      this.updateGraphNode('parse-task', {
        summary: `已验证 ${writingBlockCount(parsed)} 个 Writing Block。`,
        details: [
          `Luna 任务：${parsed.lunaTask?.fields.task_id ?? '无'}`,
          `治理变更：${parsed.governanceChanges.length}`,
        ],
      });
    } catch (error) {
      return this.pauseFor(error, 'Writing Block 协议无效，已拒绝启动 Luna。');
    }
    if (parsed.governanceReconciliation !== null) {
      return this.pauseForCode(
        'GOVERNANCE_RECONCILIATION_WRONG_ENTRYPOINT',
        'GOVERNANCE_RECONCILIATION 只能通过治理一致性检查入口处理。',
        true,
        '请使用治理一致性检查按钮重新发起该检查。',
      );
    }
    if (parsed.blocked.length > 0) {
      return this.pauseForCode('SOL_BLOCKED', parsed.blocked.map((block) => block.fields.reason).join('\n'), true);
    }
    if (!this.state.active) return result('PAUSED', this.state, '编排器已暂停。');

    try {
      await this.ensureBaseline();
      this.assertTaskBase(parsed.lunaTask);
      const updated = await this.applyUpdates(parsed.governanceChanges, parsed.architectureFreezes);
      if (!this.state.active) return result('PAUSED', this.state, '编排器已暂停。');
      if (parsed.lunaTask === null) {
        this.state.processedOutputKey = outputKey;
        this.markNodesNotApplicable(['run-luna', 'sync-code', 'notify-sol']);
        await this.setPhase('WAITING_FOR_SOL', 'RUNNING');
        return result(
          'NO_TASK',
          this.state,
          updated ? '治理/架构同步完成，本轮没有 Luna 任务。' : '本轮没有 Luna 任务。',
        );
      }
      return await this.runLuna(parsed.lunaTask, observation, outputKey);
    } catch (error) {
      return this.isTerminalFailure(error)
        ? this.failFor(error)
        : this.pauseFor(error, '当前阶段执行失败，已暂停以等待重试或人工处理。');
    }
  }

  private async ensureBaseline(): Promise<void> {
    if (this.baseline !== null) return;
    this.baseline = await this.git.captureBaseline(this.project.localPath, {
      ...(this.targetBranch === undefined ? {} : { expectedBranch: this.targetBranch }),
      ...(this.expectedRemoteUrl === undefined ? {} : { expectedRemoteUrl: this.expectedRemoteUrl }),
    });
  }

  private assertTaskBase(task: LunaTaskBlock | null): void {
    if (task === null || this.baseline === null) return;
    if (task.fields.base_commit !== this.baseline.head) {
      throw new OrchestratorError(
        'BASELINE_CHANGED',
        'Luna task base_commit does not match the captured repository baseline.',
      );
    }
  }

  private async applyUpdates(
    governanceChanges: Parameters<GovernanceOrchestratorPort['applyAll']>[0],
    freezes: Parameters<ArchitectureOrchestratorPort['download']>[0],
  ): Promise<boolean> {
    if (governanceChanges.length === 0 && freezes.length === 0) {
      this.markNodesNotApplicable(['apply-updates', 'sync-governance']);
      return false;
    }
    await this.setPhase('APPLYING_UPDATES', 'RUNNING');
    const changedPaths: string[] = [];
    const ids: string[] = [];
    if (governanceChanges.length > 0) {
      if (this.governance === undefined)
        throw new OrchestratorError('GOVERNANCE_UNAVAILABLE', '治理变更应用器不可用。');
      const results = await this.governance.applyAll(governanceChanges);
      for (const item of results) {
        changedPaths.push(...item.changedPaths);
        ids.push(item.changeId);
      }
      this.state.governanceRevision = results.at(-1)?.manifestVersion ?? this.state.governanceRevision;
    }
    if (freezes.length > 0) {
      if (this.architecture === undefined)
        throw new OrchestratorError('ARCHITECTURE_UNAVAILABLE', '架构冻结下载器不可用。');
      const result = await this.architecture.download(freezes);
      changedPaths.push(...result.added.map((item) => item.path));
      if (result.added.length > 0) changedPaths.push(result.indexPath);
      ids.push(...freezes.map((freeze) => freeze.fields.freeze_id));
      this.state.architectureRevisions = [
        ...this.state.architectureRevisions,
        ...result.added.map((item) => item.version),
      ];
    }
    const uniquePaths = [...new Set(changedPaths)];
    this.updateGraphNode('apply-updates', {
      summary: `已应用 ${governanceChanges.length} 项治理变更和 ${freezes.length} 项架构更新。`,
      details: compactDetails([...ids, ...uniquePaths]),
    });
    if (uniquePaths.length === 0) {
      this.markNodesNotApplicable(['sync-governance']);
      return false;
    }
    if (this.baseline === null) throw new OrchestratorError('BASELINE_MISSING', '治理同步缺少 Git 基线。');
    await this.setPhase('SYNCING_GOVERNANCE', 'RUNNING');
    const sync = await this.git.syncGovernance({
      baseline: this.baseline,
      changeId: `round-${ids.map(safeSyncId).join('-')}`,
      changedPaths: uniquePaths,
    });
    this.state.commits = { local: sync.commit, remote: sync.remoteCommit };
    this.updateGraphNode('sync-governance', {
      summary: '治理同步完成。',
      details: commitDetails(sync.commit, sync.remoteCommit),
    });
    this.baseline = {
      ...this.baseline,
      head: sync.commit,
      remoteTip: sync.remoteCommit ?? this.baseline.remoteTip,
      worktree: [],
    };
    await this.persist();
    return true;
  }

  private async runLuna(
    task: LunaTaskBlock,
    observation: EdgeSolObservation,
    outputKey: string,
  ): Promise<OrchestratorResult> {
    if (this.baseline === null) throw new OrchestratorError('BASELINE_MISSING', 'Luna 执行缺少 Git 基线。');
    await this.setPhase('RUNNING_LUNA', 'RUNNING', task.fields.task_id);
    this.state.luna = { status: 'RUNNING', sessionId: null };
    const currentSnapshots = await this.readSnapshots(task);
    const handle = await this.codex.startTask({
      task,
      snapshots: currentSnapshots,
      repositoryPath: this.project.localPath,
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(this.executablePath === undefined ? {} : { executablePath: this.executablePath }),
      baselineSnapshot: this.baseline,
      repositorySnapshot: this.baseline,
    });
    this.state.luna = { status: handle.status, sessionId: handle.sessionId };
    this.updateGraphNode('run-luna', {
      summary: `Luna 正在执行任务 ${task.fields.task_id}。`,
      details: [`任务：${task.fields.task_id}`, `会话：${handle.sessionId}`, `报告：${task.fields.report_path}`],
    });
    await this.persist();
    const run = await handle.result;
    if (this.state.active === false) {
      this.setPendingCodeSync(createPendingCodeSync(task, run, this.baseline, outputKey));
      this.touchState();
      await this.persist();
      return result('PAUSED', this.state, 'Luna 已返回，暂停状态阻止继续同步代码。');
    }
    if (run.status !== 'COMPLETED') {
      if (run.protocolResult?.status === 'BLOCKED_EXTERNAL_SETUP') {
        return this.pauseForCode(
          'BLOCKED_EXTERNAL_SETUP',
          run.protocolResult.summary,
          true,
          '请完成外部账号、API Key、OTP 或平台配置后重试。',
        );
      }
      throw new OrchestratorError(run.error?.code ?? run.status, run.error?.message ?? 'Luna 未成功完成任务。');
    }
    this.updateGraphNode('run-luna', {
      summary: `Luna 已完成任务 ${task.fields.task_id}。`,
      details: [`任务：${task.fields.task_id}`, `会话：${run.sessionId}`, `报告：${run.reportPath}`],
    });
    this.setPendingCodeSync(createPendingCodeSync(task, run, this.baseline, outputKey));
    this.touchState();
    await this.persist();
    return this.syncPendingCode(observation);
  }

  private async syncPendingCode(observation?: EdgeSolObservation): Promise<OrchestratorResult> {
    const pending = this.pendingCodeSync;
    if (pending === null) return result('FAILED', this.state, '没有可恢复的代码同步上下文。');
    if (!this.state.active) return result('PAUSED', this.state, '编排器已暂停。');
    this.completeGraphNode('run-luna');
    await this.setPhase('SYNCING_CODE', 'RUNNING', pending.taskId);
    const sync = await this.git.syncCode({
      baseline: pending.baseline,
      taskId: pending.taskId,
      reportPath: pending.reportPath,
      testsPassed: pending.testsPassed,
      allowedPaths: pending.allowedPaths,
      protectedPaths: pending.protectedPaths,
    });
    this.state.commits = { local: sync.commit, remote: sync.remoteCommit };
    this.updateGraphNode('sync-code', {
      summary: `代码同步完成：${sync.commit}。`,
      details: [
        `任务：${pending.taskId}`,
        `报告：${pending.reportPath}`,
        '测试：已通过',
        ...commitDetails(sync.commit, sync.remoteCommit),
      ],
    });
    if (!this.state.active) {
      await this.persist();
      return result('PAUSED', this.state, '代码已同步，但编排器在通知 Sol 前被暂停。');
    }
    await this.setPhase('NOTIFYING_SOL', 'RUNNING', pending.taskId);
    if (this.sol !== undefined) {
      if (observation === undefined) observation = await this.edge.observe();
      await this.sol.sendMessage({
        observation,
        text: `LUNA_RESULT task_id=${pending.taskId}\n最新提交 ${sync.commit} 完成，可以开始验收。`,
      });
      this.updateGraphNode('notify-sol', {
        summary: '已通知 Sol 可以开始验收。',
        details: [`任务：${pending.taskId}`, ...commitDetails(sync.commit, sync.remoteCommit)],
      });
    } else {
      this.markNodesNotApplicable(['notify-sol']);
    }
    this.state.processedOutputKey = pending.outputKey;
    this.state.luna = { status: 'COMPLETED', sessionId: pending.sessionId };
    this.state.pendingCodeSync = null;
    this.pendingCodeSync = null;
    await this.setPhase('WAITING_FOR_SOL', 'RUNNING', null);
    return result('COMPLETED', this.state, `任务 ${pending.taskId} 已完成并同步。`);
  }

  private async readSnapshots(task: LunaTaskBlock): Promise<OrchestratorSnapshots> {
    if (this.snapshots !== undefined) {
      const value = await this.snapshots.read();
      this.state.governanceRevision = value.governanceRevision;
      this.state.architectureRevisions = [...value.architectureRevisionSet];
      return value;
    }
    this.state.governanceRevision = task.fields.governance_revision;
    this.state.architectureRevisions = task.fields.architecture_revision_set.filter(isRevision);
    return {
      governance: { revision: this.state.governanceRevision },
      architecture: { revisions: [...this.state.architectureRevisions] },
      governanceRevision: this.state.governanceRevision,
      architectureRevisionSet: [...this.state.architectureRevisions],
      ...(this.baseline === null ? {} : { git: this.baseline }),
    };
  }

  private async recoverContext(observation: EdgeSolObservation): Promise<OrchestratorResult> {
    const eventId = contextEventId(observation);
    if (this.state.lastContextRecoveryEventId === eventId)
      return result('DUPLICATE', this.state, '该上下文过长事件已经处理过。');
    if (this.contextRecovery === undefined)
      return this.pauseForCode('CONTEXT_LIMIT', '无法自动恢复 Sol 上下文，请人工处理。', true);
    this.state.lastContextRecoveryEventId = eventId;
    await this.persist();
    try {
      const recovered = await this.contextRecovery.recover({ eventId, observation });
      if (recovered.status === 'RECOVERED' || recovered.status === 'ALREADY_ATTEMPTED') {
        await this.setPhase('WAITING_FOR_SOL', 'RUNNING');
        return result(
          'RECOVERED',
          this.state,
          recovered.status === 'RECOVERED' ? 'Sol 上下文已恢复。' : '该上下文事件已经尝试恢复。',
        );
      }
      return this.pauseForCode(
        recovered.error?.code ?? 'CONTEXT_RECOVERY_FAILED',
        recovered.error?.message ?? 'Sol 上下文恢复失败。',
        true,
      );
    } catch (error) {
      return this.pauseFor(error, 'Sol 上下文恢复失败，已暂停。');
    }
  }

  private finishWaiting(observation: EdgeSolObservation, message: string): Promise<OrchestratorResult> {
    this.state.processedOutputKey = outputKeyFor(observation);
    return this.enterWaiting(message).then(() => result('WAITING', this.state, message));
  }

  private async setPhase(
    phase: OrchestratorState['phase'],
    status: OrchestratorState['status'],
    taskId = this.state.taskId,
  ): Promise<void> {
    const inactive = !this.state.active && status === 'RUNNING';
    if (inactive) {
      this.state.phase = 'PAUSED';
      this.state.status = 'PAUSED';
      this.pauseActiveGraphNode('编排已暂停，未写回运行状态。');
    } else {
      const previousNode = nodeForPhase(this.state.phase);
      const nextNode = nodeForPhase(phase);
      if (previousNode !== null && previousNode !== nextNode) this.completeGraphNode(previousNode);
      this.state.phase = phase;
      this.state.status = status;
      if (nextNode !== null && status === 'RUNNING') this.activateGraphNode(nextNode, taskId);
    }
    this.state.taskId = taskId;
    this.touchState();
    await this.persist();
  }

  private async pauseFor(error: unknown, suggestion: string): Promise<OrchestratorResult> {
    const code = error instanceof OrchestratorError ? error.code : errorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    return this.pauseForCode(code, message, false, suggestion);
  }

  private async pauseForCode(
    code: string,
    message: string,
    needsUser = false,
    suggestion = '请检查状态面板后重试。',
  ): Promise<OrchestratorResult> {
    this.state.active = false;
    this.state.status = needsUser ? 'NEEDS_USER_ACTION' : 'PAUSED';
    this.state.phase = 'PAUSED';
    this.state.recentError = { code, message };
    this.blockActiveGraphNode(
      needsUser || dashboardNeedsNewSol({ code, message }) ? 'NEEDS_USER_ACTION' : 'RECOVERABLE_BLOCKED',
      code,
      message,
    );
    this.touchState();
    await this.persist();
    try {
      this.notifier?.notify({
        project: this.project.name,
        taskId: this.state.taskId,
        phase: this.state.phase,
        suggestion,
        error: { code, message },
        level: needsUser ? 'NEEDS_USER' : 'RECOVERABLE',
      });
    } catch {
      // Notification failures must not erase the orchestration diagnostic.
    }
    return result('PAUSED', this.state, message);
  }

  private async failFor(error: unknown): Promise<OrchestratorResult> {
    const code = errorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    this.state.active = false;
    this.state.status = 'FAILED';
    this.state.phase = 'FAILED';
    this.state.recentError = { code, message };
    this.blockActiveGraphNode(
      dashboardNeedsNewSol({ code, message }) ? 'NEEDS_USER_ACTION' : 'RECOVERABLE_BLOCKED',
      code,
      message,
    );
    this.touchState();
    await this.persist();
    try {
      this.notifier?.notify({
        project: this.project.name,
        taskId: this.state.taskId,
        phase: this.state.phase,
        suggestion: '请检查 Luna 输出、报告和工作区后重试。',
        error: { code, message },
        level: 'NEEDS_USER',
      });
    } catch {
      // Notification failures must not erase the orchestration diagnostic.
    }
    return result('FAILED', this.state, message);
  }

  private isTerminalFailure(error: unknown): boolean {
    const code = errorCode(error);
    return /^(?:FAILED|INVALID_RESULT|TIMEOUT|REPORT_MISSING|TESTS_NOT_PASSED)$/.test(code);
  }

  private async persist(): Promise<void> {
    await this.stateStore?.save(cloneState(this.state));
  }

  private async beginRound(): Promise<void> {
    const now = this.now().toISOString();
    this.state.loopGraph = createLoopGraph(`round-${this.state.revision + 1}-${this.now().getTime()}`, now);
    await this.setPhase('READING_SOL', 'RUNNING', null);
  }

  private async enterWaiting(message: string): Promise<void> {
    await this.setPhase('WAITING_FOR_SOL', 'RUNNING', null);
    this.updateGraphNode('wait-sol', { summary: message, details: [] });
    this.touchState();
    await this.persist();
  }

  private setPendingCodeSync(pending: PendingCodeSync): void {
    this.pendingCodeSync = pending;
    this.state.pendingCodeSync = clonePendingCodeSync(pending);
  }

  private resumeWaitingGraph(): void {
    this.activateGraphNode('wait-sol', null);
  }

  private activateGraphNode(nodeId: LoopGraphNodeId, taskId: string | null): void {
    const now = this.now().toISOString();
    for (const node of this.state.loopGraph.nodes) {
      if (node.id !== nodeId && node.state === 'ACTIVE') {
        node.state = 'COMPLETED';
        node.completedAt = now;
        node.updatedAt = now;
      }
    }
    const node = this.graphNode(nodeId);
    node.state = 'ACTIVE';
    node.startedAt ??= now;
    node.completedAt = null;
    node.updatedAt = now;
    node.summary = phaseSummary(nodeId, taskId, this.state);
    this.state.loopGraph.currentNodeId = nodeId;
  }

  private completeGraphNode(nodeId: LoopGraphNodeId): void {
    const node = this.graphNode(nodeId);
    if (node.state !== 'ACTIVE' && node.state !== 'PAUSED') return;
    const now = this.now().toISOString();
    node.state = 'COMPLETED';
    node.completedAt = now;
    node.updatedAt = now;
    if (this.state.loopGraph.currentNodeId === nodeId) this.state.loopGraph.currentNodeId = null;
  }

  private markNodesNotApplicable(nodeIds: LoopGraphNodeId[]): void {
    const now = this.now().toISOString();
    for (const nodeId of nodeIds) {
      const node = this.graphNode(nodeId);
      if (node.state === 'COMPLETED') continue;
      node.state = 'NOT_APPLICABLE';
      node.summary = '本轮无需执行。';
      node.updatedAt = now;
      if (this.state.loopGraph.currentNodeId === nodeId) this.state.loopGraph.currentNodeId = null;
    }
  }

  private pauseActiveGraphNode(summary: string): void {
    const active = this.state.loopGraph.nodes.find((node) => node.state === 'ACTIVE');
    if (active === undefined) return;
    active.state = 'PAUSED';
    active.summary = summary;
    active.updatedAt = this.now().toISOString();
    this.state.loopGraph.currentNodeId = active.id;
  }

  private blockActiveGraphNode(
    state: Extract<LoopGraphNodeState, 'RECOVERABLE_BLOCKED' | 'NEEDS_USER_ACTION'>,
    code: string,
    message: string,
  ): void {
    const active = this.state.loopGraph.nodes.find((node) => node.state === 'ACTIVE');
    if (active === undefined) return;
    active.state = state;
    active.summary = state === 'NEEDS_USER_ACTION' ? '需要用户处理后继续。' : '可恢复错误，等待重试。';
    active.details = compactDetails([`错误：${code}`, message]);
    active.updatedAt = this.now().toISOString();
    this.state.loopGraph.currentNodeId = active.id;
  }

  private updateGraphNode(nodeId: LoopGraphNodeId, update: Pick<LoopGraphNodeSnapshot, 'summary' | 'details'>): void {
    const node = this.graphNode(nodeId);
    node.summary = update.summary;
    node.details = compactDetails(update.details);
    node.updatedAt = this.now().toISOString();
  }

  private graphNode(nodeId: LoopGraphNodeId): LoopGraphNodeSnapshot {
    const node = this.state.loopGraph.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined) throw new OrchestratorError('LOOP_GRAPH_INVALID', `缺少 Loop Graph 节点 ${nodeId}。`);
    return node;
  }

  private touchState(): void {
    this.state.revision += 1;
    this.state.updatedAt = this.now().toISOString();
  }

  private reportPath(): string | null {
    return this.pendingCodeSync?.reportPath ?? null;
  }

  private async invokeCallback(
    name: 'rebind' | 'governanceConsistencyCheck' | 'openEdge' | 'openProject',
    unavailable: string,
  ): Promise<DashboardCommandResult> {
    const callback = this.callbacks[name];
    if (callback === undefined) return rejected('COMMAND_UNAVAILABLE', unavailable);
    const navigationCommand = name === 'openEdge' ? 'open-edge' : name === 'openProject' ? 'open-project' : null;
    if (navigationCommand !== null) {
      if (this.dashboardNavigationPromises.has(navigationCommand))
        return rejected('DASHBOARD_ACTION_BUSY', '该动作正在处理中，请稍候。');
      let tracked!: Promise<void>;
      tracked = Promise.resolve()
        .then(callback)
        .finally(() => {
          if (this.dashboardNavigationPromises.get(navigationCommand) === tracked)
            this.dashboardNavigationPromises.delete(navigationCommand);
        });
      this.dashboardNavigationPromises.set(navigationCommand, tracked);
      await tracked;
      return accepted('OK', '命令已完成。');
    }
    await callback();
    return accepted('OK', '命令已完成。');
  }
}

export function createOrchestrator(options: OrchestratorOptions): MainOrchestrator {
  return new MainOrchestrator(options);
}

function cloneState(state: OrchestratorState): OrchestratorState {
  const sanitized = sanitizeDashboardSnapshot({ loopGraph: state.loopGraph, recentError: state.recentError });
  return {
    ...state,
    architectureRevisions: [...state.architectureRevisions],
    luna: { ...state.luna },
    commits: { ...state.commits },
    recentError: sanitized.recentError === null ? null : { ...sanitized.recentError },
    loopGraph: sanitized.loopGraph,
    pendingCodeSync: clonePendingCodeSync(state.pendingCodeSync),
    activeSolSession: state.activeSolSession === null ? null : { ...state.activeSolSession },
  };
}

function normalizeState(state: OrchestratorState): OrchestratorState {
  const source = state as Partial<OrchestratorState>;
  return {
    ...DEFAULT_STATE,
    ...source,
    architectureRevisions: Array.isArray(source.architectureRevisions) ? [...source.architectureRevisions] : [],
    luna: { ...DEFAULT_STATE.luna, ...source.luna },
    commits: { ...DEFAULT_STATE.commits, ...source.commits },
    recentError: source.recentError === null || source.recentError === undefined ? null : { ...source.recentError },
    loopGraph: sanitizeDashboardSnapshot(source.loopGraph === undefined ? {} : { loopGraph: source.loopGraph })
      .loopGraph,
    pendingCodeSync: normalizePendingCodeSync(source.pendingCodeSync),
    activeSolSession:
      source.activeSolSession === null || source.activeSolSession === undefined ? null : { ...source.activeSolSession },
  };
}

function createPendingCodeSync(
  task: LunaTaskBlock,
  run: CodexRunResult,
  baseline: PendingCodeSyncState['baseline'],
  outputKey: string,
): PendingCodeSync {
  return {
    taskId: task.fields.task_id,
    reportPath: task.fields.report_path,
    allowedPaths: [...task.fields.scope],
    protectedPaths: [...task.fields.out_of_scope],
    baseline,
    testsPassed: run.status === 'COMPLETED',
    sessionId: run.sessionId,
    outputKey,
  };
}

function clonePendingCodeSync(value: unknown): PendingCodeSyncState | null {
  const pending = normalizePendingCodeSync(value);
  if (pending === null) return null;
  return {
    ...pending,
    allowedPaths: [...pending.allowedPaths],
    protectedPaths: [...pending.protectedPaths],
    baseline: { ...pending.baseline, worktree: [...pending.baseline.worktree] },
  };
}

function normalizePendingCodeSync(value: unknown): PendingCodeSyncState | null {
  if (!isRecord(value)) return null;
  const taskId = boundedPendingText(value.taskId, 256);
  const reportPath = boundedPendingText(value.reportPath, 1024);
  const sessionId = boundedPendingText(value.sessionId, 256);
  const outputKey = boundedPendingText(value.outputKey, 128);
  const baseline = normalizePendingBaseline(value.baseline);
  if (taskId === null || reportPath === null || sessionId === null || outputKey === null || baseline === null)
    return null;
  if (typeof value.testsPassed !== 'boolean') return null;
  return {
    taskId,
    reportPath,
    allowedPaths: normalizePendingStringArray(value.allowedPaths, 512),
    protectedPaths: normalizePendingStringArray(value.protectedPaths, 512),
    baseline,
    testsPassed: value.testsPassed,
    sessionId,
    outputKey,
  };
}

function normalizePendingBaseline(value: unknown): PendingCodeSyncState['baseline'] | null {
  if (!isRecord(value)) return null;
  const repositoryRoot = boundedPendingText(value.repositoryRoot, 1024);
  const remoteName = boundedPendingText(value.remoteName, 256);
  const remoteUrl = boundedPendingText(value.remoteUrl, 2048);
  const branch = boundedPendingText(value.branch, 256);
  const head = boundedPendingText(value.head, 256);
  if (repositoryRoot === null || remoteName === null || remoteUrl === null || branch === null || head === null)
    return null;
  const remoteTip =
    value.remoteTip === undefined || value.remoteTip === null ? null : boundedPendingText(value.remoteTip, 256);
  if (value.remoteTip !== undefined && value.remoteTip !== null && remoteTip === null) return null;
  return {
    repositoryRoot,
    remoteName,
    remoteUrl,
    branch,
    head,
    remoteTip,
    worktree: normalizePendingStringArray(value.worktree, 1024),
  };
}

function normalizePendingStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const values: string[] = [];
  for (let index = 0; index < Math.min(value.length, limit); index += 1) {
    const item = boundedPendingText(value[index], 1024);
    if (item !== null) values.push(item);
  }
  return values;
}

function boundedPendingText(value: unknown, maxLength: number): string | null {
  const sanitized = sanitizeSafeText(value, maxLength);
  return sanitized === '' ? null : sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createLoopGraph(roundId: string | null, updatedAt: string): LoopGraphSnapshot {
  return {
    roundId,
    currentNodeId: null,
    nodes: LOOP_GRAPH_NODE_DEFINITIONS.map(({ id, label }) => ({
      id,
      label,
      state: 'PENDING',
      summary: '',
      details: [],
      startedAt: null,
      completedAt: null,
      updatedAt,
    })),
  };
}

function nodeForPhase(phase: OrchestratorState['phase']): LoopGraphNodeId | null {
  switch (phase) {
    case 'READING_SOL':
      return 'read-sol';
    case 'PARSING':
      return 'parse-task';
    case 'APPLYING_UPDATES':
      return 'apply-updates';
    case 'SYNCING_GOVERNANCE':
      return 'sync-governance';
    case 'RUNNING_LUNA':
      return 'run-luna';
    case 'SYNCING_CODE':
      return 'sync-code';
    case 'NOTIFYING_SOL':
      return 'notify-sol';
    case 'WAITING_FOR_SOL':
      return 'wait-sol';
    default:
      return null;
  }
}

function phaseSummary(nodeId: LoopGraphNodeId, taskId: string | null, state: OrchestratorState): string {
  switch (nodeId) {
    case 'read-sol':
      return '正在读取 Sol 会话。';
    case 'parse-task':
      return '正在校验 Writing Block。';
    case 'apply-updates':
      return '正在应用治理或架构更新。';
    case 'sync-governance':
      return '正在创建并同步治理提交。';
    case 'run-luna':
      return taskId === null ? '正在启动 Luna。' : `正在执行任务 ${taskId}。`;
    case 'sync-code':
      return taskId === null ? '正在同步代码。' : `正在同步任务 ${taskId} 的代码。`;
    case 'notify-sol':
      return '正在通知 Sol。';
    case 'wait-sol':
      return state.recentError === null ? '等待 Sol 产生稳定输出。' : '等待用户恢复编排。';
  }
}

function compactDetails(values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value !== '').slice(0, 16);
}

function commitDetails(local: string | null, remote: string | null): string[] {
  return compactDetails([local === null ? '' : `本地提交：${local}`, remote === null ? '' : `远端提交：${remote}`]);
}

function writingBlockCount(parsed: ReturnType<typeof parseWritingBlocks>): number {
  return (
    parsed.governanceChanges.length +
    parsed.architectureFreezes.length +
    (parsed.lunaTask === null ? 0 : 1) +
    parsed.blocked.length
  );
}

function outputKeyFor(observation: EdgeSolObservation): string {
  const source = `${observation.projectFingerprint ?? ''}\n${observation.url}\n${observation.latestAssistantHash ?? observation.latestAssistantText}`;
  return createHash('sha256').update(source).digest('hex');
}

function reconciliationOutputKey(solOutput: string, baselineHead: string): string {
  return createHash('sha256').update(`governance-reconciliation\n${baselineHead}\n${solOutput}`).digest('hex');
}

function contextEventId(observation: EdgeSolObservation): string {
  return `context:${outputKeyFor(observation)}`;
}

function isRevision(value: unknown): value is string | number {
  return (typeof value === 'string' && value.trim() !== '') || (typeof value === 'number' && Number.isFinite(value));
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string')
    return error.code;
  return 'ORCHESTRATION_FAILED';
}

const DASHBOARD_NON_RETRYABLE_ERROR_CODES = new Set([
  'ARCHITECTURE_FREEZE_CONTENT_TYPE_INVALID',
  'ARCHITECTURE_FREEZE_DUPLICATE_CONFLICT',
  'ARCHITECTURE_FREEZE_HASH_MISMATCH',
  'ARCHITECTURE_FREEZE_INVALID',
  'ARCHITECTURE_FREEZE_PATH_UNSAFE',
  'ARCHITECTURE_FREEZE_PRIVATE_HOST',
  'ARCHITECTURE_FREEZE_REDIRECT_REJECTED',
  'ARCHITECTURE_FREEZE_RESPONSE_INVALID',
  'ARCHITECTURE_FREEZE_TOO_LARGE',
  'ARCHITECTURE_FREEZE_URL_INVALID',
  'BASELINE_CHANGED',
  'INVALID_RESULT',
  'PROTECTED_PATH',
  'UNAUTHORIZED_CHANGE',
]);

function dashboardNeedsNewSol(error: { code: string; message: string } | null): boolean {
  if (error === null) return false;
  return (
    DASHBOARD_NON_RETRYABLE_ERROR_CODES.has(error.code) ||
    /^(?:WRITING_BLOCK|PROTOCOL|SOL_BLOCKED|.*(?:CONFLICT|SCOPE))/.test(error.code) ||
    /^GOVERNANCE_RECONCILIATION_.*(?:PROTOCOL|INVALID)/.test(error.code) ||
    /^GOVERNANCE(?:_|$).*(?:CONFLICT|BLOCKED|PATH_|SHA_)/.test(error.code) ||
    error.code === 'GOVERNANCE_RECONCILIATION_WRONG_ENTRYPOINT'
  );
}

function isRetryableDashboardError(error: { code: string; message: string } | null): boolean {
  if (error === null || dashboardNeedsNewSol(error)) return false;
  return /^(?:FAILED|TIMEOUT|NETWORK|SESSION|CLI|CODEX|LUNA|REPORT|TEST|GIT|PUSH|SYNC|CONTEXT|AUTH|PROCESS_|COMMAND_FAILED|DASHBOARD_COMMAND_FAILED|COMMIT_FAILED|GOVERNANCE_CHANGE_COMMIT_FAILED|GOVERNANCE_RECONCILIATION_COMMIT_FAILED|ARCHITECTURE_FREEZE_(?:FETCH_FAILED|CONTENT_UNREADABLE|COMMIT_FAILED)|EDGE_PROCESS_EXITED|GOVERNANCE_RECONCILIATION_(?:TIMEOUT|AUTH_REQUIRED|CONTEXT_LIMIT)|BLOCKED_EXTERNAL_SETUP)/i.test(
    error.code,
  );
}

function safeSyncId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:/-]+/g, '_').slice(0, 80) || 'update';
}

function result(status: OrchestratorResult['status'], state: OrchestratorState, message: string): OrchestratorResult {
  return { status, phase: state.phase, taskId: state.taskId, message };
}

function reconciliationResult(
  status: GovernanceReconciliationRunResult['status'],
  reconciliationStatus: GovernanceReconciliationRunResult['reconciliationStatus'],
  round: OrchestratorResult,
  runId: string | null,
  changedPaths: string[],
  backupPaths: string[],
  commit: string | null,
  remoteCommit: string | null,
): GovernanceReconciliationRunResult {
  return {
    status,
    reconciliationStatus,
    phase: round.phase,
    message: round.message,
    runId,
    changedPaths: [...changedPaths],
    backupPaths: [...backupPaths],
    commit,
    remoteCommit,
  };
}

function accepted(code: string, message: string): DashboardCommandResult {
  return { accepted: true, code, message };
}

function rejected(code: string, message: string): DashboardCommandResult {
  return { accepted: false, code, message };
}
