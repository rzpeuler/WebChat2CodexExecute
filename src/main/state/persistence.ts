import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface StateSnapshotStore<T> {
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
}

export interface EventLog<T> {
  append(event: T): Promise<void>;
  readAll(): Promise<T[]>;
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

async function readJson<T>(filePath: string): Promise<T> {
  const contents = await readFile(filePath, 'utf8');
  return JSON.parse(contents) as T;
}

export class AtomicJsonFileStore<T> implements StateSnapshotStore<T> {
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async load(): Promise<T | null> {
    try {
      return await readJson<T>(this.filePath);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) {
        try {
          return await readJson<T>(`${this.filePath}.bak`);
        } catch (backupError) {
          if (!isNodeError(backupError, 'ENOENT')) {
            throw error;
          }
        }
        throw error;
      }

      try {
        return await readJson<T>(`${this.filePath}.bak`);
      } catch (backupError) {
        if (isNodeError(backupError, 'ENOENT')) {
          return null;
        }
        throw backupError;
      }
    }
  }

  save(value: T): Promise<void> {
    const saveOperation = this.writeChain.then(() => this.saveOne(value));
    this.writeChain = saveOperation.catch(() => undefined);
    return saveOperation;
  }

  private async saveOne(value: T): Promise<void> {
    await ensureParentDirectory(this.filePath);
    const tempPath = join(dirname(this.filePath), `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writePrivateFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
      await replaceAtomically(tempPath, this.filePath);
      await chmod(this.filePath, 0o600).catch(() => undefined);
    } finally {
      await rm(tempPath, { force: true });
    }
  }
}

export class JsonlFileEventLog<T> implements EventLog<T> {
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  append(event: T): Promise<void> {
    const appendOperation = this.writeChain.then(async () => {
      await ensureParentDirectory(this.filePath);
      const handle = await open(this.filePath, 'a', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(this.filePath, 0o600).catch(() => undefined);
    });
    this.writeChain = appendOperation.catch(() => undefined);
    return appendOperation;
  }

  async readAll(): Promise<T[]> {
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
  }
}
