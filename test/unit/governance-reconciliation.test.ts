import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GovernanceReconciliationApplier,
  GovernanceReconciliationError,
} from '../../src/main/governance/reconciliation-applier.js';
import { parseWritingBlock, type GovernanceReconciliationBlock } from '../../src/shared/protocol/writing-block.js';
import { MainOrchestrator } from '../../src/main/orchestration/index.js';
import { hashCanonicalGovernanceText } from '../../src/main/governance/canonical-text-hash.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function canonicalSha(value: string): string {
  return hashCanonicalGovernanceText(Buffer.from(value, 'utf8'));
}

function canonicalShaBytes(bytes: Uint8Array): string {
  return hashCanonicalGovernanceText(bytes);
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
          sha256_before: canonicalSha('# Legacy\nKeep feature notes.\n'),
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
            sha256_before: canonicalSha(original),
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

  it('allows formatting-only drift and preserves the original BOM and line endings', async () => {
    const root = await project();
    const original = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('# Legacy\r\nKeep feature notes.\r\n', 'utf8'),
    ]);
    const replacement = '# Updated\nKeep feature notes.\n';
    await writeFile(join(root, 'AGENTS.md'), original);

    await new GovernanceReconciliationApplier(root, { runId: () => 'run-format' }).apply(
      block({
        status: 'CHANGES_REQUIRED',
        baseline_commit: 'base',
        files: [
          {
            path: 'AGENTS.md',
            action: 'replace',
            reason: 'Align rules.',
            sha256_before: canonicalShaBytes(Buffer.from('# Legacy\nKeep feature notes.\n', 'utf8')),
            content: replacement,
          },
        ],
      }),
    );

    expect(await readFile(join(root, 'AGENTS.md'))).toEqual(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Updated\r\nKeep feature notes.\r\n', 'utf8')]),
    );
    expect(await readFile(join(root, '.web-chat2codex/backups/reconciliation/run-format/AGENTS.md'))).toEqual(original);
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
              sha256_before: canonicalSha('different'),
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
              sha256_before: canonicalSha('x'),
              content: '# no',
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(GovernanceReconciliationError);
  });

  it('blocks an actual body change even when the submitted hash is canonical', async () => {
    const root = await project();
    const changed = '# Changed\nKeep feature notes.\n';
    await writeFile(join(root, 'AGENTS.md'), changed, 'utf8');

    await expect(
      new GovernanceReconciliationApplier(root, { runId: () => 'run-body-drift' }).apply(
        block({
          status: 'CHANGES_REQUIRED',
          baseline_commit: 'base',
          files: [
            {
              path: 'AGENTS.md',
              action: 'replace',
              reason: 'stale',
              sha256_before: canonicalSha('# Legacy\nKeep feature notes.\n'),
              content: '# Updated\n',
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'GOVERNANCE_RECONCILIATION_SHA_CONFLICT' });
    await expect(access(join(root, '.web-chat2codex/backups'))).rejects.toThrow();
  });

  it('blocks a concurrent modification after the commit preflight and before replacement', async () => {
    const root = await project();
    const original = '# Legacy\nKeep feature notes.\n';
    await expect(
      new GovernanceReconciliationApplier(root, {
        runId: () => 'run-concurrent',
        beforeReplace: async () => writeFile(join(root, 'AGENTS.md'), '# Concurrent\n', 'utf8'),
      }).apply(
        block({
          status: 'CHANGES_REQUIRED',
          baseline_commit: 'base',
          files: [
            {
              path: 'AGENTS.md',
              action: 'replace',
              reason: 'stale',
              sha256_before: canonicalSha(original),
              content: '# Updated\n',
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'GOVERNANCE_RECONCILIATION_SHA_CONFLICT' });
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('# Concurrent\n');
    await expect(access(join(root, '.web-chat2codex/backups'))).resolves.toBeUndefined();
  });

  it('fails closed when the target changes after validation and is moved to backup', async () => {
    const root = await project();
    const original = '# Legacy\nKeep feature notes.\n';
    const concurrent = '# Changed during rename window\n';

    await expect(
      new GovernanceReconciliationApplier(root, {
        runId: () => 'run-backup-race',
        beforeBackup: async () => writeFile(join(root, 'AGENTS.md'), concurrent, 'utf8'),
      }).apply(
        block({
          status: 'CHANGES_REQUIRED',
          baseline_commit: 'base',
          files: [
            {
              path: 'AGENTS.md',
              action: 'replace',
              reason: 'stale',
              sha256_before: canonicalSha(original),
              content: '# Updated\n',
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'GOVERNANCE_RECONCILIATION_SHA_CONFLICT' });
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(concurrent);
    await expect(
      access(join(root, '.web-chat2codex/backups/reconciliation/run-backup-race/AGENTS.md')),
    ).rejects.toThrow();
  });

  it('retains an installed target changed externally while rolling back a later failure', async () => {
    const root = await project();
    const second = 'second legacy\n';
    const third = 'third legacy\n';
    await writeFile(join(root, 'SECOND.md'), second, 'utf8');
    await writeFile(join(root, 'THIRD.md'), third, 'utf8');
    const external = '# External edit after install\n';

    await expect(
      new GovernanceReconciliationApplier(root, {
        runId: () => 'run-rollback-race',
        beforeReplace: async (_path, index) => {
          if (index === 2) {
            await writeFile(join(root, 'AGENTS.md'), external, 'utf8');
            await writeFile(join(root, 'THIRD.md'), 'third concurrent\n', 'utf8');
          }
        },
      }).apply(
        block({
          status: 'CHANGES_REQUIRED',
          baseline_commit: 'base',
          files: [
            {
              path: 'AGENTS.md',
              action: 'replace',
              reason: 'update first',
              sha256_before: canonicalSha('# Legacy\nKeep feature notes.\n'),
              content: '# Updated\n',
            },
            {
              path: 'SECOND.md',
              action: 'replace',
              reason: 'update second',
              sha256_before: canonicalSha(second),
              content: 'second updated\n',
            },
            {
              path: 'THIRD.md',
              action: 'replace',
              reason: 'force rollback',
              sha256_before: canonicalSha(third),
              content: 'third updated\n',
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'GOVERNANCE_RECONCILIATION_SHA_CONFLICT' });
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(external);
    await expect(
      access(join(root, '.web-chat2codex/backups/reconciliation/run-rollback-race/AGENTS.md')),
    ).resolves.toBeUndefined();
    expect(await readFile(join(root, 'SECOND.md'), 'utf8')).toBe(second);
    expect(await readFile(join(root, 'THIRD.md'), 'utf8')).toBe('third concurrent\n');
  });

  it('retains the backup when an installed target is deleted before rollback', async () => {
    const root = await project();
    const original = '# Legacy\nKeep feature notes.\n';
    const second = 'second legacy\n';
    const third = 'third legacy\n';
    await writeFile(join(root, 'SECOND.md'), second, 'utf8');
    await writeFile(join(root, 'THIRD.md'), third, 'utf8');

    await expect(
      new GovernanceReconciliationApplier(root, {
        runId: () => 'run-rollback-delete',
        beforeReplace: async (_path, index) => {
          if (index === 2) await rm(join(root, 'AGENTS.md'));
        },
      }).apply(
        block({
          status: 'CHANGES_REQUIRED',
          baseline_commit: 'base',
          files: [
            {
              path: 'AGENTS.md',
              action: 'replace',
              reason: 'update first',
              sha256_before: canonicalSha(original),
              content: '# Updated\n',
            },
            {
              path: 'SECOND.md',
              action: 'replace',
              reason: 'update second',
              sha256_before: canonicalSha(second),
              content: 'second updated\n',
            },
            {
              path: 'THIRD.md',
              action: 'replace',
              reason: 'force rollback',
              sha256_before: canonicalSha(third),
              content: 'third updated\n',
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'GOVERNANCE_RECONCILIATION_FILE_NOT_FOUND' });
    await expect(access(join(root, 'AGENTS.md'))).rejects.toThrow();
    await expect(
      access(join(root, '.web-chat2codex/backups/reconciliation/run-rollback-delete/AGENTS.md')),
    ).resolves.toBeUndefined();
  });

  it('retains the backup when an installed target is replaced with a directory before rollback', async () => {
    const root = await project();
    const original = '# Legacy\nKeep feature notes.\n';
    const second = 'second legacy\n';
    const third = 'third legacy\n';
    await writeFile(join(root, 'SECOND.md'), second, 'utf8');
    await writeFile(join(root, 'THIRD.md'), third, 'utf8');

    await expect(
      new GovernanceReconciliationApplier(root, {
        runId: () => 'run-rollback-directory',
        beforeReplace: async (_path, index) => {
          if (index === 2) {
            await rm(join(root, 'AGENTS.md'));
            await mkdir(join(root, 'AGENTS.md'));
          }
        },
      }).apply(
        block({
          status: 'CHANGES_REQUIRED',
          baseline_commit: 'base',
          files: [
            {
              path: 'AGENTS.md',
              action: 'replace',
              reason: 'update first',
              sha256_before: canonicalSha(original),
              content: '# Updated\n',
            },
            {
              path: 'SECOND.md',
              action: 'replace',
              reason: 'update second',
              sha256_before: canonicalSha(second),
              content: 'second updated\n',
            },
            {
              path: 'THIRD.md',
              action: 'replace',
              reason: 'force rollback',
              sha256_before: canonicalSha(third),
              content: 'third updated\n',
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'GOVERNANCE_RECONCILIATION_NOT_REGULAR_TEXT' });
    await expect(access(join(root, 'AGENTS.md'))).resolves.toBeUndefined();
    await expect(
      access(join(root, '.web-chat2codex/backups/reconciliation/run-rollback-directory/AGENTS.md')),
    ).resolves.toBeUndefined();
  });

  it('fails closed when an earlier installed target is externally reformatted before success', async () => {
    const root = await project();
    const original = '# Legacy\nKeep feature notes.\n';
    const second = 'second legacy\n';
    const external = '# Updated\r\nKeep feature notes.\r\n';
    await writeFile(join(root, 'SECOND.md'), second, 'utf8');

    await expect(
      new GovernanceReconciliationApplier(root, {
        runId: () => 'run-final-check-race',
        beforeReplace: async (_path, index) => {
          if (index === 1) await writeFile(join(root, 'AGENTS.md'), external, 'utf8');
        },
      }).apply(
        block({
          status: 'CHANGES_REQUIRED',
          baseline_commit: 'base',
          files: [
            {
              path: 'AGENTS.md',
              action: 'replace',
              reason: 'update first',
              sha256_before: canonicalSha(original),
              content: '# Updated\nKeep feature notes.\n',
            },
            {
              path: 'SECOND.md',
              action: 'replace',
              reason: 'update second',
              sha256_before: canonicalSha(second),
              content: 'second updated\n',
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'GOVERNANCE_RECONCILIATION_SHA_CONFLICT' });
    expect(await readFile(join(root, 'AGENTS.md'))).toEqual(Buffer.from(external, 'utf8'));
    expect(
      await readFile(join(root, '.web-chat2codex/backups/reconciliation/run-final-check-race/AGENTS.md'), 'utf8'),
    ).toBe(original);
    expect(await readFile(join(root, 'SECOND.md'), 'utf8')).toBe(second);
    await expect(
      access(join(root, '.web-chat2codex/backups/reconciliation/run-final-check-race/SECOND.md')),
    ).rejects.toThrow();
  });

  it('uses commit-stage BOM and line endings when formatting drift follows planning', async () => {
    const root = await project();
    const original = '# Legacy\nKeep feature notes.\n';
    const commitStage = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('# Legacy\r\nKeep feature notes.\r\n', 'utf8'),
    ]);

    await new GovernanceReconciliationApplier(root, {
      runId: () => 'run-commit-format',
      beforeReplace: async () => writeFile(join(root, 'AGENTS.md'), commitStage),
    }).apply(
      block({
        status: 'CHANGES_REQUIRED',
        baseline_commit: 'base',
        files: [
          {
            path: 'AGENTS.md',
            action: 'replace',
            reason: 'format drift',
            sha256_before: canonicalSha(original),
            content: '# Updated\nKeep feature notes.\n',
          },
        ],
      }),
    );

    expect(await readFile(join(root, 'AGENTS.md'))).toEqual(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Updated\r\nKeep feature notes.\r\n', 'utf8')]),
    );
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
            sha256_before: canonicalSha('# Legacy\nKeep feature notes.\n'),
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
