import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AtomicJsonFileStore, JsonlFileEventLog } from '../../src/main/state/persistence.js';

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
});
