import type {
  DashboardCommand,
  DashboardCommandResult,
  DashboardSnapshot,
  LoopGraphNodeId,
  LoopGraphSnapshot,
} from '../../shared/contracts/dashboard.js';
import type { TopLevelStatus } from '../../shared/contracts/top-level-state.js';
import type {
  ArchitectureFreezeBlock,
  GovernanceChangeBlock,
  GovernanceReconciliationBlock,
  LunaTaskBlock,
} from '../../shared/protocol/writing-block.js';
import type { EdgeSolObservation } from '../edge/types.js';
import type { CodexSnapshots, CodexTaskHandle } from '../codex/types.js';
import type {
  CaptureBaselineOptions,
  CodeSyncInput,
  GitBaseline,
  GitManualCommitAndPushResult,
  GitManualOperationRecord,
  GitRepositoryStatus,
  GitSyncResult,
  GovernanceSyncInput,
} from '../git/types.js';
import type { GovernanceChangeApplyResult } from '../governance/change-applier.js';
import type { GovernanceReconciliationApplyResult } from '../governance/reconciliation-applier.js';
import type { ArchitectureFreezeDownloadResult } from '../architecture/freeze-downloader.js';

export type OrchestratorPhase =
  | 'IDLE'
  | 'READING_SOL'
  | 'PARSING'
  | 'APPLYING_UPDATES'
  | 'SYNCING_GOVERNANCE'
  | 'RUNNING_LUNA'
  | 'SYNCING_CODE'
  | 'NOTIFYING_SOL'
  | 'WAITING_FOR_SOL'
  | 'PAUSED'
  | 'FAILED';

export type OrchestrationRoundStatus =
  'IDLE' | 'WAITING' | 'DUPLICATE' | 'NO_TASK' | 'RECOVERED' | 'COMPLETED' | 'PAUSED' | 'FAILED';

export interface OrchestratorSnapshots extends CodexSnapshots {
  governanceRevision: string | number | null;
  architectureRevisionSet: Array<string | number>;
}

/** Minimal JSON-safe context required to resume a completed Luna run before code sync. */
export interface PendingCodeSyncState {
  taskId: string;
  reportPath: string;
  allowedPaths: string[];
  protectedPaths: string[];
  baseline: GitBaseline;
  testsPassed: boolean;
  sessionId: string;
  outputKey: string;
}

/** Minimal JSON-safe context required to resume governance sync after apply succeeded. */
export interface PendingReconciliationSyncState {
  baseline: GitBaseline;
  runId: string;
  changedPaths: string[];
  backupPaths: string[];
  outputKey: string;
}

export interface ExecutionRecoveryRecord {
  outputKey: string;
  outputType: 'UNKNOWN' | 'LUNA_TASK' | 'GOVERNANCE_RECONCILIATION' | 'USER_MESSAGE';
  taskId: string | null;
  roundId: string | null;
  startedAt: string;
  updatedAt: string;
  interruptedPhase: OrchestratorPhase;
  interruptedNodeId: LoopGraphNodeId | null;
  completedNodeIds: LoopGraphNodeId[];
  error: { code: string; message: string } | null;
  awaitingConfirmation: boolean;
}

export interface OrchestratorState {
  version: 1;
  revision: number;
  updatedAt: string;
  active: boolean;
  status: TopLevelStatus;
  phase: OrchestratorPhase;
  taskId: string | null;
  processedOutputKey: string | null;
  lastContextRecoveryEventId: string | null;
  governanceRevision: string | number | null;
  architectureRevisions: Array<string | number>;
  luna: { status: string; sessionId: string | null };
  commits: { local: string | null; remote: string | null };
  recentError: { code: string; message: string } | null;
  retryCount: number;
  /** The single persisted dashboard projection for the current orchestration round. */
  loopGraph: LoopGraphSnapshot;
  pendingCodeSync: PendingCodeSyncState | null;
  pendingReconciliationSync: PendingReconciliationSyncState | null;
  executionRecovery: ExecutionRecoveryRecord | null;
  /** Optional for backwards compatibility with state files written before manual Git maintenance. */
  manualGitOperation?: GitManualOperationRecord;
  activeSolSession: {
    sessionId: string;
    conversationId: string | null;
    status: string;
  } | null;
}

export interface OrchestratorStateStore {
  load(): Promise<OrchestratorState | null>;
  save(state: OrchestratorState): Promise<void>;
}

export interface OrchestratorProject {
  projectId: string;
  name: string;
  localPath: string;
  remoteUrl?: string | null;
}

export interface EdgeObservationSource {
  observe(): Promise<EdgeSolObservation>;
}

export interface SolMessageSource {
  sendMessage(input: { text: string; observation: EdgeSolObservation }): Promise<void>;
}

