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
  it('keeps the state paused when pause races with successful context recovery', async () => {
    let releaseRecovery!: (value: { status: string }) => void;
    const options = baseOptions({
      edge: { observe: vi.fn(async () => observation('', 'CONTEXT_LIMIT')) },
      contextRecovery: {
        recover: vi.fn(
          () =>
            new Promise<{ status: string }>((resolve) => {
              releaseRecovery = resolve;
            }),
        ),
      },
    });
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.start();
    const round = orchestrator.runRound();
    await vi.waitFor(() => expect(options.contextRecovery?.recover).toHaveBeenCalledOnce());

    await orchestrator.pause();
    releaseRecovery({ status: 'RECOVERED' });
    await round;

    expect(orchestrator.getState()).toMatchObject({ active: false, status: 'PAUSED', phase: 'PAUSED' });
  });

  it('locks the whole dashboard governance operation and allows only navigation during it', async () => {
    let releaseOperation!: () => void;
    const operation = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const orchestrator = new MainOrchestrator(
      baseOptions({
        callbacks: {
          rebind: vi.fn(async () => undefined),
          openEdge: vi.fn(async () => undefined),
          openProject: vi.fn(async () => undefined),
          governanceConsistencyCheck: vi.fn(async () => undefined),
        },
      }),
    );

    const first = orchestrator.runDashboardOperation(() => operation);
    await vi.waitFor(() =>
      expect(orchestrator.getDashboardSnapshot().actions['governance-consistency-check'].busy).toBe(true),
    );
    expect(orchestrator.getDashboardSnapshot().actions.rebind).toMatchObject({ enabled: false, busy: true });
    expect(orchestrator.getDashboardSnapshot().actions.start).toMatchObject({ enabled: false, busy: true });
    expect(orchestrator.getDashboardSnapshot().actions['open-edge']).toEqual({
      enabled: true,
      busy: false,
      reason: null,
    });
    await expect(orchestrator.runDashboardOperation(async () => undefined)).rejects.toMatchObject({
      code: 'DASHBOARD_ACTION_BUSY',
    });

    releaseOperation();
    await first;
    expect(orchestrator.getDashboardSnapshot().actions['governance-consistency-check'].busy).toBe(false);
  });

  it('keeps the same navigation action single-flight while allowing it during a round', async () => {
    let releaseOpenEdge!: () => void;
    const openEdge = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseOpenEdge = resolve;
        }),
    );
    const orchestrator = new MainOrchestrator(baseOptions({ callbacks: { openEdge } }));

    const first = orchestrator.executeCommand({ command: 'open-edge' });
    await vi.waitFor(() => expect(orchestrator.getDashboardSnapshot().actions['open-edge'].busy).toBe(true));
    await expect(orchestrator.executeCommand({ command: 'open-edge' })).resolves.toMatchObject({
      accepted: false,
      code: 'DASHBOARD_ACTION_BUSY',
    });
    releaseOpenEdge();
    await expect(first).resolves.toMatchObject({ accepted: true });
  });

  it('does not start again after a Sol protocol error has blocked the old output', async () => {
    const options = baseOptions({ edge: { observe: vi.fn(async () => observation(`${taskText()}\n${taskText()}`)) } });
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.start();
    await orchestrator.runRound();

    const before = orchestrator.getState();
    expect(orchestrator.getDashboardSnapshot().actions.start).toMatchObject({ enabled: false, busy: false });
    await expect(orchestrator.start()).resolves.toMatchObject({
      status: 'PAUSED',
      message: expect.stringContaining('新的 Sol 输出'),
    });
    await expect(orchestrator.executeCommand({ command: 'start', confirm: true })).resolves.toMatchObject({
      accepted: false,
      code: 'DASHBOARD_ACTION_UNAVAILABLE',
      message: expect.stringContaining('新的 Sol 输出'),
    });
    expect(orchestrator.getState()).toMatchObject({ active: before.active, recentError: before.recentError });
  });

  it('rechecks action state before executing commands and keeps open navigation available while a round is busy', async () => {
    let releaseObservation!: (value: EdgeSolObservation) => void;
    const openEdge = vi.fn(async () => undefined);
    const options = baseOptions({
      edge: {
        observe: vi.fn(
          () =>
            new Promise<EdgeSolObservation>((resolve) => {
              releaseObservation = resolve;
            }),
        ),
      },
      callbacks: { openEdge },
    });
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.start();
    const running = orchestrator.runRound();
    await vi.waitFor(() => expect(options.edge.observe).toHaveBeenCalledOnce());

    await expect(orchestrator.executeCommand({ command: 'retry-current-stage', confirm: true })).resolves.toEqual({
      accepted: false,
      code: 'DASHBOARD_ACTION_BUSY',
      message: '该动作正在处理中，请稍候。',
    });
    await expect(orchestrator.executeCommand({ command: 'open-edge' })).resolves.toEqual({
      accepted: true,
      code: 'OK',
      message: '命令已完成。',
    });
    expect(openEdge).toHaveBeenCalledOnce();

    releaseObservation(observation(''));
    await running;
    await expect(orchestrator.executeCommand({ command: 'retry-current-stage', confirm: true })).resolves.toMatchObject(
      {
        accepted: false,
        code: 'DASHBOARD_ACTION_UNAVAILABLE',
      },
    );
  });

  it.each([
    'ARCHITECTURE_FREEZE_FETCH_FAILED',
    'PROCESS_SPAWN_FAILED',
    'PROCESS_WAIT_FAILED',
    'COMMAND_FAILED',
    'COMMIT_FAILED',
    'GOVERNANCE_CHANGE_COMMIT_FAILED',
    'GOVERNANCE_RECONCILIATION_COMMIT_FAILED',
    'NETWORK_ERROR',
  ])('marks %s as retryable in the dashboard', async (code) => {
    const options = baseOptions({
      edge: {
        observe: vi.fn(async () => {
          const error = new Error(code);
          Object.assign(error, { code });
          throw error;
        }),
      },
    });
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.start();
    await orchestrator.runRound();
    expect(orchestrator.getDashboardSnapshot().actions['retry-current-stage']).toEqual({
      enabled: true,
      busy: false,
      reason: null,
    });
  });

  it.each([
    'ARCHITECTURE_FREEZE_URL_INVALID',
    'ARCHITECTURE_FREEZE_PATH_UNSAFE',
    'ARCHITECTURE_FREEZE_HASH_MISMATCH',
    'INVALID_RESULT',
    'BASELINE_CHANGED',
    'GOVERNANCE_RECONCILIATION_PROTOCOL_INVALID',
    'GOVERNANCE_RECONCILIATION_INVALID',
    'GOVERNANCE_CHANGE_ID_CONFLICT',
  ])('requires new Sol output for non-retryable error %s', async (code) => {
    const options = baseOptions({
      edge: {
        observe: vi.fn(async () => {
          const error = new Error(code);
          Object.assign(error, { code });
          throw error;
        }),
      },
    });
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.start();
    await orchestrator.runRound();
    expect(orchestrator.getDashboardSnapshot().actions['retry-current-stage']).toMatchObject({
      enabled: false,
      reason: expect.stringContaining('新的 Sol 输出'),
    });
  });

  it.each(['PROTECTED_PATH', 'UNAUTHORIZED_CHANGE'])('gates both start and retry for %s', async (code) => {
    const options = baseOptions({
      edge: {
        observe: vi.fn(async () => {
          const error = new Error(code);
          Object.assign(error, { code });
          throw error;
        }),
      },
    });
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.start();
    await orchestrator.runRound();

    expect(orchestrator.getDashboardSnapshot().actions.start).toMatchObject({
      enabled: false,
      reason: expect.stringContaining('新的 Sol 输出'),
    });
    expect(orchestrator.getDashboardSnapshot().actions['retry-current-stage']).toMatchObject({
      enabled: false,
      reason: expect.stringContaining('新的 Sol 输出'),
    });
    await expect(orchestrator.start()).resolves.toMatchObject({
      status: 'PAUSED',
      message: expect.stringContaining('新的 Sol 输出'),
    });
    await expect(orchestrator.executeCommand({ command: 'start', confirm: true })).resolves.toMatchObject({
      accepted: false,
      code: 'DASHBOARD_ACTION_UNAVAILABLE',
      message: expect.stringContaining('新的 Sol 输出'),
    });
  });

  it('computes dashboard action availability from state and in-flight work', async () => {
    let releaseObservation!: (value: EdgeSolObservation) => void;
    const options = baseOptions({
      edge: {
        observe: vi.fn(
          () =>
            new Promise<EdgeSolObservation>((resolve) => {
              releaseObservation = resolve;
            }),
        ),
      },
      callbacks: {
        rebind: vi.fn(async () => undefined),
        governanceConsistencyCheck: vi.fn(async () => undefined),
        openEdge: vi.fn(async () => undefined),
        openProject: vi.fn(async () => undefined),
        viewReport: vi.fn(async () => undefined),
      },
    });
    const orchestrator = new MainOrchestrator(options);

    expect(orchestrator.getDashboardSnapshot().actions.start.enabled).toBe(true);
    await orchestrator.start();
    const running = orchestrator.runRound();
    await vi.waitFor(() => expect(options.edge.observe).toHaveBeenCalledOnce());
    const busy = orchestrator.getDashboardSnapshot().actions;
    expect(busy.start).toMatchObject({ enabled: false, busy: true });
    expect(busy['retry-current-stage']).toMatchObject({ enabled: false, busy: true });
    expect(busy.pause).toEqual({ enabled: true, busy: false, reason: null });

    releaseObservation(observation(''));
    await running;
    expect(orchestrator.getDashboardSnapshot().actions.pause.enabled).toBe(true);
  });

  it('allows retry for recoverable errors and asks Sol for a new output on protocol errors', async () => {
    const recoverable = baseOptions({
      edge: {
        observe: vi.fn(async () => {
          const error = new Error('network unavailable');
          Object.assign(error, { code: 'NETWORK_ERROR' });
          throw error;
        }),
      },
    });
    const retryable = new MainOrchestrator(recoverable);
    await retryable.start();
    await retryable.runRound();
    expect(retryable.getDashboardSnapshot().actions['retry-current-stage']).toEqual({
      enabled: true,
      busy: false,
      reason: null,
    });

    const protocol = baseOptions({
      edge: { observe: vi.fn(async () => observation(`${taskText()}\n${taskText()}`)) },
    });
    const blocked = new MainOrchestrator(protocol);
    await blocked.start();
    await blocked.runRound();
    expect(blocked.getDashboardSnapshot().actions['retry-current-stage']).toMatchObject({
      enabled: false,
      busy: false,
    });
    expect(blocked.getDashboardSnapshot().actions['retry-current-stage'].reason).toContain('新的 Sol 输出');
  });

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
