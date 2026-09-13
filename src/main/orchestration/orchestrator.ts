import { createHash } from 'node:crypto';
import {
  DASHBOARD_ROUND_HISTORY_LIMIT,
  LOOP_GRAPH_NODE_DEFINITIONS,
  sanitizeDashboardSnapshot,
  validateDashboardCommand,
  type DashboardCommand,
  type DashboardCommandResult,
  type DashboardActions,
  type DashboardBaselineSnapshot,
  type DashboardRoundRecord,
  type DashboardSnapshot,
  type DashboardStaleTaskSnapshot,
  type LoopGraphNodeId,
  type LoopGraphNodeSnapshot,
  type LoopGraphNodeState,
  type LoopGraphSnapshot,
} from '../../shared/contracts/dashboard.js';
import { sanitizeSafeText } from '../../shared/contracts/safe-text.js';
import {
  extractUserMessage,
  parseWritingBlocks,
  type GovernanceReconciliationBlock,
  type LunaTaskBlock,
  type LunaTestStatus,
} from '../../shared/protocol/writing-block.js';
import { resolve } from 'node:path';
import { compileSolAutoRepairPrompt } from '../sol/prompt-compiler.js';
import type { EdgeSolObservation } from '../edge/types.js';
import type { CodexRunResult } from '../codex/types.js';
import type { GitManualOperationRecord } from '../git/types.js';
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
  type AutoRepairState,
  type ExecutionRecoveryRecord,
  type PendingCodeSyncState,
  type PendingReconciliationSyncState,
  type SolMessageSource,
  type AutoRepairStatus,
  type ExecutionMetricsState,
  type ExecutionSessionEndReason,
  type ExecutionSessionRecord,
} from './types.js';