export interface ContextRecoverySource {
  recover(input: {
    eventId: string;
    observation: EdgeSolObservation;
    rawInput?: string;
  }): Promise<{ status: string; error?: { code: string; message: string } }>;
}

export interface GitOrchestratorPort {
  captureBaseline(repositoryPath: string, options?: CaptureBaselineOptions): Promise<GitBaseline>;
  readRepositoryStatus?(repositoryPath: string): Promise<GitRepositoryStatus>;
  commitAndPushProject?(repositoryPath: string): Promise<GitManualCommitAndPushResult>;
  syncGovernance(input: GovernanceSyncInput): Promise<GitSyncResult>;
  syncCode(input: CodeSyncInput): Promise<GitSyncResult>;
}

export interface GovernanceOrchestratorPort {
  applyAll(changes: GovernanceChangeBlock[]): Promise<GovernanceChangeApplyResult[]>;
}

export interface GovernanceReconciliationOrchestratorPort {
  apply(reconciliation: GovernanceReconciliationBlock): Promise<GovernanceReconciliationApplyResult>;
}

export interface ArchitectureOrchestratorPort {
  download(freezes: ArchitectureFreezeBlock[]): Promise<ArchitectureFreezeDownloadResult>;
}

export interface CodexOrchestratorPort {
  startTask(input: {
    task: LunaTaskBlock;
    snapshots: CodexSnapshots;
    repositoryPath: string;
    model?: string;
    executablePath?: string;
    baselineSnapshot?: unknown;
    repositorySnapshot?: unknown;
  }): Promise<CodexTaskHandle>;
}

export interface SnapshotSource {
  read(): Promise<OrchestratorSnapshots>;
}

export interface OrchestratorNotifier {
  notify(input: {
    project: string;
    taskId: string | null;
    phase: string;
    suggestion: string;
    error: unknown;
    level?: 'RECOVERABLE' | 'NEEDS_USER' | 'FATAL';
  }): unknown;
}

export interface OrchestratorCallbacks {
  rebind?: () => Promise<void>;
  governanceConsistencyCheck?: () => Promise<void>;
  openEdge?: () => Promise<void>;
  openProject?: () => Promise<void>;
  viewReport?: (reportPath: string | null) => Promise<void>;
}

export interface OrchestratorOptions {
  project: OrchestratorProject;
  edge: EdgeObservationSource;
  git: GitOrchestratorPort;
  codex: CodexOrchestratorPort;
  governance?: GovernanceOrchestratorPort;
  reconciliation?: GovernanceReconciliationOrchestratorPort;
  architecture?: ArchitectureOrchestratorPort;
  sol?: SolMessageSource;
  contextRecovery?: ContextRecoverySource;
  snapshots?: SnapshotSource;
  notifier?: OrchestratorNotifier;
  callbacks?: OrchestratorCallbacks;
  stateStore?: OrchestratorStateStore;
  targetBranch?: string;
  expectedRemoteUrl?: string | null;
  model?: string;
  executablePath?: string;
  now?: () => Date;
}

export interface OrchestratorResult {
  status: OrchestrationRoundStatus;
  phase: OrchestratorPhase;
  taskId: string | null;
  message: string;
}

export interface GovernanceReconciliationRunInput {
  solOutput: string;
  baseline: GitBaseline;
  /** Stable observation key when the block came from the ordinary loop. */
  outputKey?: string;
}

export type GovernanceReconciliationRunStatus = 'PASS' | 'COMPLETED' | 'DUPLICATE' | 'PAUSED';

export interface GovernanceReconciliationRunResult {
  status: GovernanceReconciliationRunStatus;
  reconciliationStatus: 'PASS' | 'CHANGES_REQUIRED' | 'BLOCKED' | null;
  phase: OrchestratorPhase;
  message: string;
  runId: string | null;
  changedPaths: string[];
  backupPaths: string[];
  commit: string | null;
  remoteCommit: string | null;
}

export interface Orchestrator {
  initialize(): Promise<void>;
  start(): Promise<OrchestratorResult>;
  pause(): Promise<OrchestratorResult>;
  retryCurrentStage(): Promise<OrchestratorResult>;
  continueInterrupted(): Promise<OrchestratorResult>;
  alignLatestBaseline(): Promise<OrchestratorResult>;
  commitAndPushProject(): Promise<OrchestratorResult>;
  runRound(): Promise<OrchestratorResult>;
  beginGovernanceReconciliationWait(): Promise<void>;
  pauseGovernanceReconciliation(error: unknown): Promise<void>;
  runGovernanceReconciliation(input: GovernanceReconciliationRunInput): Promise<GovernanceReconciliationRunResult>;
  getState(): OrchestratorState;
  getDashboardSnapshot(): DashboardSnapshot;
  executeCommand(command: DashboardCommand): Promise<DashboardCommandResult>;
}
