import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { promises as fs } from 'node:fs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function ensureDirectory(path) {
  await fs.mkdir(path, { recursive: true });
}

async function writePrivateFile(path, contents) {
  const temporary = join(dirname(path), `.${path.split(/[\\/]/).pop()}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await replaceAtomically(temporary, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function replaceAtomically(temporary, destination) {
  try {
    await fs.rename(temporary, destination);
    return;
  } catch (firstError) {
    const backup = `${destination}.bak`;
    let movedPrimary = false;
    try {
      await fs.rename(destination, backup);
      movedPrimary = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw firstError;
    }
    try {
      await fs.rename(temporary, destination);
      await fs.chmod(destination, 0o600).catch(() => {});
      if (movedPrimary) await fs.rm(backup, { force: true });
    } catch (secondError) {
      if (movedPrimary) await fs.rename(backup, destination).catch(() => {});
      throw secondError;
    }
  }
}

async function readCandidate(path, validate) {
  try {
    const parsed = JSON.parse(await fs.readFile(path, 'utf8'));
    if (validate && !validate(parsed)) throw new Error('validation failed');
    return parsed;
  } catch {
    return null;
  }
}

export async function loadJsonWithBackup(path, validate = undefined) {
  const primary = await readCandidate(path, validate);
  if (primary !== null) return { value: primary, source: 'primary' };
  const backup = await readCandidate(`${path}.bak`, validate);
  if (backup !== null) return { value: backup, source: 'backup' };
  return { value: null, source: 'none' };
}

export async function writeJsonAtomic(path, value) {
  await ensureDirectory(dirname(path));
  await writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function clearJson(path) {
  await fs.rm(path, { force: true });
  await fs.rm(`${path}.bak`, { force: true });
}

export async function withFileLock(path, action, { timeoutMs = 5000, retryMs = 25 } = {}) {
  const lockPath = `${path}.lock`;
  await ensureDirectory(dirname(path));
  const deadline = Date.now() + timeoutMs;
  let lock;
  while (!lock) {
    try {
      lock = await fs.open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) throw error;
      await sleep(retryMs);
    }
  }
  try {
    return await action();
  } finally {
    await lock.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

