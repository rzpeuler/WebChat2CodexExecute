import type { StateSnapshotStore } from '../state/persistence.js';

export const EDGE_SOL_STATUSES = [
  'THINKING',
  'COMPLETED_CANDIDATE',
  'NETWORK_ERROR',
  'CONTEXT_LIMIT',
  'AUTH_REQUIRED',
  'SESSION_LOST',
  'AMBIGUOUS',
] as const;
export type EdgeSolStatus = (typeof EDGE_SOL_STATUSES)[number];

export interface EdgeExecutableLocatorOptions {
  executablePath?: string;
  fileExists?: (filePath: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export interface EdgeProcess {
  pid?: number;
  exitCode: number | null;
  once(event: 'exit' | 'error', listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface EdgeProcessRunner {
  (
    file: string,
    args: readonly string[],
    options: {
      cwd?: string;
      shell: false;
      windowsHide: boolean;
      detached: false;
      stdio: 'ignore';
    },
  ): EdgeProcess;
}

export interface EdgeProfileOptions {
  executablePath?: string;
  userDataDirectory: string;
  remoteDebuggingPort: number;
  initialUrl?: string;
  fileExists?: (filePath: string) => Promise<boolean>;
  processRunner?: EdgeProcessRunner;
  debugPortProbe?: (port: number) => Promise<boolean>;
  waitForDebugPort?: (port: number, timeoutMs: number) => Promise<boolean>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  onProcessExit?: (cause: 'exit' | 'error') => void;
}

export interface EdgeProfileHandle {
  executablePath: string;
  userDataDirectory: string;
  remoteDebuggingPort: number;
  process: EdgeProcess | null;
  reused: boolean;
  loginRequired: boolean;
}

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  [key: string]: unknown;
}

export interface CdpTransport {
  listTargets(): Promise<CdpTarget[]>;
  evaluate<T = unknown>(targetId: string, expression: string): Promise<T>;
  sendCommand<T = unknown>(targetId: string, method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface EdgeAdapterRules {
  version: string;
  assistantSelectors: readonly string[];
  thinkingSelectors: readonly string[];
  errorSelectors: readonly string[];
  loginSelectors: readonly string[];
  contextLimitPatterns: readonly RegExp[];
  networkErrorPatterns: readonly RegExp[];
  sessionLostPatterns: readonly RegExp[];
}

export interface EdgePageSnapshot {
  targetId: string;
  title: string;
  url: string;
  projectFingerprint: string | null;
  accountFingerprint: string | null;
  latestAssistantText: string;
  latestAssistantHash: string | null;
  statusText: string;
  errorText: string;
  loginWall: boolean;
  sessionMissing: boolean;
  contextLimit: boolean;
  networkError: boolean;
  isThinking: boolean;
  writingBlockIncomplete: boolean;
  sampledAt: string;
}

export interface EdgeSolObservation extends EdgePageSnapshot {
  status: EdgeSolStatus;
  adapterVersion: string;
  consecutiveStableSamples: number;
}

export interface SolConversationIdentity {
  conversationId: string;
  url: string;
  title: string;
  projectFingerprint: string;
  accountFingerprint: string | null;
  targetId: string;
}

export interface SolConversationRecord extends SolConversationIdentity {
  createdAt: string;
  retiredAt: string | null;
  reason: 'INITIAL_BIND' | 'CONTEXT_RECOVERY' | 'ACTIVE_ROTATION';
}

export interface SolSessionBinding {
  version: 1;
  projectFingerprint: string;
  accountFingerprint: string | null;
  baselineMessageHash: string | null;
  activeConversationId: string;
  activeConversationUrl: string;
  activeConversationTitle: string;
  conversationChain: SolConversationRecord[];
  lastRawInput: string | null;
  lastRawInputHash: string | null;
  updatedAt: string;
}

export interface SolSessionState extends SolSessionBinding {
  lastContextRecoveryEventId: string | null;
  contextRecoveryAttempts: number;
  lastActiveRotationKey: string | null;
  paused: boolean;
  pauseReason: string | null;
}

export interface SolSessionStateStore extends StateSnapshotStore<SolSessionState> {}

export interface SolConversationController {
  createConversation(input: {
    projectFingerprint: string;
    accountFingerprint: string | null;
    reason: 'CONTEXT_RECOVERY' | 'ACTIVE_ROTATION';
  }): Promise<SolConversationIdentity>;
  sendMessage(input: { conversation: SolConversationIdentity; text: string }): Promise<void>;
}

export interface CodexSessionRotator {
  rotate(input: { projectFingerprint: string; handoff: SolSessionHandoff }): Promise<{ sessionId: string }>;
}

export interface SolSessionHandoff {
  version: 1;
  projectFingerprint: string;
  accountFingerprint: string | null;
  phase: string;
  productGoal: string;
  completedTaskCount: number;
  completedTaskIds: string[];
  commit: string | null;
  governanceRevision: string | number | null;
  architectureRevisionSet: Array<string | number>;
  unresolvedIssues: string[];
  nextStep: string;
  createdAt: string;
}

export interface SolSessionPersistence {
  load(): Promise<SolSessionState | null>;
  save(state: SolSessionState): Promise<void>;
}
