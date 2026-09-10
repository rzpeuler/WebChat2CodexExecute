import {
  AtomicJsonFileStore,
  withSharedStateTransactionLock,
  type FileLockOptions,
  type PersistenceDiagnostic,
} from '../state/persistence.js';
import { resolve } from 'node:path';
import type { GitPendingPush, GitPendingPushRecord, GitPendingPushState } from './types.js';

const PENDING_PUSH_STATE_VERSION = 1;

export interface GitPendingPushStateSnapshot {
  version: typeof PENDING_PUSH_STATE_VERSION;
  pendingPushes: Record<string, GitPendingPush>;
}

export interface PersistentGitPendingPushStateOptions {
  lock?: FileLockOptions;
  onDiagnostic?: (diagnostic: PersistenceDiagnostic) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== 'string' || fieldValue.trim() === '') {
    throw new Error(`pending push ${field} must be a non-empty string`);
  }
  return fieldValue;
}

function parsePendingPush(value: unknown): GitPendingPush {
  if (!isRecord(value)) throw new Error('pending push must be an object');
  if (value.baselineRemoteTip !== null && typeof value.baselineRemoteTip !== 'string') {
    throw new Error('pending push baselineRemoteTip must be a string or null');
  }
  return {
    repositoryRoot: requiredString(value, 'repositoryRoot'),
    remoteName: requiredString(value, 'remoteName'),
    remoteUrl: requiredString(value, 'remoteUrl'),
    branch: requiredString(value, 'branch'),
    baselineRemoteTip: value.baselineRemoteTip,
    commit: requiredString(value, 'commit'),
  };
}

export function parseGitPendingPushState(value: unknown): GitPendingPushStateSnapshot {
  if (!isRecord(value) || value.version !== PENDING_PUSH_STATE_VERSION || !isRecord(value.pendingPushes)) {
    throw new Error('pending push state has an unsupported format');
  }
  const pendingPushes: Record<string, GitPendingPush> = {};
  for (const [key, pendingPush] of Object.entries(value.pendingPushes)) {
    if (key.trim() === '') throw new Error('pending push state contains an empty key');
    pendingPushes[key] = parsePendingPush(pendingPush);
  }
  return { version: PENDING_PUSH_STATE_VERSION, pendingPushes };
}

function clonePendingPush(pendingPush: GitPendingPush): GitPendingPush {
  return { ...pendingPush };
}

export class PersistentGitPendingPushState implements GitPendingPushState {
  private readonly store: AtomicJsonFileStore<GitPendingPushStateSnapshot>;
  private readonly transactionLockPath: string;
  private readonly lock: FileLockOptions | undefined;
  private pendingPushes = new Map<string, GitPendingPush>();
  private loaded = false;
  private loading: Promise<void> | null = null;

  constructor(filePath: string, options: PersistentGitPendingPushStateOptions = {}) {
    const storeOptions = {
      validate: parseGitPendingPushState,
      ...(options.lock === undefined ? {} : { lock: options.lock }),
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    };
    this.store = new AtomicJsonFileStore(filePath, storeOptions);
    this.transactionLockPath = `${resolve(filePath)}.transaction`;
    this.lock = options.lock;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loading !== null) return this.loading;
    this.loading = this.loadFromDisk().then(
      () => {
        this.loaded = true;
      },
      (error: unknown) => {
        this.loading = null;
        throw error;
      },
    );
    return this.loading;
  }

  async read(key: string): Promise<GitPendingPush | null> {
    await this.load();
    const pendingPush = this.pendingPushes.get(key);
    return pendingPush === undefined ? null : clonePendingPush(pendingPush);
  }

  async write(key: string, pendingPush: GitPendingPush): Promise<void> {
    await this.mutate((pendingPushes) => {
      pendingPushes.set(key, clonePendingPush(pendingPush));
    });
  }

  async clear(key: string, commit: string): Promise<void> {
    await this.mutate((pendingPushes) => {
      if (pendingPushes.get(key)?.commit === commit) pendingPushes.delete(key);
    });
  }

  async list(): Promise<GitPendingPushRecord[]> {
    await this.load();
    return [...this.pendingPushes].map(([key, pendingPush]) => ({ key, pendingPush: clonePendingPush(pendingPush) }));
  }

  private async loadFromDisk(): Promise<void> {
    await withSharedStateTransactionLock(
      this.transactionLockPath,
      async () => {
        const snapshot = await this.store.load();
        this.pendingPushes = new Map(
          Object.entries(snapshot?.pendingPushes ?? {}).map(([key, pendingPush]) => [
            key,
            clonePendingPush(pendingPush),
          ]),
        );
      },
      this.lock,
    );
  }

  private async mutate(mutator: (pendingPushes: Map<string, GitPendingPush>) => void): Promise<void> {
    await this.load();
    await withSharedStateTransactionLock(
      this.transactionLockPath,
      async () => {
        const snapshot = await this.store.load();
        const pendingPushes = new Map(
          Object.entries(snapshot?.pendingPushes ?? {}).map(([key, pendingPush]) => [
            key,
            clonePendingPush(pendingPush),
          ]),
        );
        mutator(pendingPushes);
        if (pendingPushes.size === 0) {
          await this.store.clear();
        } else {
          const nextSnapshot: GitPendingPushStateSnapshot = {
            version: PENDING_PUSH_STATE_VERSION,
            pendingPushes: Object.fromEntries(pendingPushes),
          };
          await this.store.save(nextSnapshot);
        }
        this.pendingPushes = pendingPushes;
      },
      this.lock,
    );
  }
}

export { PENDING_PUSH_STATE_VERSION };
