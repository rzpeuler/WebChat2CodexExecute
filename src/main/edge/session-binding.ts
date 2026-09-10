import { createHash } from 'node:crypto';
import { AtomicJsonFileStore, type StateSnapshotStore } from '../state/persistence.js';
import { hashMessage } from './state-adapter.js';
import type {
  EdgeSolObservation,
  SolConversationIdentity,
  SolConversationRecord,
  SolSessionBinding,
  SolSessionState,
} from './types.js';

export type SolBindingErrorCode =
  | 'BINDING_MISSING'
  | 'AUTH_REQUIRED'
  | 'PROJECT_MISMATCH'
  | 'ACCOUNT_MISMATCH'
  | 'SESSION_MISMATCH'
  | 'INVALID_BINDING';

export class SolBindingError extends Error {
  readonly code: SolBindingErrorCode;

  constructor(code: SolBindingErrorCode, message: string) {
    super(message);
    this.name = 'SolBindingError';
    this.code = code;
  }
}

export interface SolSessionBindingStoreOptions {
  store?: StateSnapshotStore<SolSessionState>;
  filePath?: string;
  now?: () => Date;
}

export function parseSolSessionState(value: unknown): SolSessionState {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Invalid Sol session state.');
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.projectFingerprint !== 'string' ||
    typeof record.activeConversationId !== 'string'
  ) {
    throw new TypeError('Invalid Sol session binding identity.');
  }
  if (!Array.isArray(record.conversationChain) || record.conversationChain.length === 0) {
    throw new TypeError('Sol session chain must contain at least one conversation.');
  }
  if (
    typeof record.updatedAt !== 'string' ||
    typeof record.paused !== 'boolean' ||
    typeof record.contextRecoveryAttempts !== 'number'
  ) {
    throw new TypeError('Invalid Sol session state metadata.');
  }
  return record as unknown as SolSessionState;
}

export function createSolSessionStateStore(filePath: string): StateSnapshotStore<SolSessionState> {
  return new AtomicJsonFileStore<SolSessionState>(filePath, { validate: parseSolSessionState });
}

export class SolSessionBindingStore {
  private readonly store: StateSnapshotStore<SolSessionState>;
  private readonly now: () => Date;
  private state: SolSessionState | null = null;
  private loadPromise: Promise<SolSessionState | null> | null = null;

