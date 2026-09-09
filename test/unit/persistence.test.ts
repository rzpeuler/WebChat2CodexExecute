import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AtomicJsonFileStore,
  FileLockTimeoutError,
  JsonlFileEventLog,
  SnapshotFormatError,
  type SnapshotLoadDiagnostic,
} from '../../src/main/state/persistence.js';
import {
  createInitialState,
  parseTopLevelState,
  type TopLevelState,
} from '../../src/shared/contracts/top-level-state.js';
import { recoverTopLevelState } from '../../src/main/state/startup-recovery.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'web-chat2codex-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('local persistence', () => {
  it('atomically saves and reloads a JSON snapshot', async () => {
    const directory = await makeTemporaryDirectory();
    const filePath = join(directory, 'state', 'snapshot.json');
    const store = new AtomicJsonFileStore(filePath);
    const snapshot = { status: 'PAUSED', revision: 4, nested: { safe: true } };

    expect(await store.load()).toBeNull();
    await store.save(snapshot);

    expect(await store.load()).toEqual(snapshot);
    expect(await readFile(filePath, 'utf8')).toContain('"status": "PAUSED"');
    await expect(readdir(join(directory, 'state'))).resolves.toHaveLength(1);
  });

  it('appends complete JSONL events in order, including concurrent callers', async () => {
    const directory = await makeTemporaryDirectory();
    const filePath = join(directory, 'events', 'events.jsonl');
    const log = new JsonlFileEventLog<{ sequence: number; kind: string }>(filePath);

    await Promise.all([
      log.append({ sequence: 1, kind: 'started' }),
      log.append({ sequence: 2, kind: 'paused' }),
      log.append({ sequence: 3, kind: 'resumed' }),
    ]);

    expect(await log.readAll()).toEqual([
      { sequence: 1, kind: 'started' },
      { sequence: 2, kind: 'paused' },
      { sequence: 3, kind: 'resumed' },
    ]);
    expect((await readFile(filePath, 'utf8')).split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('serializes writes from two independent store instances with one filesystem lock', async () => {
    const directory = await makeTemporaryDirectory();
    const filePath = join(directory, 'state', 'snapshot.json');
    const firstStore = new AtomicJsonFileStore(filePath, { lock: { timeoutMs: 1_000 } });
    const secondStore = new AtomicJsonFileStore(filePath, { lock: { timeoutMs: 1_000 } });

    await Promise.all([
      firstStore.save({ writer: 'first', value: 1 }),
      secondStore.save({ writer: 'second', value: 2 }),
    ]);

    const snapshot = await firstStore.load();
    expect(snapshot).toEqual(expect.objectContaining({ writer: expect.any(String), value: expect.any(Number) }));
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(snapshot);
  });

  it('waits for a live lock owner instead of deleting its lock', async () => {
    const directory = await makeTemporaryDirectory();
    const filePath = join(directory, 'state', 'snapshot.json');
    const lockPath = `${filePath}.lock`;
    await mkdir(join(directory, 'state'), { recursive: true });
    await open(lockPath, 'wx').then(async (handle) => {
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          token: 'independent-owner',
          createdAt: new Date().toISOString(),
        }),
      );
      await handle.close();
    });

    const store = new AtomicJsonFileStore(filePath, { lock: { timeoutMs: 40, retryMs: 5 } });
    await expect(store.load()).rejects.toBeInstanceOf(FileLockTimeoutError);
    await expect(readFile(lockPath, 'utf8')).resolves.toContain('independent-owner');
  });

  it('rejects an invalid top-level snapshot through the validator', async () => {
    const directory = await makeTemporaryDirectory();
    const filePath = join(directory, 'state', 'snapshot.json');
    await mkdir(join(directory, 'state'), { recursive: true });
    await writeFile(filePath, JSON.stringify({ status: 'NOT_A_STATE' }), 'utf8');
    const store = new AtomicJsonFileStore(filePath, { validate: parseTopLevelState });

    await expect(store.load()).rejects.toBeInstanceOf(SnapshotFormatError);
  });

  it('removes an old lock whose owner process is no longer alive', async () => {
    const directory = await makeTemporaryDirectory();
    const filePath = join(directory, 'state', 'snapshot.json');
    const lockPath = `${filePath}.lock`;
    await mkdir(join(directory, 'state'), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 999_999_999,
        token: 'dead-owner',
        createdAt: new Date(0).toISOString(),
      }),
      'utf8',
    );
    await utimes(lockPath, new Date(0), new Date(0));

    const store = new AtomicJsonFileStore(filePath, { lock: { timeoutMs: 100, retryMs: 5, staleMs: 1 } });
    await expect(store.load()).resolves.toBeNull();
  });

  it('records primary corruption when recovery succeeds from the backup snapshot', async () => {
    const directory = await makeTemporaryDirectory();
    const filePath = join(directory, 'state', 'snapshot.json');
    const persistedState: TopLevelState = {
      ...createInitialState(new Date('2026-09-10T02:00:00.000Z')),
      status: 'PAUSED',
      revision: 2,
    };
    const persistenceDiagnostics: SnapshotLoadDiagnostic[] = [];
    const startupDiagnostics: string[] = [];
    await mkdir(join(directory, 'state'), { recursive: true });
    await writeFile(filePath, '{invalid json', 'utf8');
    await writeFile(`${filePath}.bak`, JSON.stringify(persistedState), 'utf8');
    const store = new AtomicJsonFileStore(filePath, {
      validate: parseTopLevelState,
      onDiagnostic: (diagnostic) => persistenceDiagnostics.push(diagnostic),
    });

    const recovery = await recoverTopLevelState(store, {
      onDiagnostic: (diagnostic) => startupDiagnostics.push(diagnostic.code),
    });

    expect(recovery.state).toEqual(persistedState);
    expect(recovery.diagnostics).toEqual([
      expect.objectContaining({ code: 'STATE_SNAPSHOT_PRIMARY_CORRUPT_RECOVERED' }),
    ]);
    expect(startupDiagnostics).toEqual(['STATE_SNAPSHOT_PRIMARY_CORRUPT_RECOVERED']);
    expect(persistenceDiagnostics).toEqual([
      expect.objectContaining({ code: 'PRIMARY_SNAPSHOT_CORRUPT_USING_BACKUP', filePath }),
    ]);
  });

  it('waits for a lock held by an independent Node child process', async () => {
    const directory = await makeTemporaryDirectory();
    const filePath = join(directory, 'state', 'snapshot.json');
    const lockPath = `${filePath}.lock`;
    await mkdir(join(directory, 'state'), { recursive: true });
    const childScript = [
      "const fs = require('node:fs');",
      'const lockPath = process.argv[1];',
      "fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'child-owner', createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });",
      "process.stdout.write('ready\\n');",
      'setTimeout(() => fs.rmSync(lockPath, { force: true }), 300);',
    ].join('');
    const child = spawn(process.execPath, ['-e', childScript, lockPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        child.stdout?.once('data', () => resolveReady());
        child.stderr?.once('data', (data) => rejectReady(new Error(data.toString())));
        child.once('error', rejectReady);
      });
      const store = new AtomicJsonFileStore(filePath, { lock: { timeoutMs: 1_500, retryMs: 10 } });
      await expect(store.load()).resolves.toBeNull();
      const exitCode = child.exitCode ?? (await once(child, 'exit'))[0];
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) {
        child.kill();
      }
    }
  });
});
