import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { EdgeSolObservation } from '../../src/main/edge/types.js';
import type { CodexRunResult } from '../../src/main/codex/types.js';
import type { GitBaseline } from '../../src/main/git/types.js';
import { parseWritingBlocks, type LunaTaskBlock } from '../../src/shared/protocol/writing-block.js';
import { applyGovernanceReconciliation } from '../../src/main/governance/reconciliation-applier.js';
import {
  MainOrchestrator,
  OrchestratorError,
  type OrchestratorOptions,
  type OrchestratorState,
} from '../../src/main/orchestration/index.js';

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
    latestAssistantHash: createHash('sha256').update(text, 'utf8').digest('hex'),
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
    config: {
      model: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    },
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
  it('notifies the user and keeps waiting when Sol emits a user-facing message', async () => {
    const notifier = { notify: vi.fn() };
    const options = baseOptions({
      edge: { observe: vi.fn(async () => observation('[USER_MESSAGE]\n请确认产品取舍。\n[/USER_MESSAGE]')) },
      notifier,
    });
    const orchestrator = new MainOrchestrator(options);

    await orchestrator.start();
    const result = await orchestrator.runRound();

    expect(result).toMatchObject({ status: 'WAITING', message: 'Sol 已发送用户消息，已通知用户并等待回复。' });
    expect(orchestrator.getState()).toMatchObject({
      active: true,
      status: 'RUNNING',
      phase: 'WAITING_FOR_SOL',
      recentError: null,
    });
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'WAITING_FOR_USER',
        suggestion: '请确认产品取舍。',
        level: 'NEEDS_USER',
        error: expect.objectContaining({ code: 'SOL_USER_MESSAGE' }),
      }),
    );
    expect(options.codex.startTask).not.toHaveBeenCalled();
  });

  it('publishes reconciliation waiting state and pauses with a diagnostic on failure', async () => {
    const orchestrator = new MainOrchestrator(baseOptions());

    await orchestrator.beginGovernanceReconciliationWait();
    expect(orchestrator.getDashboardSnapshot()).toMatchObject({
      activeSolSession: null,
      stage: 'WAITING_FOR_SOL',
      status: 'RUNNING',
      actions: { 'governance-consistency-check': { busy: false } },
      loopGraph: { currentNodeId: 'wait-sol' },
    });

    await orchestrator.pauseGovernanceReconciliation(
      new OrchestratorError('GOVERNANCE_RECONCILIATION_TIMEOUT', '等待 Sol 回复超过 2 分钟。'),
    );
    expect(orchestrator.getDashboardSnapshot()).toMatchObject({
      stage: 'PAUSED',
      status: 'PAUSED',
      recentError: { code: 'GOVERNANCE_RECONCILIATION_TIMEOUT' },
      loopGraph: { currentNodeId: 'wait-sol' },
    });
  });

  it('projects a completed task round onto the fixed loop graph', async () => {
    const options = baseOptions({
      edge: { observe: vi.fn(async () => observation(`${governanceText()}\n${taskText()}`)) },
    });
    const orchestrator = new MainOrchestrator(options);

    await orchestrator.start();
    await orchestrator.runRound();

    const graph = orchestrator.getDashboardSnapshot().loopGraph;
    expect(graph.roundId).not.toBeNull();
    expect(graph.currentNodeId).toBe('wait-sol');
    expect(graph.nodes.map((node) => node.id)).toEqual([
      'read-sol',
      'parse-task',
      'repair-sol',
      'apply-updates',
      'sync-governance',
      'run-luna',
      'sync-code',
      'notify-sol',
      'wait-sol',
    ]);
    expect(graph.nodes.map((node) => node.state)).toEqual([
      'COMPLETED',
      'COMPLETED',
      'PENDING',
      'COMPLETED',
      'COMPLETED',
      'COMPLETED',
      'COMPLETED',
      'COMPLETED',
      'ACTIVE',
    ]);
    expect(graph.nodes.find((node) => node.id === 'run-luna')).toMatchObject({
      summary: 'Luna 已完成任务 task-1。',
      details: expect.arrayContaining(['任务：task-1', '会话：luna-1', '报告：docs/task-reports/task-1.md']),
      startedAt: expect.any(String),
      completedAt: expect.any(String),
    });
    expect(graph.nodes.filter((node) => node.state === 'ACTIVE')).toHaveLength(1);
  });

  it('completes a paused Luna node when retrying the pending code sync', async () => {
    let releaseLuna!: (run: CodexRunResult) => void;
    const options = baseOptions({
      codex: {
        startTask: vi.fn(async () => ({
          sessionId: 'luna-1',
          status: 'RUNNING' as const,
          result: new Promise<CodexRunResult>((resolve) => {
            releaseLuna = resolve;
          }),
        })),
      },
    });
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.start();
    const round = orchestrator.runRound();
    await vi.waitFor(() => expect(options.codex.startTask).toHaveBeenCalledOnce());

    await orchestrator.pause();
    releaseLuna(completedRun(parseWritingBlocks(taskText()).lunaTask!));
    await round;
    expect(orchestrator.getDashboardSnapshot().loopGraph.nodes.find((node) => node.id === 'run-luna')).toMatchObject({
      state: 'PAUSED',
    });

    await orchestrator.retryCurrentStage();
    const graph = orchestrator.getDashboardSnapshot().loopGraph;
    expect(graph.nodes.find((node) => node.id === 'run-luna')).toMatchObject({ state: 'COMPLETED' });
    expect(graph.nodes.find((node) => node.id === 'sync-code')).toMatchObject({ state: 'COMPLETED' });
  });

  it('persists and restores the minimal pending code sync after Luna returns during a pause', async () => {
    let releaseLuna!: (run: CodexRunResult) => void;
    let saved: import('../../src/main/orchestration/index.js').OrchestratorState | null = null;
    const stateStore = {
      load: vi.fn(async () => saved),
      save: vi.fn(async (state) => {
        saved = state;
      }),
    };
    const options = baseOptions({
      stateStore,
      codex: {
        startTask: vi.fn(async () => ({
          sessionId: 'luna-1',
          status: 'RUNNING' as const,
          result: new Promise<CodexRunResult>((resolve) => {
            releaseLuna = resolve;
          }),
        })),
      },
    });
    const running = new MainOrchestrator(options);
    await running.start();
    const round = running.runRound();
    await vi.waitFor(() => expect(options.codex.startTask).toHaveBeenCalledOnce());

    await running.pause();
    releaseLuna(completedRun(parseWritingBlocks(taskText()).lunaTask!));
    await round;

    const persisted = saved as OrchestratorState | null;
    expect(persisted?.pendingCodeSync).toMatchObject({
      taskId: 'task-1',
      reportPath: 'docs/task-reports/task-1.md',
      allowedPaths: ['src/**', 'docs/task-reports/**'],
      protectedPaths: ['src/main/app.ts'],
      testsPassed: true,
      sessionId: 'luna-1',
      outputKey: expect.any(String),
      baseline: expect.objectContaining({ head: 'base-commit' }),
    });
    expect(JSON.stringify(persisted?.pendingCodeSync)).not.toContain('stdout');
    expect(JSON.stringify(persisted?.pendingCodeSync)).not.toContain('events');

    const restored = new MainOrchestrator(options);
    await restored.initialize();
    expect(restored.getState()).toMatchObject({
      phase: 'PAUSED',
      pendingCodeSync: expect.objectContaining({ taskId: 'task-1' }),
    });

    const started = await restored.start();
    expect(started.phase).toBe('SYNCING_CODE');
    expect(restored.getDashboardSnapshot().loopGraph.currentNodeId).toBe('sync-code');
    await expect(restored.runRound()).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(options.git.syncCode).toHaveBeenCalledTimes(1);
    expect(restored.getState().pendingCodeSync).toBeNull();
  });

  it('treats missing or malformed pending code sync fields as a legacy empty value', async () => {
    const initial = new MainOrchestrator(baseOptions()).getState();
    const stored = { ...initial, pendingCodeSync: undefined } as unknown as OrchestratorState;
    const legacyStore = {
      load: vi.fn(async () => stored),
      save: vi.fn(async () => undefined),
    };
    const restoredLegacy = new MainOrchestrator(baseOptions({ stateStore: legacyStore }));
    await restoredLegacy.initialize();
    expect(restoredLegacy.getState().pendingCodeSync).toBeNull();
    expect(restoredLegacy.getState().pendingReconciliationSync).toBeNull();
    expect(restoredLegacy.getState().retryCount).toBe(0);

    const malformedStored = {
      ...initial,
      pendingCodeSync: {
        taskId: 'task-1',
        reportPath: 'docs/task-reports/task-1.md',
        allowedPaths: ['src/**', 42],
        protectedPaths: ['x'.repeat(3000)],
        baseline: { ...baseline },
        testsPassed: true,
        sessionId: 'luna-1',
        outputKey: 'key',
      },
    } as never;
    const malformedStore = {
      load: vi.fn(async () => malformedStored),
      save: vi.fn(async () => undefined),
    };
    const restoredMalformed = new MainOrchestrator(baseOptions({ stateStore: malformedStore }));
    await restoredMalformed.initialize();
    expect(restoredMalformed.getState().pendingCodeSync).toMatchObject({
      allowedPaths: ['src/**'],
      protectedPaths: [`${'x'.repeat(1023)}…`],
      baseline: { head: 'base-commit' },
    });
  });

  it.each(['TIMEOUT', 'REPORT_MISSING', 'TESTS_NOT_PASSED'] as const)(
    'maps %s from failFor to a recoverable graph block',
    async (code) => {
      const task = parseWritingBlocks(taskText()).lunaTask!;
      const failedRun = {
        ...completedRun(task),
        status: code,
        error: { code, message: `failure-${code}` },
      } as CodexRunResult;
      const options = baseOptions({
        codex: {
          startTask: vi.fn(async () => ({
            sessionId: 'luna-1',
            status: 'RUNNING' as const,
            result: Promise.resolve(failedRun),
          })),
        },
      });
      const orchestrator = new MainOrchestrator(options);
      await orchestrator.start();
      await orchestrator.runRound();

      expect(orchestrator.getDashboardSnapshot().loopGraph.nodes.find((node) => node.id === 'run-luna')).toMatchObject({
        state: 'RECOVERABLE_BLOCKED',
        details: expect.arrayContaining([`错误：${code}`]),
      });
    },
  );

  it('marks omitted governance, Luna, code, and notification work as not applicable', async () => {
    const orchestrator = new MainOrchestrator(baseOptions({ edge: { observe: vi.fn(async () => observation('')) } }));
    await orchestrator.start();
    await orchestrator.runRound();

    const graph = orchestrator.getDashboardSnapshot().loopGraph;
    expect(graph.currentNodeId).toBe('wait-sol');
    expect(graph.nodes.map((node) => node.state)).toEqual([
      'COMPLETED',
      'COMPLETED',
      'PENDING',
      'NOT_APPLICABLE',
      'NOT_APPLICABLE',
      'NOT_APPLICABLE',
      'NOT_APPLICABLE',
      'NOT_APPLICABLE',
      'ACTIVE',
    ]);
  });

  it('maps recoverable and user-action failures onto the active graph node', async () => {
    const recoverable = new MainOrchestrator(
      baseOptions({ edge: { observe: vi.fn(async () => observation('', 'NETWORK_ERROR')) } }),
    );
    await recoverable.start();
    await recoverable.runRound();
    expect(recoverable.getDashboardSnapshot().loopGraph.currentNodeId).toBe('read-sol');
    expect(recoverable.getDashboardSnapshot().loopGraph.nodes.find((node) => node.id === 'read-sol')).toMatchObject({
      state: 'RECOVERABLE_BLOCKED',
      details: expect.arrayContaining(['错误：NETWORK_ERROR']),
    });

    const needsUser = new MainOrchestrator(
      baseOptions({ edge: { observe: vi.fn(async () => observation('', 'AUTH_REQUIRED')) } }),
    );
    await needsUser.start();
    await needsUser.runRound();
    expect(needsUser.getDashboardSnapshot().loopGraph.currentNodeId).toBe('read-sol');
    expect(needsUser.getDashboardSnapshot().loopGraph.nodes.find((node) => node.id === 'read-sol')).toMatchObject({
      state: 'NEEDS_USER_ACTION',
      details: expect.arrayContaining(['错误：AUTH_REQUIRED']),
    });
  });

  it('persists only the interrupted graph snapshot and never resumes its process after restart', async () => {
    let saved: import('../../src/main/orchestration/index.js').OrchestratorState | null = null;
    let releaseObservation!: (value: EdgeSolObservation) => void;
    const stateStore = {
      load: vi.fn(async () => saved),
      save: vi.fn(async (state) => {
        saved = state;
      }),
    };
    const options = baseOptions({
      stateStore,
      edge: {
        observe: vi.fn(
          () =>
            new Promise<EdgeSolObservation>((resolve) => {
              releaseObservation = resolve;
            }),
        ),
      },
    });
    const running = new MainOrchestrator(options);
    await running.start();
    const inFlight = running.runRound();
    await vi.waitFor(() => expect(options.edge.observe).toHaveBeenCalledOnce());
    const releaseInitialObservation = releaseObservation;

    const restarted = new MainOrchestrator(options);
    await restarted.initialize();
    expect(restarted.getDashboardSnapshot().loopGraph.currentNodeId).toBe('read-sol');
    expect(restarted.getDashboardSnapshot().loopGraph.nodes.find((node) => node.id === 'read-sol')).toMatchObject({
      state: 'PAUSED',
    });
    expect(restarted.getState()).toMatchObject({ active: false, status: 'PAUSED', phase: 'PAUSED' });
    expect(options.codex.startTask).not.toHaveBeenCalled();

    await restarted.start();
    expect(restarted.getState()).toMatchObject({ active: true, status: 'RUNNING', phase: 'READING_SOL' });
    expect(restarted.getDashboardSnapshot().loopGraph).toMatchObject({ currentNodeId: 'read-sol' });
    expect(restarted.getDashboardSnapshot().loopGraph.nodes.find((node) => node.id === 'read-sol')).toMatchObject({
      state: 'ACTIVE',
    });

    await vi.waitFor(() => expect(options.edge.observe).toHaveBeenCalledTimes(2));
    const releaseRestartedObservation = releaseObservation;
    releaseRestartedObservation(observation(''));
    await restarted.runRound();
    releaseInitialObservation(observation(''));
    await inFlight;
  });

  it('restores wait-sol after a user pause without creating a new round', async () => {
    const orchestrator = new MainOrchestrator(baseOptions());
    await orchestrator.start();
    await orchestrator.runRound();
    const roundId = orchestrator.getDashboardSnapshot().loopGraph.roundId;

    await orchestrator.pause();
    expect(orchestrator.getDashboardSnapshot().loopGraph.currentNodeId).toBe('wait-sol');
    expect(orchestrator.getDashboardSnapshot().loopGraph.nodes.find((node) => node.id === 'wait-sol')).toMatchObject({
      state: 'PAUSED',
    });

    await orchestrator.start();
    expect(orchestrator.getDashboardSnapshot().loopGraph).toMatchObject({
      roundId,
      currentNodeId: 'read-sol',
    });
    expect(orchestrator.getDashboardSnapshot().loopGraph.nodes.find((node) => node.id === 'read-sol')).toMatchObject({
      state: 'ACTIVE',
    });
    await expect(orchestrator.runRound()).resolves.toMatchObject({ status: 'DUPLICATE' });
    expect(orchestrator.getDashboardSnapshot().loopGraph.roundId).toBe(roundId);
  });

  it('restores wait-sol before retryCurrentStage polls again', async () => {
    const options = baseOptions({
      edge: {
        observe: vi.fn().mockResolvedValueOnce(observation('', 'NETWORK_ERROR')).mockResolvedValueOnce(observation('')),
      },
    });
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.start();
    await orchestrator.runRound();
    expect(orchestrator.getDashboardSnapshot().loopGraph.nodes.find((node) => node.id === 'read-sol')).toMatchObject({
      state: 'RECOVERABLE_BLOCKED',
    });

    await orchestrator.retryCurrentStage();
    expect(orchestrator.getState()).toMatchObject({ active: true, status: 'RUNNING', phase: 'WAITING_FOR_SOL' });
    expect(orchestrator.getDashboardSnapshot().loopGraph.currentNodeId).toBe('wait-sol');
    expect(orchestrator.getDashboardSnapshot().loopGraph.nodes.find((node) => node.id === 'wait-sol')).toMatchObject({
      state: 'ACTIVE',
    });
  });

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
    expect(orchestrator.getDashboardSnapshot().loopGraph.currentNodeId).toBe('read-sol');
    expect(orchestrator.getDashboardSnapshot().loopGraph.nodes.find((node) => node.id === 'read-sol')).toMatchObject({
      state: 'PAUSED',
    });
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

    expect(orchestrator.getDashboardSnapshot().actions.start).toMatchObject({ enabled: false, busy: false });
    await expect(orchestrator.start()).resolves.toMatchObject({
      status: 'WAITING',
      message: '自动循环已经在运行中。',
    });
    expect(options.sol?.sendMessage).toHaveBeenCalledOnce();
    expect(orchestrator.getState()).toMatchObject({ active: true, status: 'RUNNING', recentError: null });
    expect(orchestrator.getDashboardSnapshot().loopGraph).toMatchObject({ currentNodeId: 'repair-sol' });
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
    'WRITING_BLOCK_OUT_OF_BLOCK_CONTENT',
    'WRITING_BLOCK_BODY_INVALID_JSON',
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
    expect(orchestrator.getDashboardSnapshot().actions.start).toEqual({
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
      reason: expect.stringContaining('启动自动循环'),
    });
  });

  it.each(['PROTECTED_PATH', 'UNAUTHORIZED_CHANGE'])(
    'keeps start available while gating retry for %s',
    async (code) => {
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

      expect(orchestrator.getDashboardSnapshot().actions.start).toMatchObject({ enabled: true, busy: false });
      expect(orchestrator.getDashboardSnapshot().actions['retry-current-stage']).toMatchObject({
        enabled: false,
        reason: expect.stringContaining('启动自动循环'),
      });
      await expect(orchestrator.start()).resolves.toMatchObject({
        status: 'WAITING',
        message: '编排器已启动，正在读取 Sol。',
      });
    },
  );

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
    expect(blocked.getDashboardSnapshot().actions['retry-current-stage'].reason).toContain('自动循环运行中');
  });

  it('uses a stable three-button state machine for idle, running, and paused states', async () => {
    const orchestrator = new MainOrchestrator(baseOptions());

    expect(orchestrator.getDashboardSnapshot().actions).toMatchObject({
      start: { enabled: true, busy: false },
      pause: { enabled: false, busy: false },
      'retry-current-stage': { enabled: false, busy: false },
    });

    await orchestrator.start();
    await orchestrator.runRound();
    expect(orchestrator.getDashboardSnapshot().actions).toMatchObject({
      start: { enabled: false, busy: false },
      pause: { enabled: true, busy: false },
      'retry-current-stage': { enabled: false, busy: false },
    });

    await orchestrator.pause();
    expect(orchestrator.getDashboardSnapshot().actions).toMatchObject({
      start: { enabled: true, busy: false },
      pause: { enabled: false, busy: false },
      'retry-current-stage': { enabled: false, busy: false },
    });
  });

  it('stops ordinary retries after three persisted attempts', async () => {
    const observe = vi.fn(async () => {
      const error = new Error('network unavailable');
      Object.assign(error, { code: 'NETWORK_ERROR' });
      throw error;
    });
    let saved: OrchestratorState | null = null;
    const orchestrator = new MainOrchestrator(
      baseOptions({
        edge: { observe },
        stateStore: {
          load: vi.fn(async () => saved),
          save: vi.fn(async (state) => {
            saved = state;
          }),
        },
      }),
    );
    await orchestrator.start();
    await orchestrator.runRound();
    await orchestrator.retryCurrentStage();
    await orchestrator.retryCurrentStage();
    await orchestrator.retryCurrentStage();

    expect(observe).toHaveBeenCalledTimes(4);
    expect(orchestrator.getState()).toMatchObject({ retryCount: 3, recentError: { code: 'NETWORK_ERROR' } });
    expect((saved as OrchestratorState | null)?.retryCount).toBe(3);

    const exhausted = await orchestrator.retryCurrentStage();

    expect(exhausted).toMatchObject({ status: 'PAUSED', message: expect.stringContaining('最多 3 次重试') });
    expect(orchestrator.getState()).toMatchObject({
      active: false,
      status: 'NEEDS_USER_ACTION',
      retryCount: 3,
      recentError: { code: 'RETRY_LIMIT_EXCEEDED' },
    });
    expect(observe).toHaveBeenCalledTimes(4);
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

    expect(duplicate.status).toBe('WAITING');
    expect(options.codex.startTask).toHaveBeenCalledOnce();
    expect(orchestrator.getDashboardSnapshot().loopGraph.nodes.find((node) => node.id === 'wait-sol')).toMatchObject({
      summary: '等待 Sol 产生新的未处理输出。',
    });
  });

  it('persists the concrete wait reason when Sol has no new stable output', async () => {
    const orchestrator = new MainOrchestrator(
      baseOptions({ edge: { observe: vi.fn(async () => observation('', 'THINKING')) } }),
    );

    await orchestrator.start();
    await orchestrator.runRound();
    await orchestrator.runRound();

    expect(orchestrator.getDashboardSnapshot().loopGraph.nodes.find((node) => node.id === 'wait-sol')).toMatchObject({
      state: 'ACTIVE',
      summary: '等待 Sol 产生新的稳定输出。',
    });
  });

  it('updates the wait node with the duplicate polling reason without starting work', async () => {
    const saves: import('../../src/main/orchestration/index.js').OrchestratorState[] = [];
    const options = baseOptions({
      stateStore: {
        load: vi.fn(async () => saves.at(-1) ?? null),
        save: vi.fn(async (state) => {
          saves.push(state);
        }),
      },
    });
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.start();
    await orchestrator.runRound();
    const completedGraph = orchestrator.getDashboardSnapshot().loopGraph;
    const saveCount = saves.length;

    await expect(orchestrator.runRound()).resolves.toMatchObject({ status: 'WAITING' });

    expect(orchestrator.getDashboardSnapshot().loopGraph).toMatchObject({
      roundId: completedGraph.roundId,
      currentNodeId: 'wait-sol',
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: 'wait-sol', summary: '等待 Sol 产生新的未处理输出。' }),
      ]),
    });
    expect(saves.length).toBeGreaterThan(saveCount);
  });

  it('sanitizes graph and error diagnostics before persisting the state snapshot', async () => {
    const saves: import('../../src/main/orchestration/index.js').OrchestratorState[] = [];
    const options = baseOptions({
      stateStore: {
        load: vi.fn(async () => null),
        save: vi.fn(async (state) => {
          saves.push(state);
        }),
      },
      edge: {
        observe: vi.fn(async () => {
          const error = new Error(`Authorization=Bearer super-secret ${'x'.repeat(600)}`);
          Object.assign(error, { code: 'NETWORK_ERROR' });
          throw error;
        }),
      },
    });
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.start();
    await orchestrator.runRound();

    const saved = saves.at(-1);
    expect(saved).toBeDefined();
    const graph = saved!.loopGraph;
    expect(graph.nodes).toHaveLength(9);
    expect(graph.nodes.filter((node) => node.state === 'ACTIVE')).toHaveLength(0);
    for (const node of graph.nodes) {
      expect(node.summary.length).toBeLessThanOrEqual(240);
      expect(node.details.length).toBeLessThanOrEqual(16);
      expect(node.details.every((detail) => detail.length <= 240)).toBe(true);
      expect(JSON.stringify(node)).not.toContain('super-secret');
    }
    expect(saved!.recentError?.message).not.toContain('super-secret');
    expect(saved!.recentError?.message.length).toBeLessThanOrEqual(240);
  });

  it('pauses on malformed or multi-task output before any side effect', async () => {
    const duplicateTaskOutput = `${taskText()}\n${taskText().replace('task-1', 'task-2')}`;
    const options = baseOptions({ edge: { observe: vi.fn(async () => observation(duplicateTaskOutput)) } });
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.start();
    const result = await orchestrator.runRound();

    expect(result.status).toBe('WAITING');
    expect(orchestrator.getState()).toMatchObject({
      active: true,
      status: 'RUNNING',
      phase: 'WAITING_FOR_SOL',
      recentError: null,
    });
    expect(orchestrator.getDashboardSnapshot().loopGraph).toMatchObject({ currentNodeId: 'repair-sol' });
    expect(options.sol?.sendMessage).toHaveBeenCalledOnce();
    expect(options.codex.startTask).not.toHaveBeenCalled();
    expect(options.git.syncGovernance).not.toHaveBeenCalled();
  });

  it('repairs an unsafe reconciliation output once and then requires user action', async () => {
    const reconciliation = `[WRITING_BLOCK type="GOVERNANCE_RECONCILIATION"]
{
  "schema_version": 1,
  "status": "CHANGES_REQUIRED",
  "baseline_commit": "base-commit",
  "files": [{
    "path": "docs/governance/policy.md",
    "action": "replace",
    "reason": "clarify policy",
    "sha256_before": "0000000000000000000000000000000000000000000000000000000000000000",
    "content": "Updated policy"
  }]
}
[/WRITING_BLOCK]`;
    const apply = vi.fn(async () => {
      throw new OrchestratorError('GOVERNANCE_RECONCILIATION_PATH_PROTECTED', '禁止修改受保护路径：.git/config。');
    });
    const options = baseOptions({ reconciliation: { apply } });
    const orchestrator = new MainOrchestrator(options);

    const first = await orchestrator.runGovernanceReconciliation({
      solOutput: reconciliation,
      baseline,
      outputKey: 'reconciliation-output-1',
    });

    expect(first).toMatchObject({ status: 'WAITING', reconciliationStatus: null });
    expect(orchestrator.getState()).toMatchObject({
      active: true,
      status: 'RUNNING',
      phase: 'WAITING_FOR_SOL',
      autoRepair: {
        sourceOutputKey: 'reconciliation-output-1',
        errorCode: 'GOVERNANCE_RECONCILIATION_PATH_PROTECTED',
        attempt: 1,
      },
    });
    expect(orchestrator.getDashboardSnapshot().loopGraph).toMatchObject({ currentNodeId: 'repair-sol' });
    expect(options.sol?.sendMessage).toHaveBeenCalledOnce();
    expect(options.sol?.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('不删除任何本地文件') }),
    );

    const second = await orchestrator.runGovernanceReconciliation({
      solOutput: reconciliation,
      baseline,
      outputKey: 'reconciliation-output-2',
    });

    expect(second).toMatchObject({ status: 'PAUSED' });
    expect(orchestrator.getState()).toMatchObject({
      active: false,
      status: 'NEEDS_USER_ACTION',
      recentError: { code: 'GOVERNANCE_RECONCILIATION_PATH_PROTECTED' },
    });
    expect(options.sol?.sendMessage).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('validates every block before applying an earlier governance block or starting Luna', async () => {
    const invalidTask = taskText().replace('"validation_commands": ["npm test"]', '"validation_commands": "npm test"');
    const options = baseOptions({
      edge: { observe: vi.fn(async () => observation(`${governanceText()}\n${invalidTask}`)) },
    });
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.start();

    const result = await orchestrator.runRound();

    expect(result.status).toBe('WAITING');
    expect(orchestrator.getState()).toMatchObject({ active: true, status: 'RUNNING', phase: 'WAITING_FOR_SOL' });
    expect(orchestrator.getDashboardSnapshot().loopGraph).toMatchObject({ currentNodeId: 'repair-sol' });
    expect(options.sol?.sendMessage).toHaveBeenCalledOnce();
    expect(options.git.captureBaseline).not.toHaveBeenCalled();
    expect(options.governance?.applyAll).not.toHaveBeenCalled();
    expect(options.architecture?.download).not.toHaveBeenCalled();
    expect(options.git.syncGovernance).not.toHaveBeenCalled();
    expect(options.git.syncCode).not.toHaveBeenCalled();
    expect(options.codex.startTask).not.toHaveBeenCalled();
  });

  it('refuses retry when the previous output requires new Sol output', async () => {
    const invalidTask = taskText().replace('"validation_commands": ["npm test"]', '"validation_commands": "npm test"');
    const observe = vi.fn(async () =>
      observation(`${governanceText()}
${invalidTask}`),
    );
    const options = baseOptions({ edge: { observe } });
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.start();
    await orchestrator.runRound();

    const retry = await orchestrator.retryCurrentStage();

    expect(retry).toMatchObject({
      status: 'WAITING',
      phase: 'WAITING_FOR_SOL',
      message: '等待 Sol 产生新的未处理输出。',
    });
    expect(orchestrator.getState()).toMatchObject({
      active: true,
      status: 'RUNNING',
      phase: 'WAITING_FOR_SOL',
      recentError: null,
    });
    expect(observe).toHaveBeenCalledTimes(2);
    expect(options.git.captureBaseline).not.toHaveBeenCalled();
    expect(options.governance?.applyAll).not.toHaveBeenCalled();
    expect(options.architecture?.download).not.toHaveBeenCalled();
    expect(options.git.syncGovernance).not.toHaveBeenCalled();
    expect(options.git.syncCode).not.toHaveBeenCalled();
    expect(options.codex.startTask).not.toHaveBeenCalled();
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

  it('routes governance reconciliation output from the ordinary loop to the dedicated applier', async () => {
    const reconciliation = `[WRITING_BLOCK type="GOVERNANCE_RECONCILIATION"]
{
  "schema_version": 1,
  "status": "CHANGES_REQUIRED",
  "baseline_commit": "base-commit",
  "files": [{
    "path": "docs/governance/policy.md",
    "action": "replace",
    "reason": "clarify policy",
    "sha256_before": "0000000000000000000000000000000000000000000000000000000000000000",
    "content": "Updated policy"
  }]
}
[/WRITING_BLOCK]`;
    const options = baseOptions({
      edge: { observe: vi.fn(async () => observation(reconciliation)) },
      reconciliation: {
        apply: vi.fn(async () => ({
          runId: 'reconciliation-loop',
          changedPaths: ['docs/governance/policy.md'],
          backupPaths: ['.web-chat2codex/backups/reconciliation/reconciliation-loop/docs/governance/policy.md'],
        })),
      },
    });
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.start();
    const result = await orchestrator.runRound();

    expect(result.status).toBe('COMPLETED');
    expect(orchestrator.getState()).toMatchObject({
      status: 'RUNNING',
      phase: 'WAITING_FOR_SOL',
      recentError: null,
    });
    expect(options.codex.startTask).not.toHaveBeenCalled();
    expect(options.reconciliation?.apply).toHaveBeenCalledOnce();
    expect(options.git.syncGovernance).toHaveBeenCalledOnce();
    expect((await orchestrator.runRound()).status).toBe('WAITING');
    expect(options.reconciliation?.apply).toHaveBeenCalledOnce();
  });

  it('processes the latest reconciliation output without a baseline history shortcut', async () => {
    const reconciliation = `[WRITING_BLOCK type="GOVERNANCE_RECONCILIATION"]
{
  "schema_version": 1,
  "status": "CHANGES_REQUIRED",
  "baseline_commit": "base-commit",
  "files": [{
    "path": "docs/governance/policy.md",
    "action": "replace",
    "reason": "clarify policy",
    "sha256_before": "0000000000000000000000000000000000000000000000000000000000000000",
    "content": "Updated policy"
  }]
}
[/WRITING_BLOCK]`;
    const reconciliationObservation = observation(reconciliation);
    const observe = vi
      .fn()
      .mockResolvedValueOnce(observation('', 'THINKING'))
      .mockResolvedValue(reconciliationObservation);
    const options = baseOptions({
      edge: { observe },
      reconciliation: {
        apply: vi.fn(async () => ({
          runId: 'reconciliation-baseline',
          changedPaths: ['docs/governance/policy.md'],
          backupPaths: [],
        })),
      },
    });
    const orchestrator = new MainOrchestrator(options);

    await orchestrator.start();
    await orchestrator.runRound();
    await orchestrator.pause();
    await orchestrator.start();
    const result = await orchestrator.runRound();

    expect(result.status).toBe('COMPLETED');
    expect(options.reconciliation?.apply).toHaveBeenCalledOnce();
    expect(options.git.syncGovernance).toHaveBeenCalledOnce();
    expect(orchestrator.getState()).toMatchObject({ phase: 'WAITING_FOR_SOL', recentError: null });
  });

  it('parses the latest output and asks before resuming a matching interrupted execution', async () => {
    const reconciliation = `[WRITING_BLOCK type="GOVERNANCE_RECONCILIATION"]
{
  "schema_version": 1,
  "status": "CHANGES_REQUIRED",
  "baseline_commit": "base-commit",
  "files": [{
    "path": "docs/governance/policy.md",
    "action": "replace",
    "reason": "clarify policy",
    "sha256_before": "0000000000000000000000000000000000000000000000000000000000000000",
    "content": "Updated policy"
  }]
}
[/WRITING_BLOCK]`;
    let saved: OrchestratorState | null = null;
    const first = new MainOrchestrator(
      baseOptions({
        edge: { observe: vi.fn(async () => observation(reconciliation)) },
        reconciliation: {
          apply: vi.fn(async () => {
            throw new OrchestratorError('GOVERNANCE_RECONCILIATION_APPLY_FAILED', '一致性文件写入失败。');
          }),
        },
        stateStore: {
          load: vi.fn(async () => null),
          save: vi.fn(async (state) => {
            saved = state;
          }),
        },
      }),
    );
    await first.start();
    await first.runRound();
    expect((saved as OrchestratorState | null)?.executionRecovery).toMatchObject({
      outputType: 'GOVERNANCE_RECONCILIATION',
      interruptedNodeId: 'apply-updates',
      awaitingConfirmation: true,
      error: { code: 'GOVERNANCE_RECONCILIATION_APPLY_FAILED' },
    });

    const second = new MainOrchestrator(
      baseOptions({
        edge: { observe: vi.fn(async () => observation(reconciliation)) },
        reconciliation: {
          apply: vi.fn(async () => ({
            runId: 'reconciliation-resumed',
            changedPaths: ['docs/governance/policy.md'],
            backupPaths: [],
          })),
        },
        stateStore: {
          load: vi.fn(async () => saved),
          save: vi.fn(async (state) => {
            saved = state;
          }),
        },
      }),
    );
    await second.start();
    const waiting = await second.runRound();

    expect(waiting).toMatchObject({ status: 'PAUSED', phase: 'PAUSED' });
    expect(second.getDashboardSnapshot()).toMatchObject({
      status: 'NEEDS_USER_ACTION',
      recentError: { code: 'EXECUTION_RECOVERY_CONFIRMATION_REQUIRED' },
      recovery: {
        outputType: 'GOVERNANCE_RECONCILIATION',
        interruptedNodeId: 'parse-task',
        error: { code: 'EXECUTION_RECOVERY_CONFIRMATION_REQUIRED' },
      },
      actions: { 'continue-interrupted': { enabled: true, busy: false } },
      loopGraph: { currentNodeId: 'parse-task' },
    });
    expect(second.getDashboardSnapshot().loopGraph.nodes.find((node) => node.id === 'parse-task')?.details).toEqual(
      expect.arrayContaining([expect.stringContaining('中断原因')]),
    );

    const resumed = await second.executeCommand({ command: 'continue-interrupted' });
    expect(resumed).toMatchObject({ accepted: true, code: 'CONTINUE_COMPLETED' });
    expect(second.getState().executionRecovery).toBeNull();
    expect(second.getState().processedOutputKey).not.toBeNull();
  });

  it('migrates the legacy wrong-entrypoint state before the next Sol read', async () => {
    const legacy = new MainOrchestrator(baseOptions()).getState();
    legacy.status = 'NEEDS_USER_ACTION';
    legacy.phase = 'PAUSED';
    legacy.recentError = {
      code: 'GOVERNANCE_RECONCILIATION_WRONG_ENTRYPOINT',
      message: 'GOVERNANCE_RECONCILIATION 只能通过治理一致性检查入口处理。',
    };
    legacy.loopGraph = {
      ...legacy.loopGraph,
      roundId: 'round-legacy',
      currentNodeId: 'parse-task',
      nodes: legacy.loopGraph.nodes.map((node) =>
        node.id === 'parse-task'
          ? {
              ...node,
              state: 'NEEDS_USER_ACTION',
              startedAt: '2026-09-10T01:02:03.000Z',
            }
          : node,
      ),
    };
    const saved: OrchestratorState[] = [];
    const orchestrator = new MainOrchestrator(
      baseOptions({
        stateStore: {
          load: vi.fn(async () => legacy),
          save: vi.fn(async (state) => {
            saved.push(state);
          }),
        },
      }),
    );

    await orchestrator.initialize();

    expect(orchestrator.getState()).toMatchObject({
      recentError: { code: 'EXECUTION_RECOVERY_PENDING' },
      executionRecovery: {
        outputKey: '__legacy_recovery_pending__',
        interruptedNodeId: 'parse-task',
        awaitingConfirmation: true,
        error: { code: 'GOVERNANCE_RECONCILIATION_WRONG_ENTRYPOINT' },
      },
    });
    expect(saved.length).toBeGreaterThan(0);
  });

  it('retries only governance sync after the real applier has already changed files', async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'web-chat2codex-reconciliation-'));
    const policyPath = join(repositoryRoot, 'docs', 'governance', 'policy.md');
    await mkdir(join(repositoryRoot, 'docs', 'governance'), { recursive: true });
    await writeFile(policyPath, 'Original policy', 'utf8');
    const originalSha = createHash('sha256').update('Original policy', 'utf8').digest('hex');
    const reconciliation = `[WRITING_BLOCK type="GOVERNANCE_RECONCILIATION"]
{
  "schema_version": 1,
  "status": "CHANGES_REQUIRED",
  "baseline_commit": "base-commit",
  "files": [
    {
      "path": "docs/governance/policy.md",
      "action": "replace",
      "reason": "clarify policy",
      "sha256_before": "${originalSha}",
      "content": "Updated policy"
    }
  ]
}
[/WRITING_BLOCK]`;
    const apply = vi.fn(async (block) =>
      applyGovernanceReconciliation(repositoryRoot, block, { runId: () => 'reconciliation-1' }),
    );
    let saved: OrchestratorState | null = null;
    const options = baseOptions({
      project: { ...baseOptions().project, localPath: repositoryRoot },
      git: {
        ...baseOptions().git,
        captureBaseline: vi.fn(async () => ({ ...baseline, repositoryRoot })),
      },
      reconciliation: { apply },
      stateStore: {
        load: vi.fn(async () => saved),
        save: vi.fn(async (state) => {
          saved = state;
        }),
      },
    });
    vi.mocked(options.git.syncGovernance)
      .mockRejectedValueOnce(
        Object.assign(new Error('reconciliation commit failed'), {
          code: 'GOVERNANCE_RECONCILIATION_COMMIT_FAILED',
        }),
      )
      .mockResolvedValueOnce({
        kind: 'governance',
        commit: 'reconciliation-commit',
        pushed: true,
        remoteCommit: 'reconciliation-commit',
        pushRetried: false,
      });
    const orchestrator = new MainOrchestrator(options);

    const first = await orchestrator.runGovernanceReconciliation({
      solOutput: reconciliation,
      baseline: { ...baseline, repositoryRoot },
    });

    expect(first.status).toBe('PAUSED');
    expect(orchestrator.getState()).toMatchObject({
      active: false,
      status: 'PAUSED',
      phase: 'PAUSED',
      recentError: { code: 'GOVERNANCE_RECONCILIATION_COMMIT_FAILED' },
    });
    expect(await readFile(policyPath, 'utf8')).toBe('Updated policy');
    expect(apply).toHaveBeenCalledOnce();
    expect(orchestrator.getState().pendingReconciliationSync).toMatchObject({
      runId: 'reconciliation-1',
      changedPaths: ['docs/governance/policy.md'],
      outputKey: expect.any(String),
      baseline: { repositoryRoot },
    });
    expect((saved as OrchestratorState | null)?.pendingReconciliationSync).toMatchObject({
      runId: 'reconciliation-1',
      changedPaths: ['docs/governance/policy.md'],
    });
    const pendingSnapshot = saved as unknown as OrchestratorState;
    expect(JSON.stringify((saved as OrchestratorState | null)?.pendingReconciliationSync)).not.toContain(
      'Updated policy',
    );
    expect(options.git.syncGovernance).toHaveBeenCalledOnce();
    expect(options.governance?.applyAll).not.toHaveBeenCalled();
    expect(options.git.syncCode).not.toHaveBeenCalled();
    expect(options.codex.startTask).not.toHaveBeenCalled();

    const started = new MainOrchestrator({
      ...options,
      stateStore: {
        load: vi.fn(async () => saved),
        save: vi.fn(async () => undefined),
      },
    });
    await started.start();
    expect(started.getState()).toMatchObject({
      active: true,
      status: 'RUNNING',
      phase: 'SYNCING_GOVERNANCE',
      retryCount: 0,
      pendingReconciliationSync: { runId: 'reconciliation-1' },
    });
    expect(options.git.syncGovernance).toHaveBeenCalledOnce();

    const exhausted = new MainOrchestrator({
      ...options,
      stateStore: {
        load: vi.fn(async () => ({ ...pendingSnapshot, retryCount: 3 })),
        save: vi.fn(async () => undefined),
      },
    });
    const exhaustedStart = await exhausted.start();
    expect(exhaustedStart).toMatchObject({ status: 'PAUSED', message: expect.stringContaining('最多 3 次重试') });
    expect(exhausted.getState()).toMatchObject({
      active: false,
      status: 'NEEDS_USER_ACTION',
      retryCount: 3,
      pendingReconciliationSync: { runId: 'reconciliation-1' },
    });
    expect(options.git.syncGovernance).toHaveBeenCalledOnce();

    const restored = new MainOrchestrator(options);
    await restored.initialize();
    const retried = await restored.retryCurrentStage();

    expect(retried).toMatchObject({ status: 'COMPLETED', phase: 'WAITING_FOR_SOL', taskId: null });
    expect(apply).toHaveBeenCalledOnce();
    expect(options.git.syncGovernance).toHaveBeenCalledTimes(2);
    expect(options.git.syncGovernance).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        changeId: 'reconciliation-reconciliation-1',
        changedPaths: ['docs/governance/policy.md'],
        baseline: expect.objectContaining({ repositoryRoot }),
      }),
    );
    expect(options.edge.observe).not.toHaveBeenCalled();
    expect(options.governance?.applyAll).not.toHaveBeenCalled();
    expect(options.git.syncCode).not.toHaveBeenCalled();
    expect(options.codex.startTask).not.toHaveBeenCalled();
    expect(restored.getState()).toMatchObject({
      active: true,
      status: 'RUNNING',
      phase: 'WAITING_FOR_SOL',
      recentError: null,
      commits: { local: 'reconciliation-commit', remote: 'reconciliation-commit' },
    });
    expect(restored.getState().pendingReconciliationSync).toBeNull();
    expect((restored as unknown as { pendingReconciliationInput: unknown }).pendingReconciliationInput).toBeNull();
    await rm(repositoryRoot, { recursive: true, force: true });
  });

  it('pauses safely when persisted reconciliation retry context is incomplete', async () => {
    const initial = new MainOrchestrator(baseOptions()).getState();
    const stored = {
      ...initial,
      active: false,
      status: 'PAUSED',
      phase: 'PAUSED',
      recentError: { code: 'GOVERNANCE_RECONCILIATION_COMMIT_FAILED', message: 'sync failed' },
      pendingReconciliationSync: { runId: 'reconciliation-1', changedPaths: [] },
    } as never;
    const syncGovernance = vi.fn(async () => ({
      kind: 'governance' as const,
      commit: 'should-not-run',
      pushed: true,
      remoteCommit: 'should-not-run',
      pushRetried: false,
    }));
    const options = baseOptions({
      git: { ...baseOptions().git, syncGovernance },
      stateStore: {
        load: vi.fn(async () => stored),
        save: vi.fn(async () => undefined),
      },
    });
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.initialize();

    const retry = await orchestrator.retryCurrentStage();

    expect(retry).toMatchObject({
      status: 'PAUSED',
      message: '治理一致性重试上下文不完整，请从治理一致性入口重新执行。',
    });
    expect(orchestrator.getState()).toMatchObject({
      status: 'NEEDS_USER_ACTION',
      recentError: { code: 'GOVERNANCE_RECONCILIATION_RETRY_CONTEXT_INVALID' },
      pendingReconciliationSync: null,
    });
    expect(syncGovernance).not.toHaveBeenCalled();
  });

  it('rejects a tampered pending reconciliation baseline before Git sync', async () => {
    const initial = new MainOrchestrator(baseOptions()).getState();
    const stored = {
      ...initial,
      recentError: { code: 'GOVERNANCE_RECONCILIATION_COMMIT_FAILED', message: 'sync failed' },
      pendingReconciliationSync: {
        baseline: { ...baseline, head: 'tampered-head' },
        runId: 'reconciliation-1',
        changedPaths: ['docs/governance/policy.md'],
        backupPaths: [],
        outputKey: 'reconciliation-output',
      },
    } as never;
    const captureBaseline = vi.fn(async () => baseline);
    const syncGovernance = vi.fn(async () => ({
      kind: 'governance' as const,
      commit: 'should-not-run',
      pushed: true,
      remoteCommit: 'should-not-run',
      pushRetried: false,
    }));
    const options = baseOptions({
      git: { ...baseOptions().git, captureBaseline, syncGovernance },
      stateStore: {
        load: vi.fn(async () => stored),
        save: vi.fn(async () => undefined),
      },
    });
    const orchestrator = new MainOrchestrator(options);
    await orchestrator.start();

    const retry = await orchestrator.retryCurrentStage();

    expect(retry).toMatchObject({ status: 'PAUSED', message: expect.stringContaining('基线') });
    expect(orchestrator.getState()).toMatchObject({
      status: 'PAUSED',
      recentError: { code: 'BASELINE_CHANGED' },
      pendingReconciliationSync: null,
    });
    expect(captureBaseline).toHaveBeenCalledOnce();
    expect(syncGovernance).not.toHaveBeenCalled();
  });

  it('serializes reconciliation and an ordinary round through one orchestration lock', async () => {
    const events: string[] = [];
    let releaseApply!: () => void;
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const apply = vi.fn(async () => {
      events.push('apply:start');
      await applyGate;
      events.push('apply:end');
      return { runId: 'reconciliation-serial', changedPaths: ['docs/governance/policy.md'], backupPaths: [] };
    });
    const options = baseOptions({
      reconciliation: { apply },
      edge: {
        observe: vi.fn(async () => {
          events.push('edge');
          return observation(taskText());
        }),
      },
    });
    vi.mocked(options.git.syncGovernance).mockImplementation(async () => {
      events.push('sync');
      return {
        kind: 'governance',
        commit: 'serial-commit',
        pushed: true,
        remoteCommit: 'serial-commit',
        pushRetried: false,
      };
    });
    const orchestrator = new MainOrchestrator(options);
    const reconciliationRun = orchestrator.runGovernanceReconciliation({
      solOutput: `[WRITING_BLOCK type="GOVERNANCE_RECONCILIATION"]
{
  "schema_version": 1,
  "status": "CHANGES_REQUIRED",
  "baseline_commit": "base-commit",
  "files": [{
    "path": "docs/governance/policy.md",
    "action": "replace",
    "reason": "clarify policy",
    "sha256_before": "0000000000000000000000000000000000000000000000000000000000000000",
    "content": "Updated policy"
  }]
}
[/WRITING_BLOCK]`,
      baseline,
    });
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());

    const ordinaryRun = orchestrator.runRound();
    await Promise.resolve();
    expect(options.edge.observe).not.toHaveBeenCalled();

    releaseApply();
    await expect(reconciliationRun).resolves.toMatchObject({ status: 'COMPLETED' });
    await expect(ordinaryRun).resolves.toMatchObject({ status: 'IDLE' });
    expect(events.indexOf('apply:end')).toBeLessThan(events.indexOf('sync'));
    expect(events).not.toContain('edge');
  });

  it('counts governance reconciliation in dedicated parse diagnostics', async () => {
    const reconciliation = `[WRITING_BLOCK type="GOVERNANCE_RECONCILIATION"]
{
  "schema_version": 1,
  "status": "PASS"
}
    [/WRITING_BLOCK]`;
    const orchestrator = new MainOrchestrator(baseOptions());
    await orchestrator.start();

    await expect(
      orchestrator.runGovernanceReconciliation({ solOutput: reconciliation, baseline }),
    ).resolves.toMatchObject({
      status: 'PASS',
      reconciliationStatus: 'PASS',
    });

    expect(orchestrator.getDashboardSnapshot().loopGraph.nodes.find((node) => node.id === 'parse-task')).toMatchObject({
      state: 'COMPLETED',
      summary: '已验证 1 个 Writing Block。',
      details: ['治理一致性：1'],
    });
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
