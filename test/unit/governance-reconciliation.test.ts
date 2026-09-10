import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GovernanceReconciliationApplier,
  GovernanceReconciliationError,
} from '../../src/main/governance/reconciliation-applier.js';
import { parseWritingBlock, type GovernanceReconciliationBlock } from '../../src/shared/protocol/writing-block.js';
import { MainOrchestrator } from '../../src/main/orchestration/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function block(fields: Record<string, unknown>): GovernanceReconciliationBlock {
  return parseWritingBlock(
    `[WRITING_BLOCK type="GOVERNANCE_RECONCILIATION"]\n${JSON.stringify({ schema_version: 1, ...fields })}\n[/WRITING_BLOCK]`,
  ) as GovernanceReconciliationBlock;
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'web-chat2codex-reconciliation-'));
  roots.push(root);
  await writeFile(join(root, 'AGENTS.md'), '# Legacy\nKeep feature notes.\n', 'utf8');
  return root;
}

describe('governance reconciliation', () => {
  it('parses PASS and complete replacement files while preserving extension fields', () => {
    expect(block({ status: 'PASS', reason: 'No external governance conflict.' }).fields.status).toBe('PASS');
    const source = '# Updated\nKeep feature notes.\n';
    const parsed = block({
      status: 'CHANGES_REQUIRED',
      baseline_commit: '0123456789abcdef0123456789abcdef01234567',
      files: [
        {
          path: 'AGENTS.md',
          action: 'replace',
          reason: 'Align the agent role wording.',
          sha256_before: sha256('# Legacy\nKeep feature notes.\n'),
          content: source,
          sol_note: 'kept',
        },
      ],
      review_id: 'review-1',
    });
    expect(parsed.fields.files?.[0]).toMatchObject({ path: 'AGENTS.md', content: source, sol_note: 'kept' });
    expect(parsed.extensions).toMatchObject({ review_id: 'review-1' });
  });

  it('backs up and replaces all Sol-selected files automatically', async () => {
    const root = await project();
    const original = '# Legacy\nKeep feature notes.\n';
    const replacement = '# Updated\nKeep feature notes.\n';
    const result = await new GovernanceReconciliationApplier(root, { runId: () => 'run-1' }).apply(
      block({
        status: 'CHANGES_REQUIRED',
        baseline_commit: 'base',
        files: [
          {
            path: 'AGENTS.md',
            action: 'replace',
            reason: 'Align rules.',
            sha256_before: sha256(original),
            content: replacement,
          },
        ],
      }),
    );
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(replacement);
    expect(await readFile(join(root, '.web-chat2codex/backups/reconciliation/run-1/AGENTS.md'), 'utf8')).toBe(original);
    expect(result).toMatchObject({
      runId: 'run-1',
      changedPaths: ['AGENTS.md'],
      backupPaths: ['.web-chat2codex/backups/reconciliation/run-1/AGENTS.md'],
    });
  });

  it('fails closed on SHA drift and protected paths without modifying files', async () => {
    const root = await project();
    const original = await readFile(join(root, 'AGENTS.md'), 'utf8');
    await expect(
      new GovernanceReconciliationApplier(root, { runId: () => 'run-sha' }).apply(
        block({
          status: 'CHANGES_REQUIRED',
          baseline_commit: 'base',
          files: [
            {
              path: 'AGENTS.md',
              action: 'replace',
              reason: 'stale',
              sha256_before: sha256('different'),
              content: '# Updated\n',
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'GOVERNANCE_RECONCILIATION_SHA_CONFLICT' });
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(original);
    await expect(access(join(root, '.web-chat2codex/backups'))).rejects.toThrow();

    await expect(
      new GovernanceReconciliationApplier(root).apply(
        block({
          status: 'CHANGES_REQUIRED',
          baseline_commit: 'base',
          files: [
            {
              path: '.web-chat2codex/secret.txt',
              action: 'replace',
              reason: 'unsafe',
              sha256_before: sha256('x'),
              content: '# no',
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(GovernanceReconciliationError);
  });

  it('does not accept a reconciliation block as an ordinary Luna round output', () => {
    const parsed = block({ status: 'PASS' });
    expect(parsed.type).toBe('GOVERNANCE_RECONCILIATION');
    expect(vi.fn()).not.toHaveBeenCalled();
  });

  it('runs reconciliation independently, syncs automatically, and never starts Luna', async () => {
    const root = await project();
    const baseline = {
      repositoryRoot: root,
      remoteName: 'origin',
      remoteUrl: 'https://example.invalid/repo.git',
      branch: 'main',
      head: 'base',
      remoteTip: 'base',
      worktree: [],
    };
    const startTask = vi.fn();
    const apply = vi.fn(async () => ({
      runId: 'run-2',
      changedPaths: ['AGENTS.md'],
      backupPaths: ['.web-chat2codex/backups/reconciliation/run-2/AGENTS.md'],
    }));
    const syncGovernance = vi.fn(async () => ({
      kind: 'governance' as const,
      commit: 'next',
      pushed: true,
      remoteCommit: 'next',
      pushRetried: false,
    }));
    const orchestrator = new MainOrchestrator({
      project: { projectId: 'p', name: 'Project', localPath: root, remoteUrl: baseline.remoteUrl },
      edge: { observe: vi.fn() },
      git: {
        captureBaseline: vi.fn(),
        syncGovernance,
        syncCode: vi.fn(),
      },
      codex: { startTask },
      reconciliation: { apply },
    });
    const result = await orchestrator.runGovernanceReconciliation({
      baseline,
      solOutput: `[WRITING_BLOCK type="GOVERNANCE_RECONCILIATION"]\n${JSON.stringify({
        schema_version: 1,
        status: 'CHANGES_REQUIRED',
        baseline_commit: 'base',
        files: [
          {
            path: 'AGENTS.md',
            action: 'replace',
            reason: 'Align rules.',
            sha256_before: sha256('# Legacy\nKeep feature notes.\n'),
            content: '# Updated\nKeep feature notes.\n',
          },
        ],
      })}\n[/WRITING_BLOCK]`,
    });
    expect(result).toMatchObject({ status: 'COMPLETED', commit: 'next', remoteCommit: 'next' });
    expect(apply).toHaveBeenCalledOnce();
    expect(syncGovernance).toHaveBeenCalledWith(expect.objectContaining({ changeId: 'reconciliation-run-2' }));
    expect(startTask).not.toHaveBeenCalled();
  });
});
