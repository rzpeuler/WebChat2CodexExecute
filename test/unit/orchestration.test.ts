import { describe, expect, it, vi } from 'vitest';
import type { EdgeSolObservation } from '../../src/main/edge/types.js';
import type { CodexRunResult } from '../../src/main/codex/types.js';
import type { GitBaseline } from '../../src/main/git/types.js';
import { parseWritingBlocks, type LunaTaskBlock } from '../../src/shared/protocol/writing-block.js';
import { MainOrchestrator, type OrchestratorOptions } from '../../src/main/orchestration/index.js';

const baseline: GitBaseline = {
  repositoryRoot: 'C:/repo',
  remoteName: 'origin',
  remoteUrl: 'https://example.invalid/repo.git',
  branch: 'main',
  head: 'base-commit',
  remoteTip: 'base-commit',
  worktree: [],
};

function observation(text: string, status: EdgeSolObservation['status'] = 'COMPLETED_CANDIDATE'): EdgeSolObservation {
  return {
    targetId: 'tab-1',
    title: 'Sol',
    url: 'https://chatgpt.com/project/p1/c/c1',
    projectFingerprint: 'p1',
    accountFingerprint: 'a1',
    latestAssistantText: text,
    latestAssistantHash: `hash-${text.length}`,
    statusText: '',
    errorText: '',
    loginWall: false,
    sessionMissing: false,
    contextLimit: status === 'CONTEXT_LIMIT',
    networkError: status === 'NETWORK_ERROR',
    isThinking: status === 'THINKING',
    writingBlockIncomplete: false,
    sampledAt: '2026-09-10T00:00:00.000Z',
    status,
    adapterVersion: 'test',
    consecutiveStableSamples: 2,
  };
}

function taskText(): string {
  return `[WRITING_BLOCK type="LUNA_TASK"]
{
  "task_id": "task-1",
  "title": "Implement feature",
  "objective": "Implement the feature",
  "base_commit": "base-commit",
  "scope": ["src/**", "docs/task-reports/**"],
  "out_of_scope": ["src/main/app.ts"],
  "deliverables": ["implementation"],
  "validation_commands": ["npm test"],
  "governance_revision": 2,
  "architecture_revision_set": [3],
  "report_path": "docs/task-reports/task-1.md",
  "remote_sync_policy": true
}
[/WRITING_BLOCK]`;
}

function governanceText(): string {
  return `[WRITING_BLOCK type="GOVERNANCE_CHANGE"]
{
  "change_id": "g-1",
  "operation": "add_document",
  "document_id": "policy",
  "path": "docs/governance/policy.md",
  "reason": "clarify policy",
  "risk_level": "low",
  "affected_agents": ["luna"],
  "content": "Policy"
}
[/WRITING_BLOCK]`;
}

function completedRun(task: LunaTaskBlock): CodexRunResult {
  return {
    status: 'COMPLETED',
    sessionId: 'luna-1',
    taskId: task.fields.task_id,
    exitCode: 0,
    reportPath: task.fields.report_path,
    stdoutSummary: '',
    stderrSummary: '',
    events: [],
    config: { model: 'gpt-5.6-luna', sandbox: 'danger-full-access', approvalPolicy: 'never' },
    diagnostics: [],
  };
}

function baseOptions(overrides: Partial<OrchestratorOptions> = {}): OrchestratorOptions {
  const task = parseWritingBlocks(taskText()).lunaTask!;
  return {
    project: { projectId: 'p1', name: 'Project', localPath: 'C:/repo', remoteUrl: baseline.remoteUrl },
    edge: { observe: vi.fn(async () => observation(taskText())) },
    git: {
      captureBaseline: vi.fn(async () => baseline),
      syncGovernance: vi.fn(async () => ({
        kind: 'governance' as const,
        commit: 'abcdef2',
        pushed: true,
        remoteCommit: 'abcdef2',
        pushRetried: false,
      })),
      syncCode: vi.fn(async () => ({
        kind: 'code' as const,
        commit: 'abcdef3',
        pushed: true,
        remoteCommit: 'abcdef3',
        pushRetried: false,
      })),
    },
    governance: {
      applyAll: vi.fn(async () => [
        {
          changeId: 'g-1',
          documentId: 'policy',
          status: 'active' as const,
          activated: true,
          manifestVersion: 2,
          changedPaths: ['docs/governance/policy.md'],
          diagnostics: [],
        },
      ]),
    },
    architecture: {
      download: vi.fn(async () => ({
        added: [],
        skipped: ['f-1'],
        indexPath: 'docs/governance/architecture/architecture-index.yaml',
      })),
    },
    codex: {
      startTask: vi.fn(async () => ({
        sessionId: 'luna-1',
        status: 'RUNNING' as const,
        result: Promise.resolve(completedRun(task)),
      })),
    },
    sol: { sendMessage: vi.fn(async () => undefined) },
    ...overrides,
  };
}