const MAX_RETRIES = 3;
const MAX_AUTO_REPAIR_ATTEMPTS_PER_ROUND = 2;
const LEGACY_RECOVERY_OUTPUT_KEY = '__legacy_recovery_pending__';

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
  retryCount: 0,
  loopGraph: createLoopGraph(null, new Date(0).toISOString()),
  pendingCodeSync: null,
  pendingReconciliationSync: null,
  autoRepair: null,
  executionMetrics: createDefaultExecutionMetrics(),
  roundHistory: [],
  executionRecovery: null,
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
type PendingReconciliationSync = PendingReconciliationSyncState;

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
  private readonly now: () => Date;
  private state: OrchestratorState = cloneState(DEFAULT_STATE);
  private baseline: Awaited<ReturnType<GitOrchestratorPort['captureBaseline']>> | null = null;
  private staleTask: DashboardStaleTaskSnapshot = emptyStaleTask();
  private pendingCodeSync: PendingCodeSync | null = null;
  /** Retained only in memory so a retryable reconciliation sync failure can resume its original flow. */
  private pendingReconciliationInput: GovernanceReconciliationRunInput | null = null;
  private pendingReconciliationSync: PendingReconciliationSync | null = null;
  private loadPromise: Promise<void> | null = null;
  private initialized = false;
  private roundPromise: Promise<OrchestratorResult> | null = null;
  private reconciliationPromise: Promise<GovernanceReconciliationRunResult> | null = null;
  private retryPromise: Promise<OrchestratorResult> | null = null;
  private continuePromise: Promise<OrchestratorResult> | null = null;
  private orchestrationTail: Promise<void> = Promise.resolve();
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
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.loadPromise !== null) return this.loadPromise;
    this.loadPromise = (async () => {
      const stored = await this.stateStore?.load();
      if (stored !== null && stored !== undefined && stored.version === 1) this.state = normalizeState(stored);
      this.pendingCodeSync = clonePendingCodeSync(this.state.pendingCodeSync);
      this.pendingReconciliationSync = clonePendingReconciliationSync(this.state.pendingReconciliationSync);
      this.state.executionRecovery = cloneExecutionRecovery(this.state.executionRecovery);
      this.migrateLegacyWrongEntrypointState();
      const interrupted = this.state.active || this.state.status === 'RUNNING';
      if (interrupted) this.closeExecutionSession('RESTARTED');
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
      taskTitle: this.currentRoundRecord()?.taskTitle ?? null,
      governanceRevision: this.state.governanceRevision,
      architectureRevisions: this.state.architectureRevisions,
      luna: this.state.luna,
      commits: this.state.commits,
      currentBaseline: this.dashboardBaseline(),
      staleTask: this.staleTask,
      manualGitOperation: this.state.manualGitOperation ?? null,
      recentError: this.state.recentError,
      recovery: this.state.executionRecovery,
      autoRepair: this.state.autoRepair,
      executionMetrics: this.dashboardExecutionMetrics(),
      roundHistory: this.state.roundHistory,
      loopGraph: this.state.loopGraph,
      actions: this.dashboardActions(),
    });
  }

  private dashboardActions(): DashboardActions {
    const roundBusy = this.roundPromise !== null;
    const reconciliationBusy = this.reconciliationPromise !== null;
    const operationBusy =
      roundBusy ||
      reconciliationBusy ||
      this.retryPromise !== null ||
      this.continuePromise !== null ||
      this.dashboardOperationPromise !== null;
    const hasRecoverableError =
      this.state.retryCount < MAX_RETRIES &&
      (this.pendingCodeSync !== null ||
        this.pendingReconciliationInput !== null ||
        this.pendingReconciliationSync !== null ||
        isRetryableDashboardError(this.state.recentError));
    const callbackAvailable = (
      name: 'rebind' | 'governanceConsistencyCheck' | 'stageGoalReview' | 'openEdge' | 'openProject' | 'viewReport',
    ) => this.callbacks[name] !== undefined;
    const disabled = (reason: string, busy = false) => ({ enabled: false, busy, reason });
    const enabled = () => ({ enabled: true, busy: false, reason: null });

    return {
      start: operationBusy
        ? disabled('已有编排操作正在处理中。', true)
        : this.state.active
          ? disabled('自动循环正在运行中。')
          : enabled(),
      pause: this.state.active ? enabled() : disabled('自动循环当前未运行。'),
      'retry-current-stage': operationBusy
        ? disabled('已有操作正在处理中。', true)
        : this.state.active
          ? disabled('自动循环运行中，请先暂停后再重试。')
          : hasRecoverableError
            ? enabled()
            : disabled('当前没有可重试的阶段错误；如已修复 Sol 输出，请启动自动循环重新读取。'),
      'continue-interrupted': operationBusy
        ? disabled('已有操作正在处理中。', true)
        : !this.state.active && this.state.executionRecovery?.awaitingConfirmation === true
          ? enabled()
          : disabled('当前没有等待确认的中断执行记录。'),
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
      'stage-goal-review': operationBusy
        ? disabled('已有操作正在处理中。', true)
        : this.state.active
          ? disabled('自动循环运行中，请先暂停后再执行阶段性规划检查。')
          : callbackAvailable('stageGoalReview')
            ? enabled()
            : disabled('阶段性目标规划与任务梳理回调不可用。'),
      'align-latest-baseline': operationBusy
        ? disabled('已有操作正在处理中。', true)
        : this.state.active
          ? disabled('自动循环运行中，请先暂停后再对齐基线。')
          : enabled(),
      'commit-and-push': operationBusy
        ? disabled('已有操作正在处理中。', true)
        : this.state.active
          ? disabled('自动循环运行中，请先暂停后再提交同步。')
          : enabled(),
      'discard-worktree-changes': operationBusy
        ? disabled('已有操作正在处理中。', true)
        : this.state.active
          ? disabled('自动循环运行中，请先暂停后再清理工作区。')
          : enabled(),
      'finish-round-wait-sol': operationBusy
        ? disabled('已有操作正在处理中。', true)
        : this.state.active
          ? disabled('自动循环运行中，请先暂停后再结束当前轮。')
          : this.pendingCodeSync !== null ||
              this.pendingReconciliationInput !== null ||
              this.pendingReconciliationSync !== null
            ? disabled('当前轮仍有待处理上下文，不能跳过。')
            : this.state.loopGraph.roundId === null
              ? disabled('当前没有可结束的循环轮次。')
              : enabled(),
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
    if (this.state.active || this.roundPromise !== null) {
      return result('WAITING', this.state, '自动循环已经在运行中。');
    }
    const hasInterruptedExecution =
      this.state.executionRecovery !== null ||
      this.state.loopGraph.nodes.some(
        (node) => node.state === 'RECOVERABLE_BLOCKED' || node.state === 'NEEDS_USER_ACTION',
      );
    if (this.state.executionRecovery === null && hasInterruptedExecution) {
      const legacy = this.legacyRecoveryRecord();
      if (legacy !== null) this.state.executionRecovery = legacy;
    }
    if (this.pendingReconciliationSync !== null) {
      if (this.state.retryCount >= MAX_RETRIES) return this.pauseForRetryLimit();
      this.beginExecutionSession();
      this.state.active = true;
      this.state.status = 'RUNNING';
      this.state.phase = 'SYNCING_GOVERNANCE';
      this.state.taskId = null;
      this.state.recentError = null;
      this.activateGraphNode('sync-governance', null);
      this.touchState();
      await this.persist();
      return result('WAITING', this.state, '已恢复治理一致性同步上下文，请重试当前同步。');
    }
    this.clearPendingReconciliationRetry();
    if (this.pendingCodeSync !== null) {
      this.beginExecutionSession();
      this.state.active = true;
      this.state.status = 'RUNNING';
      this.state.phase = 'SYNCING_CODE';
      this.state.taskId = this.pendingCodeSync.taskId;
      this.activateGraphNode('sync-code', this.pendingCodeSync.taskId);
      this.state.recentError = null;
      this.state.retryCount = 0;
      this.touchState();
      await this.persist();
      void this.runRound();
      return result('WAITING', this.state, '已恢复代码同步，等待继续执行。');
    }
    this.beginExecutionSession();
    this.state.active = true;
    this.state.status = 'RUNNING';
    this.state.retryCount = 0;
    if (this.state.loopGraph.roundId === null) await this.beginRound();
    else await this.setPhase('READING_SOL', 'RUNNING', this.state.taskId);
    this.state.recentError = null;
    this.touchState();
    await this.persist();
    void this.runRound();
    return result('WAITING', this.state, '编排器已启动，正在读取 Sol。');
  }

  async pause(): Promise<OrchestratorResult> {
    await this.initialize();
    this.closeExecutionSession('PAUSED');
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
    if (this.retryPromise !== null) return this.retryPromise;
    const operation = this.withOrchestrationLock(() => this.processRetryCurrentStage());
    this.retryPromise = operation;
    try {
      return await operation;
    } finally {
      this.retryPromise = null;
    }
  }

  async continueInterrupted(): Promise<OrchestratorResult> {
    await this.initialize();
    if (this.continuePromise !== null) return this.continuePromise;
    const operation = this.withOrchestrationLock(async () => {
      const recovery = this.state.executionRecovery;
      if (recovery === null || !recovery.awaitingConfirmation)
        return result('PAUSED', this.state, '当前没有等待确认的中断执行记录。');
      this.state.executionRecovery = { ...recovery, awaitingConfirmation: false, updatedAt: this.now().toISOString() };
      this.state.active = true;
      this.state.status = 'RUNNING';
      this.beginExecutionSession();
      this.state.recentError = null;
      this.state.taskId = recovery.taskId;
      const nodeId = recovery.interruptedNodeId ?? nodeForPhase(recovery.interruptedPhase) ?? 'parse-task';
      this.state.phase =
        recovery.interruptedPhase === 'PAUSED' || recovery.interruptedPhase === 'FAILED'
          ? 'PARSING'
          : recovery.interruptedPhase;
      this.activateGraphNode(nodeId, recovery.taskId);
      this.touchState();
      await this.persist();
      return this.processRound();
    });
    this.continuePromise = operation;
    try {
      return await operation;
    } finally {
      this.continuePromise = null;
    }
  }

  async alignLatestBaseline(): Promise<OrchestratorResult> {
    await this.initialize();
    let completed: OrchestratorResult | undefined;
    await this.runDashboardOperation(async () => {
      completed = await this.withOrchestrationLock(() => this.performAlignLatestBaseline());
    });
    return completed ?? result('PAUSED', this.state, '基线对齐未返回结果。');
  }

  async commitAndPushProject(): Promise<OrchestratorResult> {
    await this.initialize();
    let completed: OrchestratorResult | undefined;
    await this.runDashboardOperation(async () => {
      completed = await this.withOrchestrationLock(() => this.performCommitAndPushProject());
    });
    return completed ?? result('PAUSED', this.state, 'Git 提交同步未返回结果。');
  }

  async discardWorktreeChanges(): Promise<OrchestratorResult> {
    await this.initialize();
    let completed: OrchestratorResult | undefined;
    await this.runDashboardOperation(async () => {
      completed = await this.withOrchestrationLock(() => this.performDiscardWorktreeChanges());
    });
    return completed ?? result('PAUSED', this.state, '工作区清理未返回结果。');
  }

  async finishRoundAndWaitForSol(): Promise<OrchestratorResult> {
    await this.initialize();
    let completed: OrchestratorResult | undefined;
    await this.runDashboardOperation(async () => {
      completed = await this.withOrchestrationLock(() => this.performFinishRoundAndWaitForSol());
    });
    return completed ?? result('PAUSED', this.state, '结束当前轮未返回结果。');
  }

  private async performFinishRoundAndWaitForSol(): Promise<OrchestratorResult> {
    if (this.state.active) return result('WAITING', this.state, '自动循环正在运行中，请先暂停后再结束当前轮。');
    if (
      this.pendingCodeSync !== null ||
      this.pendingReconciliationInput !== null ||
      this.pendingReconciliationSync !== null
    ) {
      throw new OrchestratorError('ROUND_FINISH_UNSAFE', '当前轮仍有待同步代码、治理更新或恢复上下文，不能直接结束。');
    }
    const outputKey = this.state.executionRecovery?.outputKey ?? this.state.processedOutputKey;
    if (outputKey !== null) this.state.processedOutputKey = outputKey;
    this.state.active = true;
    this.state.status = 'RUNNING';
    this.state.phase = 'WAITING_FOR_SOL';
    this.state.recentError = null;
    this.state.executionRecovery = null;
    this.state.autoRepair = null;
    this.resumeWaitingGraph();
    this.updateCurrentRoundRecord({ status: 'SKIPPED' }, true);
    this.completeExecutionRound();
    this.touchState();
    await this.persist();
    return result('COMPLETED', this.state, '当前轮已结束，正在等待 Sol 产生新的任务书。');
  }

  async runRound(): Promise<OrchestratorResult> {
    await this.initialize();
    if (this.roundPromise !== null) return this.roundPromise;
    this.roundPromise = this.withOrchestrationLock(() =>
      this.processRound().catch((error) =>
        this.isTerminalFailure(error) ? this.failFor(error) : this.pauseFor(error, '当前阶段执行失败，已暂停。'),
      ),
    );
    try {
      return await this.roundPromise;
    } finally {
      this.roundPromise = null;
    }
  }

  async beginGovernanceReconciliationWait(): Promise<void> {
    await this.initialize();
    this.state.active = true;
    this.state.status = 'RUNNING';
    this.state.recentError = null;
    await this.setPhase('WAITING_FOR_SOL', 'RUNNING', null);
    this.updateGraphNode('wait-sol', {
      summary: '正在等待 Sol 返回治理一致性检查结果。',
      details: ['治理一致性检查已发送，等待新的稳定回复。'],
    });
    this.touchState();
    await this.persist();
  }

  async pauseGovernanceReconciliation(error: unknown): Promise<void> {
    await this.initialize();
    if (this.state.phase === 'PAUSED' && this.state.recentError !== null) return;
    await this.pauseFor(error, '治理一致性检查未完成，请确认 Sol 已输出后重新检查。');
  }

  async runGovernanceReconciliation(
    input: GovernanceReconciliationRunInput,
  ): Promise<GovernanceReconciliationRunResult> {
    await this.initialize();
    if (this.reconciliationPromise !== null) return this.reconciliationPromise;
    const retryInput = cloneGovernanceReconciliationInput(input);
    this.reconciliationPromise = this.withOrchestrationLock(async () => {
      this.clearPendingReconciliationRetry();
      this.state.retryCount = 0;
      this.pendingReconciliationInput = retryInput;
      await this.persist();
      try {
        const completed = await this.processGovernanceReconciliation(retryInput);
        this.clearPendingReconciliationRetry();
        await this.persist();
        return completed;
      } catch (error) {
        const retryable = isRetryableGovernanceReconciliationError(error);
        if (this.pendingReconciliationSync !== null && retryable) this.pendingReconciliationInput = null;
        else if (retryable) this.pendingReconciliationInput = retryInput;
        else this.clearPendingReconciliationRetry();
        const paused = await this.pauseFor(error, '治理一致性检查已暂停，请检查协议、基线和文件状态后重试。');
        return reconciliationResult('PAUSED', null, paused, null, [], [], null, null);
      }
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
      const action = this.dashboardActions()[validated.command]!;
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
        case 'continue-interrupted': {
          const hadRecovery = this.state.executionRecovery?.awaitingConfirmation === true;
          const continued = await this.continueInterrupted();
          if (!hadRecovery) return rejected('CONTINUE_UNAVAILABLE', continued.message);
          return accepted(
            continued.status === 'COMPLETED'
              ? 'CONTINUE_COMPLETED'
              : (this.state.recentError?.code ?? 'CONTINUE_PAUSED'),
            continued.message,
          );
        }
        case 'rebind':
          return await this.invokeCallback('rebind', '重新绑定回调不可用。');
        case 'governance-consistency-check':
          return await this.invokeCallback('governanceConsistencyCheck', '治理一致性检查回调不可用。');
        case 'stage-goal-review':
          return await this.invokeCallback('stageGoalReview', '阶段性目标规划与任务梳理回调不可用。');
        case 'align-latest-baseline':
          return accepted('BASELINE_ALIGN_ACCEPTED', (await this.alignLatestBaseline()).message);
        case 'commit-and-push':
          return accepted('GIT_SYNC_ACCEPTED', (await this.commitAndPushProject()).message);
        case 'discard-worktree-changes':
          return accepted('WORKTREE_DISCARD_ACCEPTED', (await this.discardWorktreeChanges()).message);
        case 'finish-round-wait-sol':
          return accepted('ROUND_FINISH_ACCEPTED', (await this.finishRoundAndWaitForSol()).message);
        case 'open-edge':
          return await this.invokeCallback('openEdge', '打开 Edge 回调不可用。');
        case 'open-project':
          return await this.invokeCallback('openProject', '打开项目回调不可用。');
        case 'view-report':
          if (this.callbacks.viewReport === undefined)
            return rejected('VIEW_REPORT_UNAVAILABLE', '查看报告回调不可用。');
          await this.callbacks.viewReport(validated.reportPath ?? this.reportPath());
          return accepted('OK', '已请求打开任务报告。');
        default:
          return rejected('DASHBOARD_COMMAND_UNAVAILABLE', '该手动 Git 命令尚未接入执行器。');
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

  private async performAlignLatestBaseline(): Promise<OrchestratorResult> {
    const wasIdle = this.state.status === 'IDLE' && this.state.phase === 'IDLE';
    this.startManualGitOperation('align-latest-baseline', 'CHECKING_WORKTREE');
    await this.persist();
    try {
      if (this.git.readRepositoryStatus === undefined)
        throw new OrchestratorError('GIT_MAINTENANCE_UNAVAILABLE', '当前运行时不支持 Git 基线对齐。');
      const status = await this.git.readRepositoryStatus(this.project.localPath);
      if (!status.clean) {
        throw new OrchestratorError(
          'WORKTREE_DIRTY',
          `工作区存在未提交变更，无法对齐基线：${status.worktree.slice(0, 20).join('、')}`,
        );
      }
      this.updateManualGitOperation('ALIGNING_BASELINE');
      await this.persist();
      const next = await this.captureConfiguredBaseline();
      await this.adoptBaseline(next);
      this.state.executionRecovery = null;
      this.state.recentError = null;
      this.state.active = false;
      this.state.status = wasIdle ? 'IDLE' : 'PAUSED';
      this.state.phase = wasIdle ? 'IDLE' : 'PAUSED';
      this.updateManualGitOperation('COMPLETED', {
        phase: 'COMPLETED',
        localCommit: next.head,
        remoteCommit: next.remoteTip,
        createdCommit: false,
        pushed: false,
        clean: true,
      });
      this.touchState();
      await this.persist();
      return result('COMPLETED', this.state, `已对齐最新 Git 基线：${next.head}`);
    } catch (error) {
      return this.finishManualGitFailure(error, '基线对齐失败，请检查 Git 状态后重试。');
    }
  }

  private async performCommitAndPushProject(): Promise<OrchestratorResult> {
    const wasIdle = this.state.status === 'IDLE' && this.state.phase === 'IDLE';
    this.startManualGitOperation('commit-and-push', 'CHECKING_WORKTREE');
    await this.persist();
    try {
      if (this.git.readRepositoryStatus === undefined || this.git.commitAndPushProject === undefined)
        throw new OrchestratorError('GIT_MAINTENANCE_UNAVAILABLE', '当前运行时不支持 Git 提交同步。');
      const before = await this.git.readRepositoryStatus(this.project.localPath);
      this.updateManualGitOperation(before.clean ? 'PUSHING' : 'COMMITTING');
      await this.persist();
      let synced;
      try {
        synced = await this.git.commitAndPushProject(this.project.localPath);
      } catch (error) {
        if (!before.clean || errorCode(error) !== 'NO_CHANGES') throw error;
        const baseline = await this.captureConfiguredBaseline();
        await this.adoptBaseline(baseline);
        this.updateManualGitOperation('COMPLETED', {
          phase: 'COMPLETED',
          localCommit: baseline.head,
          remoteCommit: baseline.remoteTip,
          createdCommit: false,
          pushed: false,
          changedPaths: [],
          clean: true,
        });
        this.state.recentError = null;
        this.state.status = wasIdle ? 'IDLE' : 'PAUSED';
        this.state.phase = wasIdle ? 'IDLE' : 'PAUSED';
        this.touchState();
        await this.persist();
        return result('COMPLETED', this.state, '工作区已干净，无需提交；软件基线已刷新。');
      }
      const next = await this.captureConfiguredBaseline();
      await this.adoptBaseline(next);
      this.state.commits = { local: synced.localCommit, remote: synced.remoteCommit };
      this.state.executionRecovery = null;
      this.state.recentError = null;
      this.state.active = false;
      this.state.status = wasIdle ? 'IDLE' : 'PAUSED';
      this.state.phase = wasIdle ? 'IDLE' : 'PAUSED';
      this.updateManualGitOperation('COMPLETED', synced);
      this.touchState();
      await this.persist();
      return result('COMPLETED', this.state, `已提交并同步 Git：${synced.localCommit ?? next.head}`);
    } catch (error) {
      return this.finishManualGitFailure(error, 'Git 提交或推送失败，请按阶段提示处理后重试。');
    }
  }

  private async performDiscardWorktreeChanges(): Promise<OrchestratorResult> {
    const wasIdle = this.state.status === 'IDLE' && this.state.phase === 'IDLE';
    this.startManualGitOperation('discard-worktree-changes', 'CHECKING_WORKTREE');
    await this.persist();
    try {
      if (this.git.readRepositoryStatus === undefined || this.git.discardWorktreeChanges === undefined)
        throw new OrchestratorError('GIT_MAINTENANCE_UNAVAILABLE', '当前运行时不支持工作区清理。');
      const before = await this.git.readRepositoryStatus(this.project.localPath);
      if (before.clean) throw new OrchestratorError('NO_CHANGES', '工作区当前没有未提交修改。');
      this.updateManualGitOperation('DISCARDING');
      await this.persist();
      const discarded = await this.git.discardWorktreeChanges(this.project.localPath);
      const next = await this.captureConfiguredBaseline();
      await this.adoptBaseline(next);
      this.state.commits = {
        local: discarded.localCommit ?? next.head,
        remote: discarded.remoteCommit ?? next.remoteTip,
      };
      this.state.executionRecovery = null;
      this.state.recentError = null;
      this.state.active = false;
      this.state.status = wasIdle ? 'IDLE' : 'PAUSED';
      this.state.phase = wasIdle ? 'IDLE' : 'PAUSED';
      this.updateManualGitOperation('COMPLETED', discarded);
      this.touchState();
      await this.persist();
      return result('COMPLETED', this.state, '未提交修改已移入 Git stash，工作区已清理。');
    } catch (error) {
      return this.finishManualGitFailure(error, '工作区清理失败，请检查 Git 状态后重试。');
    }
  }

  private startManualGitOperation(
    operation: GitManualOperationRecord['operation'],
    status: GitManualOperationRecord['status'],
  ): void {
    const now = this.now().toISOString();
    this.state.manualGitOperation = {
      operation,
      status,
      startedAt: now,
      updatedAt: now,
      result: null,
      error: null,
    };
  }

  private updateManualGitOperation(
    status: GitManualOperationRecord['status'],
    resultValue?: GitManualOperationRecord['result'],
  ): void {
    const current = this.state.manualGitOperation;
    if (current === undefined) return;
    current.status = status;
    current.updatedAt = this.now().toISOString();
    if (resultValue !== undefined) current.result = resultValue;
  }

  private async finishManualGitFailure(error: unknown, suggestion: string): Promise<OrchestratorResult> {
    const code = errorCode(error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    const details = errorDetails(error);
    const localCommit = commitValue(details.localCommit);
    const remoteCommit = commitValue(details.remoteCommit);
    const current = this.state.manualGitOperation;
    if (current !== undefined) {
      current.status = 'FAILED';
      current.updatedAt = this.now().toISOString();
      if (current.operation !== 'align-latest-baseline' && (localCommit !== null || remoteCommit !== null)) {
        current.result = {
          phase: 'FAILED',
          localCommit,
          remoteCommit,
          createdCommit: details.createdCommit === true,
          pushed: false,
          changedPaths: Array.isArray(details.paths)
            ? details.paths.filter((path): path is string => typeof path === 'string')
            : [],
          clean: false,
        };
      }
      current.error = { code, message: errorMessage };
    }
    if (localCommit !== null) this.state.commits.local = localCommit;
    if (remoteCommit !== null) this.state.commits.remote = remoteCommit;
    this.state.active = false;
    this.state.status = 'NEEDS_USER_ACTION';
    this.state.phase = 'PAUSED';
    this.state.recentError = { code, message: errorMessage };
    this.touchState();
    await this.persist();
    try {
      this.notifier?.notify({
        project: this.project.name,
        taskId: this.state.taskId,
        phase: 'PAUSED',
        suggestion,
        error: { code, message: errorMessage },
        level: 'NEEDS_USER',
      });
    } catch {
      // Notification failures must not hide the Git maintenance diagnostic.
    }
    return result('PAUSED', this.state, errorMessage);
  }

  private async processRetryCurrentStage(): Promise<OrchestratorResult> {
    const recentError = this.state.recentError;
    if (recentError?.code === 'GOVERNANCE_RECONCILIATION_RETRY_CONTEXT_INVALID')
      return result('PAUSED', this.state, '治理一致性重试上下文不完整，请从治理一致性入口重新执行。');
    if (dashboardNeedsNewSol(recentError)) {
      this.clearPendingReconciliationRetry();
      await this.persist();
      return result('PAUSED', this.state, '当前输出不可重试，请让 Sol 重新输出或规划任务（需要新的 Sol 输出）。');
    }

    const reconciliationRetry =
      this.pendingReconciliationInput !== null ||
      this.pendingReconciliationSync !== null ||
      isRetryableGovernanceReconciliationError(recentError);
    if (reconciliationRetry) {
      if (this.pendingReconciliationSync === null && this.pendingReconciliationInput === null)
        return this.pauseForMissingReconciliationContext();
      if (this.state.retryCount >= MAX_RETRIES) return this.pauseForRetryLimit();
      this.state.retryCount += 1;
      this.state.active = true;
      this.state.status = 'RUNNING';
      this.state.recentError = null;
      await this.persist();
      if (this.pendingReconciliationSync !== null) return this.retryPendingReconciliationSync();

      const input = cloneGovernanceReconciliationInput(this.pendingReconciliationInput!);
      await this.setPhase('PARSING', 'RUNNING', null);
      try {
        const completed = await this.processGovernanceReconciliation(input);
        this.clearPendingReconciliationRetry();
        this.state.retryCount = 0;
        await this.persist();
        return reconciliationOrchestratorResult(completed);
      } catch (error) {
        const retryable = isRetryableGovernanceReconciliationError(error);
        if (this.pendingReconciliationSync !== null && retryable) this.pendingReconciliationInput = null;
        else if (retryable) this.pendingReconciliationInput = input;
        else this.clearPendingReconciliationRetry();
        const paused = await this.pauseFor(error, '治理一致性检查已暂停，请检查协议、基线和文件状态后重试。');
        return paused;
      }
    }

    if (this.state.retryCount >= MAX_RETRIES) return this.pauseForRetryLimit();
    this.clearPendingReconciliationRetry();
    this.state.retryCount += 1;
    this.state.active = true;
    this.state.status = 'RUNNING';
    this.beginExecutionSession();
    if (this.pendingCodeSync !== null) {
      this.state.phase = 'SYNCING_CODE';
      this.state.taskId = this.pendingCodeSync.taskId;
      this.activateGraphNode('sync-code', this.pendingCodeSync.taskId);
    } else if (this.state.phase === 'PAUSED' || this.state.phase === 'FAILED') this.state.phase = 'WAITING_FOR_SOL';
    if (this.state.phase === 'WAITING_FOR_SOL') this.resumeWaitingGraph();
    this.state.recentError = null;
    if (this.state.executionRecovery !== null) {
      this.state.executionRecovery = {
        ...this.state.executionRecovery,
        awaitingConfirmation: false,
        updatedAt: this.now().toISOString(),
      };
    }
    this.touchState();
    await this.persist();
    return this.processRound().catch((error) =>
      this.isTerminalFailure(error) ? this.failFor(error) : this.pauseFor(error, '当前阶段执行失败，已暂停。'),
    );
  }

  private async retryPendingReconciliationSync(): Promise<OrchestratorResult> {
    const pending = this.pendingReconciliationSync;
    if (pending === null) return this.pauseForMissingReconciliationContext();
    try {
      await this.assertPendingReconciliationBaseline(pending);
      await this.setPhase('SYNCING_GOVERNANCE', 'RUNNING', null);
      const sync = await this.git.syncGovernance({
        baseline: pending.baseline,
        changeId: `reconciliation-${safeSyncId(pending.runId)}`,
        changedPaths: [...pending.changedPaths],
      });
      this.state.commits = { local: sync.commit, remote: sync.remoteCommit };
      this.state.processedOutputKey = pending.outputKey;
      this.baseline = {
        ...pending.baseline,
        head: sync.commit,
        remoteTip: sync.remoteCommit ?? pending.baseline.remoteTip,
        worktree: [],
      };
      this.clearPendingReconciliationRetry();
      this.state.retryCount = 0;
      this.completeExecutionRound();
      await this.finishIndependentRound(true);
      return result('COMPLETED', this.state, '治理一致性修改已应用、提交并同步。');
    } catch (error) {
      if (!isRetryableGovernanceReconciliationError(error)) this.clearPendingReconciliationRetry();
      const paused = await this.pauseFor(error, '治理一致性同步已暂停，请检查 Git 状态后重试。');
      return paused;
    }
  }

  private async pauseForMissingReconciliationContext(): Promise<OrchestratorResult> {
    this.clearPendingReconciliationRetry();
    return this.pauseForCode(
      'GOVERNANCE_RECONCILIATION_RETRY_CONTEXT_INVALID',
      '治理一致性重试上下文不完整，请从治理一致性入口重新执行。',
      true,
      '请从治理一致性入口重新执行检查，不要直接重试当前阶段。',
    );
  }

  private async assertPendingReconciliationBaseline(pending: PendingReconciliationSync): Promise<void> {
    if (this.targetBranch !== undefined && pending.baseline.branch !== this.targetBranch)
      throw new OrchestratorError('BASELINE_CHANGED', '待恢复治理一致性同步的目标分支与当前 targetBranch 不一致。');
    const current = await this.git.captureBaseline(this.project.localPath, {
      requireClean: false,
      ...(this.targetBranch === undefined ? {} : { expectedBranch: this.targetBranch }),
      ...(this.expectedRemoteUrl === undefined ? {} : { expectedRemoteUrl: this.expectedRemoteUrl }),
    });
    const sameRoot = resolve(current.repositoryRoot).toLowerCase() === resolve(this.project.localPath).toLowerCase();
    const samePendingRoot =
      resolve(current.repositoryRoot).toLowerCase() === resolve(pending.baseline.repositoryRoot).toLowerCase();
    if (
      !sameRoot ||
      !samePendingRoot ||
      current.remoteName !== pending.baseline.remoteName ||
      current.remoteUrl !== pending.baseline.remoteUrl ||
      current.branch !== pending.baseline.branch ||
      current.head !== pending.baseline.head ||
      current.remoteTip !== pending.baseline.remoteTip
    ) {
      throw new OrchestratorError(
        'BASELINE_CHANGED',
        '待恢复治理一致性同步的 repositoryRoot、分支、HEAD 或远端基线已变化，已拒绝 Git sync。',
      );
    }
  }

  private pauseForRetryLimit(): Promise<OrchestratorResult> {
    return this.pauseForCode(
      'RETRY_LIMIT_EXCEEDED',
      `当前阶段已达到最多 ${MAX_RETRIES} 次重试，请检查状态后重新执行。`,
      true,
      '请检查 Git、工作区和 Sol 状态后重新发起治理一致性检查或新一轮任务。',
    );
  }

  private withOrchestrationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.orchestrationTail;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    this.orchestrationTail = previous.then(
      () => gate,
      () => gate,
    );
    return previous.then(operation, operation).finally(release);
  }

  private async processGovernanceReconciliation(
    input: GovernanceReconciliationRunInput,
  ): Promise<GovernanceReconciliationRunResult> {
    const wasActive = this.state.active;
    const outputKey = input.outputKey ?? reconciliationOutputKey(input.solOutput, input.baseline.head);
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
    if (this.baseline === null) this.baseline = { ...input.baseline, worktree: [...input.baseline.worktree] };
    this.prepareRecoveryRecord(outputKey, 'GOVERNANCE_RECONCILIATION', null);

    await this.setPhase('PARSING', 'RUNNING', null);
    const parsed = parseWritingBlocks(input.solOutput);
    this.updateGraphNode('parse-task', {
      summary: `已验证 ${writingBlockCount(parsed)} 个 Writing Block。`,
      details: [`治理一致性：${parsed.governanceReconciliation === null ? '无' : '1'}`],
    });
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
      this.completeExecutionRound();
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
    this.setPendingReconciliationSync({
      baseline: input.baseline,
      runId: applied.runId,
      changedPaths: applied.changedPaths,
      backupPaths: applied.backupPaths,
      outputKey,
    });
    this.pendingReconciliationInput = null;
    await this.persist();
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
    this.clearPendingReconciliationRetry();
    this.state.retryCount = 0;
    this.completeExecutionRound();
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
    this.completeExecutionRound();
    this.state.executionRecovery = null;
    await this.setPhase(wasActive ? 'WAITING_FOR_SOL' : 'IDLE', wasActive ? 'RUNNING' : 'IDLE', null);
  }

  private async processRound(): Promise<OrchestratorResult> {
    if (!this.state.active) return result('IDLE', this.state, '编排器未运行。');
    if (this.pendingReconciliationSync !== null && this.state.phase === 'SYNCING_GOVERNANCE')
      return result('WAITING', this.state, '治理一致性同步上下文已恢复，请重试当前同步。');
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
      if (
        this.state.processedOutputKey === outputKeyFor(observation) ||
        (this.baseline !== null &&
          this.state.processedOutputKey ===
            reconciliationOutputKey(observation.latestAssistantText, this.baseline.head))
      ) {
        const message = '等待 Sol 产生新的未处理输出。';
        await this.enterWaiting(message);
        return result('WAITING', this.state, message);
      }
      this.prepareRecoveryRecord(outputKeyFor(observation), 'UNKNOWN', null);
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

    this.prepareRecoveryRecord(outputKey, 'UNKNOWN', null);

    const userMessage = extractUserMessage(observation.latestAssistantText);
    if (userMessage !== null) {
      this.state.processedOutputKey = outputKey;
      this.state.executionRecovery = null;
      this.markNodesNotApplicable([
        'parse-task',
        'apply-updates',
        'sync-governance',
        'run-luna',
        'sync-code',
        'notify-sol',
      ]);
      await this.enterWaiting('Sol 已发送用户消息，等待用户处理。');
      try {
        this.notifier?.notify({
          project: this.project.name,
          taskId: this.state.taskId,
          phase: 'WAITING_FOR_USER',
          suggestion: userMessage,
          error: new OrchestratorError('SOL_USER_MESSAGE', userMessage),
          level: 'NEEDS_USER',
        });
      } catch {
        // Notification failures must not turn a valid user message into a loop failure.
      }
      return result('WAITING', this.state, 'Sol 已发送用户消息，已通知用户并等待回复。');
    }

    let parsed: ReturnType<typeof parseWritingBlocks>;
    try {
      await this.setPhase('PARSING', 'RUNNING');
      parsed = parseWritingBlocks(observation.latestAssistantText);
      this.updateCurrentRoundRecord({
        status: 'PARSED',
        taskId: parsed.lunaTask?.fields.task_id ?? null,
        taskKind: parsed.lunaTask?.fields.task_kind ?? null,
        taskTitle: parsed.lunaTask?.fields.title ?? null,
        blockTypes: parsed.blocks.map((block) => block.type),
        details: compactDetails([
          `Writing Block：${parsed.blocks.length}`,
          `架构更新：${parsed.architectureFreezes.length}`,
          `治理变更：${parsed.governanceChanges.length}`,
        ]),
      });
      this.updateGraphNode('parse-task', {
        summary: `已验证 ${writingBlockCount(parsed)} 个 Writing Block。`,
        details: [
          `Luna 任务：${parsed.lunaTask?.fields.task_id ?? '无'}`,
          `治理变更：${parsed.governanceChanges.length}`,
        ],
      });
    } catch (error) {
      this.prepareRecoveryRecord(outputKey, 'UNKNOWN', null);
      const repaired = await this.tryAutoRepair(
        error,
        observation,
        outputKey,
        inferAutoRepairOutputType(observation.latestAssistantText),
        null,
      );
      if (repaired !== null) return repaired;
      return this.pauseFor(error, 'Writing Block 协议无效，已拒绝启动 Luna。');
    }
    this.state.autoRepair = null;
    if (parsed.blocked.length > 0) {
      return this.pauseForCode('SOL_BLOCKED', parsed.blocked.map((block) => block.fields.reason).join('\n'), true);
    }
    if (!this.state.active) return result('PAUSED', this.state, '编排器已暂停。');

    this.prepareRecoveryRecord(
      outputKey,
      parsed.governanceReconciliation === null
        ? parsed.lunaTask === null
          ? 'UNKNOWN'
          : 'LUNA_TASK'
        : 'GOVERNANCE_RECONCILIATION',
      parsed.lunaTask?.fields.task_id ?? null,
    );
    if (this.state.executionRecovery?.awaitingConfirmation === true) {
      const message = '检测到该 Sol 输出已有未完成的执行记录，请确认是否从中断节点继续。';
      await this.setPhase('PARSING', 'RUNNING', this.state.taskId);
      return this.pauseForCode(
        'EXECUTION_RECOVERY_CONFIRMATION_REQUIRED',
        message,
        true,
        '请查看解析任务书节点的执行摘要并选择继续。',
      );
    }

    try {
      await this.ensureBaseline();
      this.updateGraphNode('parse-task', {
        summary: `已验证 ${writingBlockCount(parsed)} 个 Writing Block。`,
        details: [
          `Luna 任务：${parsed.lunaTask?.fields.task_id ?? '无'}`,
          `治理变更：${parsed.governanceChanges.length}`,
          `实时基线：${this.baseline?.head ?? '不可用'}`,
        ],
      });
      if (parsed.governanceReconciliation !== null) {
        const reconciliation = await this.processGovernanceReconciliation({
          solOutput: observation.latestAssistantText,
          baseline: this.baseline!,
          outputKey,
        });
        return reconciliationOrchestratorResult(reconciliation);
      }
      this.assertTaskBase(parsed.lunaTask);
      const updated = await this.applyUpdates(parsed.governanceChanges, parsed.architectureFreezes);
      if (!this.state.active) return result('PAUSED', this.state, '编排器已暂停。');
      if (parsed.lunaTask === null) {
        this.state.processedOutputKey = outputKey;
        this.state.executionRecovery = null;
        this.markNodesNotApplicable(['run-luna', 'sync-code', 'notify-sol']);
        this.updateCurrentRoundRecord(
          {
            status: updated ? 'COMPLETED' : 'NO_TASK',
            taskKind: parsed.blocks.length === 0 ? null : parsed.blocks.map((block) => block.type).join(' + '),
            taskTitle:
              parsed.architectureFreezes.length > 0
                ? `架构冻结 × ${parsed.architectureFreezes.length}`
                : parsed.governanceChanges.length > 0
                  ? `治理变更 × ${parsed.governanceChanges.length}`
                  : null,
            details: compactDetails([
              `架构更新：${parsed.architectureFreezes.length}`,
              `治理变更：${parsed.governanceChanges.length}`,
            ]),
          },
          true,
        );
        this.completeExecutionRound();
        await this.setPhase('WAITING_FOR_SOL', 'RUNNING');
        return result(
          'NO_TASK',
          this.state,
          updated ? '治理/架构同步完成，本轮没有 Luna 任务。' : '本轮没有 Luna 任务。',
        );
      }
      const executionTask = updated
        ? taskWithBaseCommit(parsed.lunaTask, this.baseline?.head ?? parsed.lunaTask.fields.base_commit)
        : parsed.lunaTask;
      return await this.runLuna(executionTask, observation, outputKey);
    } catch (error) {
      const repaired = await this.tryAutoRepair(
        error,
        observation,
        outputKey,
        parsed.governanceReconciliation !== null
          ? 'GOVERNANCE_RECONCILIATION'
          : parsed.lunaTask === null
            ? 'UNKNOWN'
            : 'LUNA_TASK',
        parsed.lunaTask?.fields.task_id ?? null,
      );
      if (repaired !== null) return repaired;
      return this.isTerminalFailure(error)
        ? this.failFor(error)
        : this.pauseFor(error, '当前阶段执行失败，已暂停以等待重试或人工处理。');
    }
  }

  private async ensureBaseline(): Promise<void> {
    // A loop may stay alive while a previous Luna result is committed outside
    // the current round. Always recapture at the existing parse-task boundary;
    // never reuse a cached HEAD as the authority for a new task.
    const next = await this.captureConfiguredBaseline();
    await this.adoptBaseline(next);
  }

  private captureConfiguredBaseline(): Promise<Awaited<ReturnType<GitOrchestratorPort['captureBaseline']>>> {
    return this.git.captureBaseline(this.project.localPath, {
      ...(this.targetBranch === undefined ? {} : { expectedBranch: this.targetBranch }),
      ...(this.expectedRemoteUrl === undefined ? {} : { expectedRemoteUrl: this.expectedRemoteUrl }),
    });
  }

  private async adoptBaseline(next: Awaited<ReturnType<GitOrchestratorPort['captureBaseline']>>): Promise<void> {
    const previous = this.baseline;
    this.baseline = next;
    this.state.commits = { local: next.head, remote: next.remoteTip };
    this.invalidateStaleTask(previous, next);
    if (
      this.callbacks.baselineRefreshed !== undefined &&
      (previous === null ||
        previous.head !== next.head ||
        previous.branch !== next.branch ||
        previous.remoteTip !== next.remoteTip ||
        previous.remoteUrl !== next.remoteUrl)
    ) {
      await this.callbacks.baselineRefreshed(next);
    }
  }

  private dashboardBaseline(): DashboardBaselineSnapshot | null {
    if (this.baseline === null) return null;
    return {
      branch: this.baseline.branch,
      localCommit: this.baseline.head,
      remoteCommit: this.baseline.remoteTip,
      remoteUrl: this.baseline.remoteUrl,
      worktreeClean: this.baseline.worktree.length === 0,
    };
  }

  private invalidateStaleTask(
    previous: Awaited<ReturnType<GitOrchestratorPort['captureBaseline']>> | null,
    current: Awaited<ReturnType<GitOrchestratorPort['captureBaseline']>>,
  ): void {
    if (previous === null || previous.head === current.head) return;
    const hasTask = this.state.taskId !== null || this.state.executionRecovery !== null;
    if (!hasTask) return;
    this.staleTask = {
      invalidated: true,
      taskBaseCommit: previous.head,
      currentCommit: current.head,
      message: 'Git 基线已变化，旧任务书需要根据当前提交重新生成。',
    };
  }

  private assertTaskBase(task: LunaTaskBlock | null): void {
    if (task === null || this.baseline === null) return;
    if (task.fields.base_commit !== this.baseline.head) {
      throw new OrchestratorError(
        'BASELINE_CHANGED',
        'Luna task base_commit does not match the captured repository baseline.',
      );
    }
    this.staleTask = emptyStaleTask();
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
    await this.adoptBaseline({
      ...this.baseline,
      head: sync.commit,
      remoteTip: sync.remoteCommit ?? this.baseline.remoteTip,
      worktree: [],
    });
    await this.persist();
    return true;
  }

  private async runLuna(
    task: LunaTaskBlock,
    observation: EdgeSolObservation,
    outputKey: string,
  ): Promise<OrchestratorResult> {
    // Recheck at the existing run-luna boundary immediately before spawning
    // Codex. This closes the race where a commit lands after parse-task.
    await this.ensureBaseline();
    this.assertTaskBase(task);
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
    this.updateCurrentRoundRecord({
      status: 'RUNNING_LUNA',
      taskId: task.fields.task_id,
      taskKind: task.fields.task_kind,
      taskTitle: task.fields.title,
      lunaStatus: 'RUNNING',
      reportPath: task.fields.report_path,
    });
    this.updateGraphNode('run-luna', {
      summary: `Luna 正在执行任务 ${task.fields.task_id}。`,
      details: [`任务：${task.fields.task_id}`, `会话：${handle.sessionId}`, `报告：${task.fields.report_path}`],
    });
    await this.persist();
    const run = await handle.result;
    this.updateCurrentRoundRecord({
      status: run.status === 'COMPLETED' ? 'LUNA_COMPLETED' : 'LUNA_FAILED',
      lunaStatus: run.protocolResult?.status ?? run.status,
      reportSummary: run.protocolResult?.summary ?? null,
      reportPath: run.reportPath || task.fields.report_path,
      testsStatus: testsStatusForRun(run),
      details: compactDetails([
        `任务：${task.fields.task_id}`,
        `Luna：${run.protocolResult?.status ?? run.status}`,
        `测试：${testsStatusForRun(run)}`,
      ]),
    });
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
      if (!isSyncableImplementationFailure(task, run))
        throw new OrchestratorError(run.error?.code ?? run.status, run.error?.message ?? 'Luna 未成功完成任务。');
    }
    this.updateGraphNode('run-luna', {
      summary:
        run.protocolResult?.status === 'FAILED'
          ? `Luna 已完成实现并返回失败验收证据，准备同步 ${task.fields.task_id}。`
          : `Luna 已完成任务 ${task.fields.task_id}。`,
      details: [
        `任务：${task.fields.task_id}`,
        `会话：${run.sessionId}`,
        `报告：${run.reportPath}`,
        ...(run.protocolResult?.status === 'FAILED'
          ? ['Luna 结果：FAILED；报告和代码将先同步，由 Sol/CTO 完成验收判断。']
          : []),
      ],
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
      taskKind: pending.taskKind,
      reportPath: pending.reportPath,
      allowedPaths: pending.allowedPaths,
      protectedPaths: pending.protectedPaths,
    });
    this.state.commits = { local: sync.commit, remote: sync.remoteCommit };
    await this.adoptBaseline({
      ...pending.baseline,
      head: sync.commit,
      remoteTip: sync.remoteCommit ?? pending.baseline.remoteTip,
      worktree: [],
    });
    this.updateGraphNode('sync-code', {
      summary: `代码同步完成：${sync.commit}。`,
      details: [
        `任务：${pending.taskId}`,
        `报告：${pending.reportPath}`,
        `任务类型：${pending.taskKind}`,
        ...(pending.resultStatus === 'FAILED' ? ['Luna 结果：FAILED（报告和代码已同步，交由 Sol/CTO 验收）。'] : []),
        `测试：${pending.testsStatus === 'PASSED' ? '已通过' : pending.testsStatus === 'FAILED' ? '未通过（证据已同步）' : '未运行'}`,
        ...(sync.scopeDriftPaths === undefined || sync.scopeDriftPaths.length === 0
          ? []
          : [`超出任务预期范围但已允许同步：${sync.scopeDriftPaths.join('、')}`]),
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
      const testFailureNotice = pending.testsStatus === 'FAILED';
      const testNotRunNotice = pending.testsStatus === 'NOT_RUN';
      const implementationFailureNotice = pending.taskKind === 'IMPLEMENTATION' && pending.resultStatus === 'FAILED';
      const evidenceNotice = implementationFailureNotice || testFailureNotice || testNotRunNotice;
      await this.sol.sendMessage({
        observation,
        text: evidenceNotice
          ? `LUNA_RESULT task_id=${pending.taskId}\n${implementationFailureNotice ? '代码和任务报告已同步。\nLuna 结果为 FAILED，表示报告中仍有实现或验收阻塞；请由 Sol/CTO 根据报告完成验收判断。' : testFailureNotice ? '代码和任务报告已同步，但测试未通过。' : '代码和任务报告已同步，但测试未运行。'}\n任务类型：${pending.taskKind}\n测试状态：${pending.testsStatus}\n报告：${pending.reportPath}\n最新提交：${sync.commit}${scopeDriftNotice(sync.scopeDriftPaths)}\n请根据报告完成验收并规划后续任务。`
          : `LUNA_RESULT task_id=${pending.taskId}\n最新提交 ${sync.commit} 完成，可以开始验收。${scopeDriftNotice(sync.scopeDriftPaths)}`,
      });
      this.updateGraphNode('notify-sol', {
        summary: evidenceNotice
          ? `已通知 Sol 代码和证据已同步${implementationFailureNotice ? '，Luna 结果为 FAILED' : testFailureNotice ? '，但测试未通过' : '，但测试未运行'}。`
          : '已通知 Sol 可以开始验收。',
        details: [
          `任务：${pending.taskId}`,
          ...(implementationFailureNotice
            ? ['Luna 返回 FAILED，但实现报告和代码已同步；由 Sol/CTO 决定是否接受或规划修复。']
            : []),
          ...(testFailureNotice ? ['任务已完成，但测试未通过；测试结果交由 Sol/CTO 验收。'] : []),
          ...(testNotRunNotice ? ['任务已完成，但没有测试执行证据。'] : []),
          ...commitDetails(sync.commit, sync.remoteCommit),
        ],
      });
    } else {
      this.markNodesNotApplicable(['notify-sol']);
    }
    this.state.processedOutputKey = pending.outputKey;
    this.state.luna = {
      status: pending.resultStatus === 'FAILED' ? 'FAILED' : 'COMPLETED',
      sessionId: pending.sessionId,
    };
    this.state.pendingCodeSync = null;
    this.pendingCodeSync = null;
    this.clearPendingReconciliationRetry();
    this.state.executionRecovery = null;
    this.state.retryCount = 0;
    this.updateCurrentRoundRecord(
      {
        status: 'COMPLETED',
        lunaStatus: pending.resultStatus ?? 'COMPLETED',
        taskId: pending.taskId,
        taskKind: pending.taskKind,
        reportPath: pending.reportPath,
        testsStatus: pending.testsStatus,
        details: compactDetails([
          `提交：${sync.commit}`,
          `远端：${sync.remoteCommit ?? '未确认'}`,
          `测试：${pending.testsStatus}`,
        ]),
      },
      true,
    );
    this.completeExecutionRound();
    await this.setPhase('WAITING_FOR_SOL', 'RUNNING', null);
    return result('COMPLETED', this.state, `任务 ${pending.taskId} 已完成并同步。`);
  }

  private async tryAutoRepair(
    error: unknown,
    observation: EdgeSolObservation,
    outputKey: string,
    outputType: AutoRepairState['outputType'],
    taskId: string | null,
  ): Promise<OrchestratorResult | null> {
    const code = error instanceof OrchestratorError ? error.code : errorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    if (!isAutoRepairableError(code, this.state.phase)) return null;
    if (this.sol === undefined) return null;

    const previous = this.state.autoRepair;
    if (previous !== null && previous.errorCode === code) return null;
    const attempt = previous === null ? 1 : previous.attempt + 1;
    if (attempt > MAX_AUTO_REPAIR_ATTEMPTS_PER_ROUND) {
      this.state.autoRepair = {
        ...(previous ?? {
          errorCode: code,
          errorMessage: message,
          outputKey,
          outputType,
          taskId,
          roundId: this.state.loopGraph.roundId,
          attempt: MAX_AUTO_REPAIR_ATTEMPTS_PER_ROUND,
          maxAttempts: MAX_AUTO_REPAIR_ATTEMPTS_PER_ROUND,
          sentAt: null,
          updatedAt: this.now().toISOString(),
        }),
        status: 'EXHAUSTED',
        updatedAt: this.now().toISOString(),
      };
      return null;
    }

    const currentBaseline = this.baseline?.head ?? null;
    let prompt: string;
    try {
      prompt = compileSolAutoRepairPrompt({
        errorCode: code,
        errorMessage: message,
        outputType,
        taskId,
        currentBaseline,
        attempt,
        maxAttempts: MAX_AUTO_REPAIR_ATTEMPTS_PER_ROUND,
      });
    } catch (promptError) {
      return this.pauseFor(promptError, '自动修复提示词无法安全生成，请人工处理当前 Sol 输出。');
    }

    const now = this.now().toISOString();
    this.state.autoRepair = {
      errorCode: code,
      errorMessage: message,
      outputKey,
      outputType,
      taskId,
      roundId: this.state.loopGraph.roundId,
      attempt,
      maxAttempts: MAX_AUTO_REPAIR_ATTEMPTS_PER_ROUND,
      status: 'PENDING',
      sentAt: null,
      updatedAt: now,
    };
    this.updateGraphNode('parse-task', {
      summary: `检测到 ${code}，准备自动修复。`,
      details: [`错误：${code}`, message, `自动修复：第 ${attempt}/${MAX_AUTO_REPAIR_ATTEMPTS_PER_ROUND} 次`],
    });
    this.activateGraphNode('parse-task', taskId);
    this.touchState();
    await this.persist();

    try {
      await this.sol.sendMessage({ observation, text: prompt });
    } catch (sendError) {
      this.state.autoRepair = { ...this.state.autoRepair, status: 'EXHAUSTED', updatedAt: this.now().toISOString() };
      await this.persist();
      return this.pauseForCode(
        'SOL_AUTO_REPAIR_SEND_FAILED',
        sendError instanceof Error ? sendError.message : String(sendError),
        true,
        '自动修复提示词未能确认发送，请检查专用 Edge 会话后重试。',
      );
    }

    this.state.autoRepair = {
      ...this.state.autoRepair,
      status: 'WAITING_FOR_SOL',
      sentAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    };
    this.state.processedOutputKey = outputKey;
    this.state.executionRecovery = null;
    this.state.recentError = null;
    await this.setPhase('WAITING_FOR_SOL', 'RUNNING', taskId);
    this.updateGraphNode('wait-sol', {
      summary: '正在等待 Sol 输出修复后的 Writing Block。',
      details: [
        `修复错误：${code}`,
        `自动修复：第 ${attempt}/${MAX_AUTO_REPAIR_ATTEMPTS_PER_ROUND} 次`,
        '已发送修复提示词，未执行 Luna。',
      ],
    });
    await this.persist();
    return result('WAITING', this.state, '已向 Sol 发送自动修复提示词，正在等待新的 Writing Block。');
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
    const interruptedPhase = this.state.phase;
    const interruptedNodeId = this.state.loopGraph.currentNodeId;
    this.closeExecutionSession('BLOCKED');
    this.state.active = false;
    this.state.status = needsUser ? 'NEEDS_USER_ACTION' : 'PAUSED';
    this.state.phase = 'PAUSED';
    this.state.recentError = { code, message };
    this.markRecoveryInterrupted(interruptedPhase, interruptedNodeId, { code, message });
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
    const interruptedPhase = this.state.phase;
    const interruptedNodeId = this.state.loopGraph.currentNodeId;
    this.closeExecutionSession('FAILED');
    this.state.active = false;
    this.state.status = 'FAILED';
    this.state.phase = 'FAILED';
    this.state.recentError = { code, message };
    this.markRecoveryInterrupted(interruptedPhase, interruptedNodeId, { code, message });
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

  private dashboardExecutionMetrics() {
    const active = this.state.executionMetrics.activeSession;
    const source = active ?? this.state.executionMetrics.lastSession;
    if (source === null) {
      return {
        current: null,
        totalElapsedMs: this.state.executionMetrics.totalElapsedMs,
        totalRoundsStarted: this.state.executionMetrics.totalRoundsStarted,
        totalRoundsCompleted: this.state.executionMetrics.totalRoundsCompleted,
        sessionCount: this.state.executionMetrics.history.length,
      };
    }
    const elapsedMs = active === null ? source.elapsedMs : this.currentSessionElapsed(active);
    return {
      current: {
        startedAt: source.startedAt,
        endedAt: active === null ? source.endedAt : null,
        elapsedMs,
        roundsStarted: source.roundsStarted,
        roundsCompleted: source.roundsCompleted,
        endReason: active === null ? source.endReason : null,
        active: active !== null,
      },
      totalElapsedMs: this.state.executionMetrics.totalElapsedMs + (active === null ? 0 : elapsedMs),
      totalRoundsStarted: this.state.executionMetrics.totalRoundsStarted + (active === null ? 0 : active.roundsStarted),
      totalRoundsCompleted:
        this.state.executionMetrics.totalRoundsCompleted + (active === null ? 0 : active.roundsCompleted),
      sessionCount: this.state.executionMetrics.history.length + (active === null ? 0 : 1),
    };
  }

  private currentSessionElapsed(session: ExecutionSessionRecord): number {
    if (session.activeSince === null) return session.elapsedMs;
    const activeSince = Date.parse(session.activeSince);
    return Number.isNaN(activeSince)
      ? session.elapsedMs
      : session.elapsedMs + Math.max(0, this.now().getTime() - activeSince);
  }

  private beginExecutionSession(): void {
    if (this.state.executionMetrics.activeSession !== null) return;
    const timestamp = this.now().toISOString();
    this.state.executionMetrics.activeSession = {
      startedAt: timestamp,
      endedAt: null,
      activeSince: timestamp,
      elapsedMs: 0,
      roundsStarted: 0,
      roundsCompleted: 0,
      currentRoundId: null,
      endReason: null,
    };
  }

  private closeExecutionSession(reason: ExecutionSessionEndReason): void {
    const session = this.state.executionMetrics.activeSession;
    if (session === null) return;
    const endedAt = this.now();
    const closed: ExecutionSessionRecord = {
      ...session,
      endedAt: endedAt.toISOString(),
      activeSince: null,
      elapsedMs: this.currentSessionElapsed(session),
      currentRoundId: null,
      endReason: reason,
    };
    this.state.executionMetrics = {
      ...this.state.executionMetrics,
      activeSession: null,
      lastSession: closed,
      history: [...this.state.executionMetrics.history, closed].slice(-100),
      totalElapsedMs: this.state.executionMetrics.totalElapsedMs + closed.elapsedMs,
      totalRoundsStarted: this.state.executionMetrics.totalRoundsStarted + closed.roundsStarted,
      totalRoundsCompleted: this.state.executionMetrics.totalRoundsCompleted + closed.roundsCompleted,
    };
  }

  private startExecutionRound(roundId: string | null): void {
    const session = this.state.executionMetrics.activeSession;
    if (session === null || roundId === null) return;
    if (session.currentRoundId === roundId) return;
    this.state.executionMetrics.activeSession = {
      ...session,
      roundsStarted: session.roundsStarted + 1,
      currentRoundId: roundId,
    };
  }

  private completeExecutionRound(): void {
    const session = this.state.executionMetrics.activeSession;
    if (session === null || session.currentRoundId === null) return;
    this.state.executionMetrics.activeSession = {
      ...session,
      roundsCompleted: session.roundsCompleted + 1,
      currentRoundId: null,
    };
  }

  private updateCurrentRoundRecord(update: Partial<DashboardRoundRecord>, complete = false): void {
    const roundId = this.state.loopGraph.roundId;
    if (roundId === null) return;
    const index = this.state.roundHistory.findIndex((record) => record.roundId === roundId);
    if (index < 0) return;
    const current = this.state.roundHistory[index]!;
    const now = this.now().toISOString();
    const completedAt = complete ? now : (update.completedAt ?? current.completedAt);
    const durationStart = Date.parse(current.startedAt);
    const durationEnd = Date.parse(completedAt ?? now);
    const elapsedMs =
      update.elapsedMs ??
      (Number.isNaN(durationStart) || Number.isNaN(durationEnd)
        ? current.elapsedMs
        : Math.max(current.elapsedMs, durationEnd - durationStart));
    this.state.roundHistory[index] = {
      ...current,
      ...update,
      blockTypes: update.blockTypes === undefined ? [...current.blockTypes] : [...update.blockTypes],
      details: update.details === undefined ? [...current.details] : [...update.details],
      completedAt,
      elapsedMs,
    };
  }

  private currentRoundRecord(): DashboardRoundRecord | null {
    const roundId = this.state.loopGraph.roundId;
    if (roundId === null) return null;
    return this.state.roundHistory.find((record) => record.roundId === roundId) ?? null;
  }

  private async beginRound(): Promise<void> {
    this.clearPendingReconciliationRetry();
    const pendingAutoRepair = this.state.autoRepair?.status === 'WAITING_FOR_SOL' ? this.state.autoRepair : null;
    this.state.autoRepair = pendingAutoRepair;
    this.state.retryCount = 0;
    const now = this.now().toISOString();
    const roundId = `round-${this.state.revision + 1}-${this.now().getTime()}`;
    this.state.loopGraph = createLoopGraph(roundId, now);
    const previousSequence = this.state.roundHistory.at(-1)?.sequence ?? 0;
    this.state.roundHistory = [
      ...this.state.roundHistory,
      {
        roundId,
        sequence: previousSequence + 1,
        status: 'RUNNING',
        taskId: null,
        taskKind: null,
        taskTitle: null,
        lunaStatus: null,
        reportSummary: null,
        reportPath: null,
        testsStatus: null,
        blockTypes: [],
        details: [],
        startedAt: now,
        completedAt: null,
        elapsedMs: 0,
      },
    ].slice(-DASHBOARD_ROUND_HISTORY_LIMIT);
    this.startExecutionRound(this.state.loopGraph.roundId);
    await this.setPhase('READING_SOL', 'RUNNING', null);
  }

  private migrateLegacyWrongEntrypointState(): void {
    if (
      this.state.executionRecovery !== null ||
      this.state.recentError?.code !== 'GOVERNANCE_RECONCILIATION_WRONG_ENTRYPOINT'
    )
      return;
    const legacy = this.legacyRecoveryRecord();
    if (legacy === null) return;
    this.state.executionRecovery = legacy;
    this.state.recentError = {
      code: 'EXECUTION_RECOVERY_PENDING',
      message: '已迁移旧版治理一致性入口阻塞记录，等待读取最新 Sol 输出后确认恢复。',
    };
  }

  private prepareRecoveryRecord(
    outputKey: string,
    outputType: ExecutionRecoveryRecord['outputType'],
    taskId: string | null,
  ): void {
    const existing = this.state.executionRecovery;
    if (existing !== null && (existing.outputKey === outputKey || existing.outputKey === LEGACY_RECOVERY_OUTPUT_KEY)) {
      this.state.executionRecovery = {
        ...existing,
        outputKey,
        outputType: existing.outputType === 'UNKNOWN' ? outputType : existing.outputType,
        taskId: taskId ?? existing.taskId,
        updatedAt: this.now().toISOString(),
      };
      return;
    }

    const legacy = this.legacyRecoveryRecord();
    const now = this.now().toISOString();
    this.state.executionRecovery = {
      outputKey,
      outputType,
      taskId,
      roundId: this.state.loopGraph.roundId,
      startedAt: legacy?.startedAt ?? now,
      updatedAt: now,
      interruptedPhase: legacy?.interruptedPhase ?? this.state.phase,
      interruptedNodeId: legacy?.interruptedNodeId ?? null,
      completedNodeIds: legacy?.completedNodeIds ?? [],
      error: legacy?.error ?? null,
      awaitingConfirmation: legacy !== null,
    };
  }

  private legacyRecoveryRecord(): ExecutionRecoveryRecord | null {
    const interruptedNode = this.state.loopGraph.nodes.find(
      (node) => node.state === 'RECOVERABLE_BLOCKED' || node.state === 'NEEDS_USER_ACTION',
    );
    if (interruptedNode === undefined || this.state.recentError === null || this.state.loopGraph.roundId === null)
      return null;
    return {
      outputKey: LEGACY_RECOVERY_OUTPUT_KEY,
      outputType: 'UNKNOWN',
      taskId: this.state.taskId,
      roundId: this.state.loopGraph.roundId,
      startedAt: interruptedNode.startedAt ?? this.state.updatedAt,
      updatedAt: this.state.updatedAt,
      interruptedPhase: phaseForNode(interruptedNode.id),
      interruptedNodeId: interruptedNode.id,
      completedNodeIds: this.state.loopGraph.nodes.filter((node) => node.state === 'COMPLETED').map((node) => node.id),
      error: { ...this.state.recentError },
      awaitingConfirmation: true,
    };
  }

  private markRecoveryInterrupted(
    interruptedPhase: OrchestratorState['phase'],
    interruptedNodeId: LoopGraphNodeId | null,
    error: { code: string; message: string },
  ): void {
    const recovery = this.state.executionRecovery;
    if (recovery === null) return;
    this.state.executionRecovery = {
      ...recovery,
      updatedAt: this.now().toISOString(),
      interruptedPhase,
      interruptedNodeId,
      completedNodeIds: this.state.loopGraph.nodes.filter((node) => node.state === 'COMPLETED').map((node) => node.id),
      error: { ...error },
      awaitingConfirmation: true,
    };
  }

  private recoveryDetails(): string[] {
    const recovery = this.state.executionRecovery;
    if (recovery === null) return [];
    return compactDetails([
      `执行类型：${recovery.outputType}`,
      recovery.taskId === null ? '' : `任务：${recovery.taskId}`,
      `已完成节点：${recovery.completedNodeIds.join('、') || '无'}`,
      `中断节点：${recovery.interruptedNodeId ?? '未知'}`,
      recovery.error === null ? '' : `中断原因：${recovery.error.code}：${recovery.error.message}`,
      '请确认是否从中断节点继续。',
    ]);
  }

  private async enterWaiting(message: string): Promise<void> {
    this.completeExecutionRound();
    await this.setPhase('WAITING_FOR_SOL', 'RUNNING', null);
    this.updateGraphNode('wait-sol', { summary: message, details: [] });
    this.touchState();
    await this.persist();
  }

  private setPendingCodeSync(pending: PendingCodeSync): void {
    this.pendingCodeSync = pending;
    this.state.pendingCodeSync = clonePendingCodeSync(pending);
  }

  private setPendingReconciliationSync(pending: PendingReconciliationSync): void {
    this.pendingReconciliationSync = clonePendingReconciliationSync(pending);
    this.state.pendingReconciliationSync = clonePendingReconciliationSync(pending);
  }

  private clearPendingReconciliationRetry(): void {
    this.pendingReconciliationInput = null;
    this.pendingReconciliationSync = null;
    this.state.pendingReconciliationSync = null;
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
    active.summary =
      code === 'EXECUTION_RECOVERY_CONFIRMATION_REQUIRED'
        ? '检测到上次未完成的执行，等待确认恢复。'
        : state === 'NEEDS_USER_ACTION'
          ? '需要用户处理后继续。'
          : '可恢复错误，等待重试。';
    active.details = compactDetails([`错误：${code}`, message, ...this.recoveryDetails()]);
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
    name: 'rebind' | 'governanceConsistencyCheck' | 'stageGoalReview' | 'openEdge' | 'openProject',
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
  const sanitized = sanitizeDashboardSnapshot({
    loopGraph: state.loopGraph,
    recentError: state.recentError,
    roundHistory: state.roundHistory,
  });
  return {
    ...state,
    architectureRevisions: [...state.architectureRevisions],
    luna: { ...state.luna },
    commits: { ...state.commits },
    recentError: sanitized.recentError === null ? null : { ...sanitized.recentError },
    roundHistory: sanitized.roundHistory.map((record) => ({
      ...record,
      blockTypes: [...record.blockTypes],
      details: [...record.details],
    })),
    loopGraph: sanitized.loopGraph,
    pendingCodeSync: clonePendingCodeSync(state.pendingCodeSync),
    pendingReconciliationSync: clonePendingReconciliationSync(state.pendingReconciliationSync),
    autoRepair: cloneAutoRepair(state.autoRepair),
    executionMetrics: cloneExecutionMetrics(state.executionMetrics),
    executionRecovery: cloneExecutionRecovery(state.executionRecovery),
    ...(state.manualGitOperation === undefined
      ? {}
      : {
          manualGitOperation: {
            ...state.manualGitOperation,
            result: state.manualGitOperation.result === null ? null : { ...state.manualGitOperation.result },
            error: state.manualGitOperation.error === null ? null : { ...state.manualGitOperation.error },
          },
        }),
    activeSolSession: state.activeSolSession === null ? null : { ...state.activeSolSession },
  };
}

function createDefaultExecutionMetrics(): ExecutionMetricsState {
  return {
    activeSession: null,
    lastSession: null,
    history: [],
    totalElapsedMs: 0,
    totalRoundsStarted: 0,
    totalRoundsCompleted: 0,
  };
}

function cloneExecutionMetrics(value: unknown): ExecutionMetricsState {
  const normalized = normalizeExecutionMetrics(value);
  return {
    ...normalized,
    activeSession: normalized.activeSession === null ? null : { ...normalized.activeSession },
    lastSession: normalized.lastSession === null ? null : { ...normalized.lastSession },
    history: normalized.history.map((session) => ({ ...session })),
  };
}

function normalizeExecutionMetrics(value: unknown): ExecutionMetricsState {
  if (!isRecord(value)) return createDefaultExecutionMetrics();
  const activeSession = normalizeExecutionSession(value.activeSession, true);
  const lastSession = normalizeExecutionSession(value.lastSession, false);
  const history = Array.isArray(value.history)
    ? value.history
        .map((item) => normalizeExecutionSession(item, false))
        .filter((item): item is ExecutionSessionRecord => item !== null)
        .slice(-100)
    : [];
  return {
    activeSession,
    lastSession,
    history,
    totalElapsedMs: boundedInteger(value.totalElapsedMs, 0, Number.MAX_SAFE_INTEGER),
    totalRoundsStarted: boundedInteger(value.totalRoundsStarted, 0, Number.MAX_SAFE_INTEGER),
    totalRoundsCompleted: boundedInteger(value.totalRoundsCompleted, 0, Number.MAX_SAFE_INTEGER),
  };
}

function normalizeExecutionSession(value: unknown, active: boolean): ExecutionSessionRecord | null {
  if (!isRecord(value)) return null;
  const startedAt = boundedPendingText(value.startedAt, 64);
  if (startedAt === null) return null;
  const endedAt = value.endedAt === null || value.endedAt === undefined ? null : boundedPendingText(value.endedAt, 64);
  const activeSince =
    value.activeSince === null || value.activeSince === undefined ? null : boundedPendingText(value.activeSince, 64);
  const endReason = isExecutionSessionEndReason(value.endReason) ? value.endReason : null;
  return {
    startedAt,
    endedAt: active ? null : endedAt,
    activeSince: active ? (activeSince ?? startedAt) : null,
    elapsedMs: boundedInteger(value.elapsedMs, 0, Number.MAX_SAFE_INTEGER),
    roundsStarted: boundedInteger(value.roundsStarted, 0, Number.MAX_SAFE_INTEGER),
    roundsCompleted: boundedInteger(value.roundsCompleted, 0, Number.MAX_SAFE_INTEGER),
    currentRoundId: active ? boundedPendingText(value.currentRoundId, 256) : null,
    endReason: active ? null : endReason,
  };
}

function isExecutionSessionEndReason(value: unknown): value is ExecutionSessionEndReason {
  return (
    value === 'BLOCKED' || value === 'FAILED' || value === 'PAUSED' || value === 'RESTARTED' || value === 'COMPLETED'
  );
}

function cloneAutoRepair(value: unknown): AutoRepairState | null {
  const repair = normalizeAutoRepair(value);
  return repair === null ? null : { ...repair };
}

function normalizeAutoRepair(value: unknown): AutoRepairState | null {
  if (!isRecord(value)) return null;
  const errorCode = boundedPendingText(value.errorCode, 128);
  const errorMessage = boundedPendingText(value.errorMessage, 2048);
  const outputKey = boundedPendingText(value.outputKey, 128);
  const outputType = value.outputType;
  const taskId = boundedPendingText(value.taskId, 256);
  const roundId = boundedPendingText(value.roundId, 256);
  const attempt = boundedInteger(value.attempt, 0, MAX_AUTO_REPAIR_ATTEMPTS_PER_ROUND);
  const maxAttempts = boundedInteger(value.maxAttempts, 1, MAX_AUTO_REPAIR_ATTEMPTS_PER_ROUND);
  const status = value.status;
  const sentAt = value.sentAt === null ? null : boundedPendingText(value.sentAt, 64);
  const updatedAt = boundedPendingText(value.updatedAt, 64);
  if (
    errorCode === null ||
    errorMessage === null ||
    outputKey === null ||
    updatedAt === null ||
    !isAutoRepairOutputType(outputType) ||
    !isAutoRepairStatus(status)
  )
    return null;
  return {
    errorCode,
    errorMessage,
    outputKey,
    outputType,
    taskId,
    roundId,
    attempt,
    maxAttempts,
    status,
    sentAt,
    updatedAt,
  };
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function cloneExecutionRecovery(value: unknown): ExecutionRecoveryRecord | null {
  const recovery = normalizeExecutionRecovery(value);
  if (recovery === null) return null;
  return {
    ...recovery,
    completedNodeIds: [...recovery.completedNodeIds],
    error: recovery.error === null ? null : { ...recovery.error },
  };
}

function normalizeExecutionRecovery(value: unknown): ExecutionRecoveryRecord | null {
  if (!isRecord(value)) return null;
  const outputKey = boundedPendingText(value.outputKey, 128);
  const outputType = value.outputType;
  const taskId = boundedPendingText(value.taskId, 256);
  const roundId = boundedPendingText(value.roundId, 256);
  const startedAt = boundedPendingText(value.startedAt, 64);
  const updatedAt = boundedPendingText(value.updatedAt, 64);
  const interruptedPhase = value.interruptedPhase;
  const migratedInterruptedNodeId = value.interruptedNodeId === 'auto-repair' ? 'parse-task' : value.interruptedNodeId;
  const interruptedNodeId = isLoopGraphNodeId(migratedInterruptedNodeId) ? migratedInterruptedNodeId : null;
  const completedNodeIds = Array.isArray(value.completedNodeIds)
    ? value.completedNodeIds.filter(isLoopGraphNodeId).slice(0, LOOP_GRAPH_NODE_DEFINITIONS.length)
    : [];
  const error = normalizeRecoveryError(value.error);
  if (outputKey === null || !isRecoveryOutputType(outputType) || startedAt === null || updatedAt === null) return null;
  if (!isOrchestratorPhase(interruptedPhase) || typeof value.awaitingConfirmation !== 'boolean') return null;
  return {
    outputKey,
    outputType,
    taskId,
    roundId,
    startedAt,
    updatedAt,
    interruptedPhase,
    interruptedNodeId,
    completedNodeIds,
    error,
    awaitingConfirmation: value.awaitingConfirmation,
  };
}

function normalizeRecoveryError(value: unknown): { code: string; message: string } | null {
  if (!isRecord(value)) return null;
  const code = boundedPendingText(value.code, 128);
  const message = boundedPendingText(value.message, 2048);
  return code === null || message === null ? null : { code, message };
}

function normalizeState(state: OrchestratorState): OrchestratorState {
  const source = state as Partial<OrchestratorState>;
  return {
    ...DEFAULT_STATE,
    ...source,
    retryCount: normalizeRetryCount(source.retryCount),
    architectureRevisions: Array.isArray(source.architectureRevisions) ? [...source.architectureRevisions] : [],
    luna: { ...DEFAULT_STATE.luna, ...source.luna },
    commits: { ...DEFAULT_STATE.commits, ...source.commits },
    recentError: source.recentError === null || source.recentError === undefined ? null : { ...source.recentError },
    loopGraph: sanitizeDashboardSnapshot(source.loopGraph === undefined ? {} : { loopGraph: source.loopGraph })
      .loopGraph,
    pendingCodeSync: normalizePendingCodeSync(source.pendingCodeSync),
    pendingReconciliationSync: normalizePendingReconciliationSync(source.pendingReconciliationSync),
    autoRepair: normalizeAutoRepair(source.autoRepair),
    executionMetrics: normalizeExecutionMetrics(source.executionMetrics),
    roundHistory: sanitizeDashboardSnapshot({ roundHistory: source.roundHistory }).roundHistory,
    executionRecovery: normalizeExecutionRecovery(source.executionRecovery),
    activeSolSession:
      source.activeSolSession === null || source.activeSolSession === undefined ? null : { ...source.activeSolSession },
  };
}

function testsStatusForRun(run: CodexRunResult): LunaTestStatus {
  const protocol = run.protocolResult;
  if (protocol === undefined) return run.status === 'COMPLETED' ? 'PASSED' : 'NOT_RUN';
  if (protocol.testsStatus !== undefined) return protocol.testsStatus;
  if (protocol.tests.some((test) => test.status === 'FAILED')) return 'FAILED';
  if (protocol.tests.length === 0 || protocol.tests.some((test) => test.status === 'NOT_RUN')) return 'NOT_RUN';
  return 'PASSED';
}

function isSyncableImplementationFailure(task: LunaTaskBlock, run: CodexRunResult): boolean {
  return (
    task.fields.task_kind === 'IMPLEMENTATION' &&
    run.status === 'FAILED' &&
    run.protocolResult?.status === 'FAILED' &&
    run.error === undefined &&
    run.diagnostics.length === 0
  );
}

function createPendingCodeSync(
  task: LunaTaskBlock,
  run: CodexRunResult,
  baseline: PendingCodeSyncState['baseline'],
  outputKey: string,
): PendingCodeSync {
  const testsStatus = testsStatusForRun(run);
  return {
    taskId: task.fields.task_id,
    taskKind: task.fields.task_kind,
    resultStatus: run.protocolResult?.status === 'FAILED' ? 'FAILED' : 'COMPLETED',
    reportPath: task.fields.report_path,
    allowedPaths: [...task.fields.scope],
    protectedPaths: [...task.fields.out_of_scope],
    baseline,
    testsStatus,
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

function cloneGovernanceReconciliationInput(input: GovernanceReconciliationRunInput): GovernanceReconciliationRunInput {
  return {
    solOutput: input.solOutput,
    baseline: { ...input.baseline, worktree: [...input.baseline.worktree] },
    ...(input.outputKey === undefined ? {} : { outputKey: input.outputKey }),
  };
}

function clonePendingReconciliationSync(value: unknown): PendingReconciliationSync | null {
  const pending = normalizePendingReconciliationSync(value);
  if (pending === null) return null;
  return {
    ...pending,
    changedPaths: [...pending.changedPaths],
    backupPaths: [...pending.backupPaths],
    baseline: { ...pending.baseline, worktree: [...pending.baseline.worktree] },
  };
}

function normalizePendingReconciliationSync(value: unknown): PendingReconciliationSync | null {
  if (!isRecord(value)) return null;
  const runId = boundedPendingText(value.runId, 256);
  const outputKey = boundedPendingText(value.outputKey, 128);
  const baseline = normalizePendingBaseline(value.baseline);
  const changedPaths = normalizeRequiredPendingStringArray(value.changedPaths, 512);
  const backupPaths = normalizeRequiredPendingStringArray(value.backupPaths, 512);
  if (runId === null || outputKey === null || baseline === null || changedPaths === null || backupPaths === null)
    return null;
  return { baseline, runId, outputKey, changedPaths, backupPaths };
}

function normalizeRequiredPendingStringArray(value: unknown, limit: number): string[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  const normalized = normalizePendingStringArray(value, limit);
  return normalized.length === value.length ? normalized : null;
}

function normalizeRetryCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_RETRIES ? value : 0;
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
  const taskKind = value.taskKind === 'TEST' || value.taskKind === 'IMPLEMENTATION' ? value.taskKind : 'IMPLEMENTATION';
  const resultStatus = value.resultStatus === 'FAILED' ? 'FAILED' : 'COMPLETED';
  const testsStatus: LunaTestStatus =
    value.testsStatus === 'PASSED' || value.testsStatus === 'FAILED' || value.testsStatus === 'NOT_RUN'
      ? value.testsStatus
      : value.testsPassed === true
        ? 'PASSED'
        : value.testsPassed === false
          ? 'FAILED'
          : 'NOT_RUN';
  return {
    taskId,
    taskKind,
    resultStatus,
    reportPath,
    allowedPaths: normalizePendingStringArray(value.allowedPaths, 512),
    protectedPaths: normalizePendingStringArray(value.protectedPaths, 512),
    baseline,
    testsStatus,
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

function phaseForNode(nodeId: LoopGraphNodeId): OrchestratorState['phase'] {
  switch (nodeId) {
    case 'read-sol':
      return 'READING_SOL';
    case 'parse-task':
      return 'PARSING';
    case 'apply-updates':
      return 'APPLYING_UPDATES';
    case 'sync-governance':
      return 'SYNCING_GOVERNANCE';
    case 'run-luna':
      return 'RUNNING_LUNA';
    case 'sync-code':
      return 'SYNCING_CODE';
    case 'notify-sol':
      return 'NOTIFYING_SOL';
    case 'wait-sol':
      return 'WAITING_FOR_SOL';
  }
}

function isOrchestratorPhase(value: unknown): value is OrchestratorState['phase'] {
  return (
    value === 'IDLE' ||
    value === 'READING_SOL' ||
    value === 'PARSING' ||
    value === 'APPLYING_UPDATES' ||
    value === 'SYNCING_GOVERNANCE' ||
    value === 'RUNNING_LUNA' ||
    value === 'SYNCING_CODE' ||
    value === 'NOTIFYING_SOL' ||
    value === 'WAITING_FOR_SOL' ||
    value === 'PAUSED' ||
    value === 'FAILED'
  );
}

function isRecoveryOutputType(value: unknown): value is ExecutionRecoveryRecord['outputType'] {
  return (
    value === 'UNKNOWN' || value === 'LUNA_TASK' || value === 'GOVERNANCE_RECONCILIATION' || value === 'USER_MESSAGE'
  );
}

function isAutoRepairOutputType(value: unknown): value is AutoRepairState['outputType'] {
  return value === 'UNKNOWN' || value === 'LUNA_TASK' || value === 'GOVERNANCE_RECONCILIATION';
}

function isAutoRepairStatus(value: unknown): value is AutoRepairStatus {
  return (
    value === 'PENDING' ||
    value === 'SENT' ||
    value === 'WAITING_FOR_SOL' ||
    value === 'SUCCEEDED' ||
    value === 'EXHAUSTED'
  );
}

function isLoopGraphNodeId(value: unknown): value is LoopGraphNodeId {
  return LOOP_GRAPH_NODE_DEFINITIONS.some((definition) => definition.id === value);
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

function scopeDriftNotice(paths: string[] | undefined): string {
  return paths === undefined || paths.length === 0
    ? ''
    : `\n额外同步的项目内非保护文件：${paths.join('、')}\n请在验收时确认这些额外修改是否合理。`;
}

function writingBlockCount(parsed: ReturnType<typeof parseWritingBlocks>): number {
  return (
    parsed.governanceChanges.length +
    parsed.architectureFreezes.length +
    (parsed.lunaTask === null ? 0 : 1) +
    (parsed.governanceReconciliation === null ? 0 : 1) +
    parsed.blocked.length
  );
}

function taskWithBaseCommit(task: LunaTaskBlock, baseCommit: string): LunaTaskBlock {
  return {
    ...task,
    fields: {
      ...task.fields,
      base_commit: baseCommit,
    },
  };
}

function reconciliationOrchestratorResult(run: GovernanceReconciliationRunResult): OrchestratorResult {
  return {
    status: run.status === 'PASS' ? 'NO_TASK' : run.status,
    phase: run.phase,
    taskId: null,
    message: run.message,
  };
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

function errorDetails(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null || !('details' in error)) return {};
  const details = (error as { details?: unknown }).details;
  return typeof details === 'object' && details !== null && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : {};
}

function commitValue(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value : null;
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

const LOCALLY_REPROCESSABLE_WRITING_BLOCK_ERROR_CODES = new Set([
  'WRITING_BLOCK_OUT_OF_BLOCK_CONTENT',
  'WRITING_BLOCK_BODY_INVALID_JSON',
]);

const AUTO_REPAIRABLE_WRITING_BLOCK_ERROR_CODES = new Set([
  'WRITING_BLOCK_OUT_OF_BLOCK_CONTENT',
  'WRITING_BLOCK_HEADER_INVALID',
  'WRITING_BLOCK_UNCLOSED',
  'WRITING_BLOCK_BODY_INVALID_JSON',
  'WRITING_BLOCK_BODY_INVALID_YAML',
  'WRITING_BLOCK_UNKNOWN_TYPE',
  'WRITING_BLOCK_MISSING_FIELD',
  'WRITING_BLOCK_INVALID_FIELD',
  'WRITING_BLOCK_DUPLICATE_LUNA_TASK',
]);

function isAutoRepairableError(code: string, phase: OrchestratorState['phase']): boolean {
  if (phase !== 'PARSING') return false;
  return code === 'BASELINE_CHANGED' || AUTO_REPAIRABLE_WRITING_BLOCK_ERROR_CODES.has(code);
}

function inferAutoRepairOutputType(value: string): AutoRepairState['outputType'] {
  const match = /\[WRITING_BLOCK\s+type="(LUNA_TASK|GOVERNANCE_RECONCILIATION)"\]/.exec(value);
  return match?.[1] === 'LUNA_TASK' || match?.[1] === 'GOVERNANCE_RECONCILIATION' ? match[1] : 'UNKNOWN';
}

function dashboardNeedsNewSol(error: { code: string; message: string } | null): boolean {
  if (error === null) return false;
  if (LOCALLY_REPROCESSABLE_WRITING_BLOCK_ERROR_CODES.has(error.code)) return false;
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
  if (LOCALLY_REPROCESSABLE_WRITING_BLOCK_ERROR_CODES.has(error.code)) return true;
  return /^(?:FAILED|TIMEOUT|NETWORK|SESSION|CLI|CODEX|LUNA|REPORT|TEST|GIT|PUSH|SYNC|CONTEXT|AUTH|PROCESS_|COMMAND_FAILED|DASHBOARD_COMMAND_FAILED|COMMIT_FAILED|GOVERNANCE_CHANGE_COMMIT_FAILED|GOVERNANCE_RECONCILIATION_COMMIT_FAILED|ARCHITECTURE_FREEZE_(?:FETCH_FAILED|CONTENT_UNREADABLE|COMMIT_FAILED)|EDGE_PROCESS_EXITED|GOVERNANCE_RECONCILIATION_(?:TIMEOUT|AUTH_REQUIRED|CONTEXT_LIMIT)|BLOCKED_EXTERNAL_SETUP)/i.test(
    error.code,
  );
}

const RETRYABLE_GOVERNANCE_RECONCILIATION_ERROR_CODES = new Set([
  'COMMIT_FAILED',
  'PUSH_FAILED',
  'GOVERNANCE_RECONCILIATION_COMMIT_FAILED',
  'GOVERNANCE_RECONCILIATION_PUSH_FAILED',
  'GOVERNANCE_RECONCILIATION_SYNC_FAILED',
  'GOVERNANCE_RECONCILIATION_TIMEOUT',
  'GOVERNANCE_RECONCILIATION_AUTH_REQUIRED',
  'GOVERNANCE_RECONCILIATION_CONTEXT_LIMIT',
]);

function isRetryableGovernanceReconciliationError(error: unknown): boolean {
  return RETRYABLE_GOVERNANCE_RECONCILIATION_ERROR_CODES.has(errorCode(error));
}

function safeSyncId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:/-]+/g, '_').slice(0, 80) || 'update';
}

function result(status: OrchestratorResult['status'], state: OrchestratorState, message: string): OrchestratorResult {
  return { status, phase: state.phase, taskId: state.taskId, message };
}

function emptyStaleTask(): DashboardStaleTaskSnapshot {
  return { invalidated: false, taskBaseCommit: null, currentCommit: null, message: null };
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
