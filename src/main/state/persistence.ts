import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface StateSnapshotStore<T> {
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
}

export interface EventLog<T> {
  append(event: T): Promise<void>;
  readAll(): Promise<T[]>;
}

export type SnapshotValidator<T> = (value: unknown) => T;

export interface AtomicJsonFileStoreOptions<T> {
  validate?: SnapshotValidator<T>;
}

export class SnapshotFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Invalid JSON snapshot at ${filePath}: ${detail}`, { cause });
    this.name = 'SnapshotFormatError';
    this.filePath = filePath;
  }
}

export class FileLockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(`Timed out waiting for file lock: ${lockPath}`);
    this.name = 'FileLockTimeoutError';
    this.lockPath = lockPath;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

async function writePrivateFile(filePath: string, contents: string): Promise<void> {
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

interface FileLockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

const FILE_LOCK_TIMEOUT_MS = 5_000;
const FILE_LOCK_RETRY_MS = 10;
const FILE_LOCK_STALE_MS = 30_000;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ESRCH');
  }
}

async function readLockOwner(lockPath: string): Promise<FileLockOwner | null> {
  try {
    const value: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.pid !== 'number'
      || typeof record.token !== 'string'
      || typeof record.createdAt !== 'string'
    ) {
      return null;
    }
    return { pid: record.pid, token: record.token, createdAt: record.createdAt };
  } catch {
    return null;
  }
}

async function removeStaleLock(lockPath: string): Promise<void> {
  const owner = await readLockOwner(lockPath);
  if (owner !== null && processIsAlive(owner.pid)) {
    return;
  }

  try {
    const lockStats = await stat(lockPath);
    if (Date.now() - lockStats.mtimeMs < FILE_LOCK_STALE_MS) {
      return;
    }
    await rm(lockPath, { force: true });
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) {
      throw error;
    }
  }
}

async function acquireFileLock(targetPath: string): Promise<() => Promise<void>> {
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;

  await ensureParentDirectory(lockPath);
  while (Date.now() <= deadline) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      const owner: FileLockOwner = {
        pid: process.pid,
        token: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      try {
        await handle.writeFile(JSON.stringify(owner), 'utf8');
        await handle.sync();
      } catch (error) {
        await handle.close();
        await rm(lockPath, { force: true });
        throw error;
      }

      return async () => {
        await handle.close();
        const currentOwner = await readLockOwner(lockPath);
        if (currentOwner?.token === owner.token) {
          await rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) {
        throw error;
      }
      await removeStaleLock(lockPath);
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, FILE_LOCK_RETRY_MS));
    }
  }

  throw new FileLockTimeoutError(lockPath);
}

async function withFileLock<T>(targetPath: string, operation: () => Promise<T>): Promise<T> {
  const release = await acquireFileLock(targetPath);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function replaceAtomically(tempPath: string, targetPath: string): Promise<void> {
  try {
    await rename(tempPath, targetPath);
    await rm(`${targetPath}.bak`, { force: true });
    return;
  } catch (error) {
    if (process.platform !== 'win32' || (!isNodeError(error, 'EPERM') && !isNodeError(error, 'EEXIST'))) {
      throw error;
    }
  }

  // Windows rename does not replace an existing file. The stable backup makes
  // the replacement crash-recoverable: load() can use it if the process stops
  // after the old file has been moved but before the new file is installed.
  const backupPath = `${targetPath}.bak`;
  await rm(backupPath, { force: true });
  try {
    await rename(targetPath, backupPath);
    await rename(tempPath, targetPath);
    await rm(backupPath, { force: true });
  } catch (error) {
    try {
      const targetExists = await readFile(targetPath).then(() => true, () => false);
      if (!targetExists) {
        await rename(backupPath, targetPath);
      }
    } catch {
      // Preserve the original error; a subsequent load can still inspect the
      // backup if it remains on disk.
    }
    throw error;
  }
}

async function readJson<T>(
  filePath: string,
  validate: SnapshotValidator<T> | undefined,
): Promise<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      throw error;
    }
    throw new SnapshotFormatError(filePath, error);
  }
  if (validate === undefined) {
    return parsed as T;
  }
  try {
    return validate(parsed);
  } catch (error) {
    throw new SnapshotFormatError(filePath, error);
  }
}

export class AtomicJsonFileStore<T> implements StateSnapshotStore<T> {
  private readonly filePath: string;
  private readonly validate: SnapshotValidator<T> | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string, options: AtomicJsonFileStoreOptions<T> = {}) {
    this.filePath = resolve(filePath);
    this.validate = options.validate;
  }

  load(): Promise<T | null> {
    return withFileLock(this.filePath, () => this.loadWithoutLock());
  }

  private async loadWithoutLock(): Promise<T | null> {
    try {
      return await readJson<T>(this.filePath, this.validate);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        try {
          return await readJson<T>(`${this.filePath}.bak`, this.validate);
        } catch (backupError) {
          if (isNodeError(backupError, 'ENOENT')) {
            return null;
          }
          throw backupError;
        }
      }

      try {
        return await readJson<T>(`${this.filePath}.bak`, this.validate);
      } catch (backupError) {
        if (isNodeError(backupError, 'ENOENT')) {
          throw error;
        }
        throw new SnapshotFormatError(
          this.filePath,
          `primary and backup snapshots are invalid: ${String(error)}; ${String(backupError)}`,
        );
      }
    }
  }

  save(value: T): Promise<void> {
    const saveOperation = this.writeChain.then(() => this.saveOne(value));
    this.writeChain = saveOperation.catch(() => undefined);
    return saveOperation;
  }

  private async saveOne(value: T): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const tempPath = join(
        dirname(this.filePath),
        `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      try {
        await writePrivateFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
        await replaceAtomically(tempPath, this.filePath);
        await chmod(this.filePath, 0o600).catch(() => undefined);
      } finally {
        await rm(tempPath, { force: true });
      }
    });
  }
}

export class JsonlFileEventLog<T> implements EventLog<T> {
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  append(event: T): Promise<void> {
    const appendOperation = this.writeChain.then(() => withFileLock(this.filePath, async () => {
      await ensureParentDirectory(this.filePath);
      const handle = await open(this.filePath, 'a', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(this.filePath, 0o600).catch(() => undefined);
    }));
    this.writeChain = appendOperation.catch(() => undefined);
    return appendOperation;
  }

  readAll(): Promise<T[]> {
    return withFileLock(this.filePath, async () => {
      try {
        const contents = await readFile(this.filePath, 'utf8');
        return contents
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as T);
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
          return [];
        }
        throw error;
      }
    });
  }
}
