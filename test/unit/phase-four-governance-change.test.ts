import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GovernanceChangeApplier, GovernanceChangeError } from '../../src/main/governance/change-applier.js';
import { GovernanceManifestStore } from '../../src/main/governance/manifest.js';
import { parseWritingBlock, type GovernanceChangeBlock } from '../../src/shared/protocol/writing-block.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'web-chat2codex-governance-'));
  directories.push(root);
  return root;
}

function change(fields: Record<string, unknown>): GovernanceChangeBlock {
  const body = {
    change_id: 'change-1',
    operation: 'add_document',
    document_id: 'policy',
    path: 'docs/governance/policy.md',
    reason: 'record policy',
    risk_level: 'normal',
    affected_agents: ['Sol', 'Luna'],
    content: '# Policy\n',
    ...fields,
  };
  return parseWritingBlock(
    `[WRITING_BLOCK type="GOVERNANCE_CHANGE"]\n${JSON.stringify(body)}\n[/WRITING_BLOCK]`,
  ) as GovernanceChangeBlock;
}

async function seedActiveDocument(root: string): Promise<void> {
  await mkdir(join(root, 'docs', 'governance'), { recursive: true });
  await writeFile(join(root, 'docs', 'governance', 'policy.md'), '# Old policy\n', 'utf8');
  await new GovernanceManifestStore(root).save({
    version: 3,
    documents: [
      {
        id: 'policy',
        path: 'docs/governance/policy.md',
        audience: ['Sol', 'Luna'],
        version: 1,
        status: 'active',
        source: 'seed',
      },
    ],
  });
}

describe('governance change applier', () => {
  it('adds and records a normal document, including source and extension fields', async () => {
    const root = await project();
    const result = await new GovernanceChangeApplier(root, { now: () => new Date('2026-09-10T00:00:00.000Z') }).apply(
      change({ extension_rule: 'preserve' }),
    );
    const manifest = await new GovernanceManifestStore(root).load();

    expect(result).toMatchObject({ status: 'active', activated: true, documentId: 'policy' });
    expect(await readFile(join(root, 'docs/governance/policy.md'), 'utf8')).toContain('# Policy');
    expect(manifest?.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'policy',
          status: 'active',
          source_change_id: 'change-1',
          extension_rule: 'preserve',
        }),
      ]),
    );
    expect(manifest?.applied_changes).toMatchObject({
      'change-1': expect.objectContaining({ source: 'Sol Writing Block', recorded_at: '2026-09-10T00:00:00.000Z' }),
    });
  });

  it('updates, appends, and records the previous document as history', async () => {
    const root = await project();
    await seedActiveDocument(root);
    const applier = new GovernanceChangeApplier(root);
    await applier.apply(change({ change_id: 'update-1', operation: 'update_document', content: '# New policy' }));
    await applier.apply(change({ change_id: 'append-1', operation: 'append_section', content: '## Appendix' }));
    const manifest = await new GovernanceManifestStore(root).load();
    const active = manifest?.documents.find((document) => document.id === 'policy');
    const history = manifest?.documents.filter((document) => document.status === 'history');

    expect(active).toMatchObject({ version: 3, status: 'active' });
    expect(history).toHaveLength(2);
    expect(await readFile(join(root, 'docs/governance/policy.md'), 'utf8')).toContain('## Appendix');
    expect(manifest?.version).toBe(5);
  });

  it('supports decision records and keeps high-risk changes as inactive candidates', async () => {
    const root = await project();
    const applier = new GovernanceChangeApplier(root);
    const decision = await applier.apply(
      change({
        change_id: 'decision-1',
        operation: 'record_decision',
        document_id: 'decision-1',
        path: 'docs/governance/decisions/decision-1.md',
        content: '# Decision 1',
      }),
    );
    const risky = await applier.apply(
      change({
        change_id: 'risky-1',
        operation: 'update_document',
        document_id: 'decision-1',
        path: 'docs/governance/decisions/decision-1.md',
        risk_level: 'high',
        content: '# Weaken security policy',
      }),
    );
    const manifest = await new GovernanceManifestStore(root).load();

    expect(decision.status).toBe('active');
    expect(risky).toMatchObject({ status: 'candidate', activated: false });
    expect(risky.diagnostics[0]?.code).toBe('HIGH_RISK_CANDIDATE');
    expect(manifest?.documents.find((document) => document.id === 'decision-1')).toMatchObject({
      status: 'active',
      version: 1,
    });
    expect(manifest?.documents.some((document) => document.status === 'candidate')).toBe(true);
    expect(await readFile(join(root, 'docs/governance/decisions/decision-1.md'), 'utf8')).toBe('# Decision 1\n');
  });

  it('is idempotent by change_id and rejects a changed replay', async () => {
    const root = await project();
    const applier = new GovernanceChangeApplier(root);
    const first = await applier.apply(change({}));
    const second = await applier.apply(change({}));

    expect(second).toMatchObject({ status: 'idempotent', changedPaths: first.changedPaths });
    await expect(applier.apply(change({ content: '# changed' }))).rejects.toMatchObject({
      code: 'GOVERNANCE_CHANGE_ID_CONFLICT',
    });
  });

  it.each(['../outside.md', 'docs/superpowers/forbidden.md'])('rejects unsafe or protected path %s', async (path) => {
    const root = await project();
    await expect(new GovernanceChangeApplier(root).apply(change({ path }))).rejects.toBeInstanceOf(
      GovernanceChangeError,
    );
    await expect(new GovernanceChangeApplier(root).apply(change({ path }))).rejects.toMatchObject({
      code: path.startsWith('..') ? 'GOVERNANCE_CHANGE_PATH_OUTSIDE_PROJECT' : 'GOVERNANCE_CHANGE_PATH_PROTECTED',
    });
  });

  it('treats deprecation and permission changes as high risk', async () => {
    const root = await project();
    await seedActiveDocument(root);
    const result = await new GovernanceChangeApplier(root).apply(
      change({ change_id: 'deprecate-1', operation: 'deprecate_document', content: '# Candidate deprecation' }),
    );
    expect(result.status).toBe('candidate');
  });
});