  constructor(options: SolSessionBindingStoreOptions = {}) {
    if (options.store === undefined && options.filePath === undefined) {
      throw new SolBindingError('INVALID_BINDING', 'A Sol session state store or file path is required.');
    }
    this.store = options.store ?? createSolSessionStateStore(options.filePath!);
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<SolSessionState | null> {
    if (this.loadPromise !== null) return this.loadPromise;
    this.loadPromise = this.store.load().then((value) => {
      this.state = value;
      return value;
    });
    try {
      return await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  getState(): SolSessionState | null {
    return this.state === null ? null : cloneState(this.state);
  }

  async bind(
    observation: EdgeSolObservation,
    conversationId = conversationIdFromUrl(observation.url),
  ): Promise<SolSessionState> {
    if (observation.loginWall || observation.status === 'AUTH_REQUIRED') {
      throw new SolBindingError('AUTH_REQUIRED', 'A manual login is required before binding a Sol conversation.');
    }
    if (observation.projectFingerprint === null || observation.url === '' || conversationId === null) {
      throw new SolBindingError(
        'INVALID_BINDING',
        'The selected tab does not expose a stable Project conversation identity.',
      );
    }
    const now = this.now().toISOString();
    const record: SolConversationRecord = {
      conversationId,
      url: observation.url,
      title: observation.title,
      projectFingerprint: observation.projectFingerprint,
      accountFingerprint: observation.accountFingerprint,
      targetId: observation.targetId,
      createdAt: now,
      retiredAt: null,
      reason: 'INITIAL_BIND',
    };
    const next: SolSessionState = {
      version: 1,
      projectFingerprint: observation.projectFingerprint,
      accountFingerprint: observation.accountFingerprint,
      baselineMessageHash: observation.latestAssistantHash,
      activeConversationId: conversationId,
      activeConversationUrl: observation.url,
      activeConversationTitle: observation.title,
      conversationChain: [record],
      lastRawInput: null,
      lastRawInputHash: null,
      lastContextRecoveryEventId: null,
      contextRecoveryAttempts: 0,
      lastActiveRotationKey: null,
      paused: false,
      pauseReason: null,
      updatedAt: now,
    };
    await this.store.save(next);
    this.state = next;
    return cloneState(next);
  }

  async setActiveConversation(
    conversation: SolConversationIdentity,
    reason: 'CONTEXT_RECOVERY' | 'ACTIVE_ROTATION',
  ): Promise<SolSessionState> {
    const current = await this.requireState();
    this.assertProjectAndAccount(conversation);
    const now = this.now().toISOString();
    const chain = current.conversationChain.map((entry) =>
      entry.conversationId === current.activeConversationId && entry.retiredAt === null
        ? { ...entry, retiredAt: now }
        : entry,
    );
    chain.push({ ...conversation, createdAt: now, retiredAt: null, reason });
    const next: SolSessionState = {
      ...current,
      activeConversationId: conversation.conversationId,
      activeConversationUrl: conversation.url,
      activeConversationTitle: conversation.title,
      conversationChain: chain,
      updatedAt: now,
    };
    await this.store.save(next);
    this.state = next;
    return cloneState(next);
  }

  async recordRawInput(input: string): Promise<SolSessionState> {
    const current = await this.requireState();
    const next = {
      ...current,
      lastRawInput: input,
      lastRawInputHash: hashMessage(input),
      updatedAt: this.now().toISOString(),
    };
    await this.store.save(next);
    this.state = next;
    return cloneState(next);
  }

  async markContextRecoveryAttempt(
    eventId: string,
    attempts: number,
    paused: boolean,
    pauseReason: string | null,
  ): Promise<SolSessionState> {
    const current = await this.requireState();
    const next = {
      ...current,
      lastContextRecoveryEventId: eventId,
      contextRecoveryAttempts: attempts,
      paused,
      pauseReason,
      updatedAt: this.now().toISOString(),
    };
    await this.store.save(next);
    this.state = next;
    return cloneState(next);
  }

  async markActiveRotation(key: string): Promise<SolSessionState> {
    const current = await this.requireState();
    const next = { ...current, lastActiveRotationKey: key, updatedAt: this.now().toISOString() };
    await this.store.save(next);
    this.state = next;
    return cloneState(next);
  }

  assertCanSend(
    identity: Pick<SolConversationIdentity, 'projectFingerprint' | 'accountFingerprint' | 'conversationId'>,
  ): void {
    const current = this.state;
    if (current === null) throw new SolBindingError('BINDING_MISSING', 'No Sol conversation is bound.');
    this.assertProjectAndAccount(identity);
    if (current.activeConversationId !== identity.conversationId) {
      throw new SolBindingError('SESSION_MISMATCH', 'The target conversation is not the active bound conversation.');
    }
  }

  assertProjectAndAccount(identity: Pick<SolConversationIdentity, 'projectFingerprint' | 'accountFingerprint'>): void {
    const current = this.state;
    if (current === null) throw new SolBindingError('BINDING_MISSING', 'No Sol conversation is bound.');
    if (current.projectFingerprint !== identity.projectFingerprint) {
      throw new SolBindingError('PROJECT_MISMATCH', 'The target conversation belongs to a different ChatGPT Project.');
    }
    if (
      current.accountFingerprint !== null &&
      identity.accountFingerprint !== null &&
      current.accountFingerprint !== identity.accountFingerprint
    ) {
      throw new SolBindingError('ACCOUNT_MISMATCH', 'The target conversation belongs to a different account.');
    }
  }

  private async requireState(): Promise<SolSessionState> {
    if (this.state === null) await this.load();
    if (this.state === null) throw new SolBindingError('BINDING_MISSING', 'No Sol conversation is bound.');
    return this.state;
  }
}

export function bindingFromState(state: SolSessionState): SolSessionBinding {
  const binding: SolSessionBinding = {
    version: state.version,
    projectFingerprint: state.projectFingerprint,
    accountFingerprint: state.accountFingerprint,
    baselineMessageHash: state.baselineMessageHash,
    activeConversationId: state.activeConversationId,
    activeConversationUrl: state.activeConversationUrl,
    activeConversationTitle: state.activeConversationTitle,
    conversationChain: state.conversationChain,
    lastRawInput: state.lastRawInput,
    lastRawInputHash: state.lastRawInputHash,
    updatedAt: state.updatedAt,
  };
  return {
    ...binding,
    conversationChain: binding.conversationChain.map((entry) => ({ ...entry })),
  };
}

export function hashRawInput(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function conversationIdFromUrl(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const marker = parts.findIndex((part) => part === 'c' || part === 'conversation');
    return marker >= 0 ? (parts[marker + 1] ?? null) : (parts.at(-1) ?? null);
  } catch {
    return null;
  }
}

function cloneState(value: SolSessionState): SolSessionState {
  return {
    ...value,
    conversationChain: value.conversationChain.map((entry) => ({ ...entry })),
  };
}