describe('P0 main orchestration', () => {
  it('runs governance sync, Luna, code sync, and Sol acknowledgement in order', async () => {
    const options = baseOptions({
      edge: { observe: vi.fn(async () => observation(`${governanceText()}\n${taskText()}`)) },
    });
    const orchestrator = new MainOrchestrator(options);

    await orchestrator.start();
    const result = await orchestrator.runRound();

    expect(result.status).toBe('COMPLETED');
    expect(options.git.syncGovernance).toHaveBeenCalledOnce();
    expect(options.codex.startTask).toHaveBeenCalledOnce();
    expect(options.git.syncCode).toHaveBeenCalledWith(
      expect.objectContaining({ baseline: expect.objectContaining({ head: 'abcdef2' }) }),
    );
    expect(options.sol?.sendMessage).toHaveBeenCalledOnce();
    expect(orchestrator.getDashboardSnapshot()).toMatchObject({
      status: 'RUNNING',
      taskId: null,
      commits: { local: 'abcdef3', remote: 'abcdef3' },
    });
  });

  it('rejects duplicate output without starting a second Luna task', async () => {
    const options = baseOptions();
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.start();
    await orchestrator.runRound();
    const duplicate = await orchestrator.runRound();

    expect(duplicate.status).toBe('DUPLICATE');
    expect(options.codex.startTask).toHaveBeenCalledOnce();
  });

  it('pauses on malformed or multi-task output before any side effect', async () => {
    const duplicateTaskOutput = `${taskText()}\n${taskText().replace('task-1', 'task-2')}`;
    const options = baseOptions({ edge: { observe: vi.fn(async () => observation(duplicateTaskOutput)) } });
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.start();
    const result = await orchestrator.runRound();

    expect(result.status).toBe('PAUSED');
    expect(orchestrator.getState()).toMatchObject({
      status: 'PAUSED',
      recentError: { code: 'WRITING_BLOCK_DUPLICATE_LUNA_TASK' },
    });
    expect(options.codex.startTask).not.toHaveBeenCalled();
    expect(options.git.syncGovernance).not.toHaveBeenCalled();
  });

  it('applies a governance-only round and does not invoke Luna', async () => {
    const options = baseOptions({ edge: { observe: vi.fn(async () => observation(governanceText())) } });
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.start();
    const result = await orchestrator.runRound();

    expect(result.status).toBe('NO_TASK');
    expect(options.governance?.applyAll).toHaveBeenCalledOnce();
    expect(options.codex.startTask).not.toHaveBeenCalled();
  });

  it('requires the dedicated entry point for governance reconciliation output', async () => {
    const reconciliation = `[WRITING_BLOCK type="GOVERNANCE_RECONCILIATION"]
{
  "schema_version": 1,
  "status": "PASS"
}
[/WRITING_BLOCK]`;
    const options = baseOptions({ edge: { observe: vi.fn(async () => observation(reconciliation)) } });
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.start();
    const result = await orchestrator.runRound();

    expect(result.status).toBe('PAUSED');
    expect(orchestrator.getState()).toMatchObject({
      status: 'NEEDS_USER_ACTION',
      recentError: { code: 'GOVERNANCE_RECONCILIATION_WRONG_ENTRYPOINT' },
    });
    expect(options.codex.startTask).not.toHaveBeenCalled();
    expect(options.git.syncGovernance).not.toHaveBeenCalled();
  });

  it('recovers one context-limit event and does not create another recovery on polling', async () => {
    const recover = vi.fn(async () => ({ status: 'RECOVERED' }));
    const options = baseOptions({
      edge: { observe: vi.fn(async () => observation('', 'CONTEXT_LIMIT')) },
      contextRecovery: { recover },
    });
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.start();

    expect((await orchestrator.runRound()).status).toBe('RECOVERED');
    expect((await orchestrator.runRound()).status).toBe('DUPLICATE');
    expect(recover).toHaveBeenCalledOnce();
  });

  it('exposes confirmed dashboard commands and rejects unsafe direct commands', async () => {
    const openProject = vi.fn(async () => undefined);
    const orchestrator = new MainOrchestrator(baseOptions({ callbacks: { openProject } }));

    await expect(orchestrator.executeCommand({ command: 'start' } as never)).resolves.toMatchObject({
      accepted: false,
    });
    await expect(orchestrator.executeCommand({ command: 'open-project' })).resolves.toMatchObject({ accepted: true });
    expect(openProject).toHaveBeenCalledOnce();
    await expect(orchestrator.executeCommand({ command: 'start', confirm: true })).resolves.toMatchObject({
      accepted: true,
    });
  });
});
