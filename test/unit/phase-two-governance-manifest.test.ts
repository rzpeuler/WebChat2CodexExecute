import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GovernanceManifestError,
  GovernanceManifestStore,
  indexGovernanceManifest,
  validateGovernanceManifest,
} from '../../src/main/governance/manifest.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'web-chat2codex-manifest-'));
  directories.push(directory);
  return directory;
}

describe('governance manifest registry', () => {
  it('preserves unknown document types and indexes status buckets', async () => {
    const projectRoot = await temporaryDirectory();
    const manifestPath = join(projectRoot, 'docs', 'governance', 'governance-manifest.yaml');
    await mkdir(join(projectRoot, 'docs', 'governance'), { recursive: true });
    const source = `version: 1\ndocuments:\n  - id: active-policy\n    path: docs/governance/active.md\n    audience:\n      - Sol\n      - Luna\n    version: 2\n    status: active\n    type: future-policy\n    extension: keep-me\n  - id: candidate-policy\n    path: docs/governance/candidate.md\n    audience: [Sol]\n    version: 3\n    status: candidate\n  - id: old-policy\n    path: docs/governance/history.md\n    audience: [Luna]\n    version: 1\n    status: history\n`;
    await writeFile(manifestPath, source, 'utf8');
    const store = new GovernanceManifestStore(projectRoot);
    const manifest = await store.load();
    const index = await store.loadIndex();

    expect(manifest?.documents[0]).toMatchObject({ type: 'future-policy', extension: 'keep-me' });
    expect(index.active.map((document) => document.id)).toEqual(['active-policy']);
    expect(index.candidate.map((document) => document.id)).toEqual(['candidate-policy']);
    expect(index.history.map((document) => document.id)).toEqual(['old-policy']);
    expect(index.byId.get('active-policy')?.type).toBe('future-policy');

    await store.save(manifest!);
    const persisted = await readFile(manifestPath, 'utf8');
    expect(persisted).toContain('future-policy');
    expect(persisted).toContain('keep-me');
  });

  it('rejects registered document and manifest paths outside the project', async () => {
    const projectRoot = await temporaryDirectory();
    expect(() => new GovernanceManifestStore(projectRoot, '../manifest.yaml')).toThrowError(
      expect.objectContaining({ code: 'MANIFEST_PATH_OUTSIDE_PROJECT' }),
    );
    expect(() =>
      validateGovernanceManifest(
        {
          version: 1,
          documents: [{ id: 'escape', path: '../outside.md', audience: ['Sol'], version: 1, status: 'active' }],
        },
        projectRoot,
      ),
    ).toThrowError(expect.objectContaining({ code: 'MANIFEST_PATH_OUTSIDE_PROJECT' }));
  });

  it('returns an empty index when no registry exists', async () => {
    const projectRoot = await temporaryDirectory();
    const store = new GovernanceManifestStore(projectRoot);
    await expect(store.load()).resolves.toBeNull();
    expect(indexGovernanceManifest({ version: 1, documents: [] })).toMatchObject({
      all: [],
      active: [],
      candidate: [],
      history: [],
    });
  });

  it('rejects malformed YAML with a typed error', async () => {
    const projectRoot = await temporaryDirectory();
    const manifestPath = join(projectRoot, 'governance-manifest.yaml');
    await writeFile(manifestPath, 'documents: [', 'utf8');
    await expect(new GovernanceManifestStore(projectRoot, manifestPath).load()).rejects.toBeInstanceOf(
      GovernanceManifestError,
    );
  });
});
