import { describe, expect, it } from 'vitest';
import {
  DashboardCommandValidationError,
  LOOP_GRAPH_MAX_DETAILS,
  LOOP_GRAPH_MAX_SOURCE_NODES,
  LOOP_GRAPH_NODE_DEFINITIONS,
  sanitizeDashboardSnapshot,
  validateDashboardCommand,
} from '../../src/shared/contracts/dashboard.js';

describe('phase eight dashboard contract', () => {
  it('sanitizes the dashboard snapshot at the shared boundary', () => {
    const snapshot = sanitizeDashboardSnapshot({
      revision: 4,
      updatedAt: '2026-09-10T00:00:00.000Z',
      project: {
        projectId: 'project-1',
        name: 'Demo Token=secret',
        localPath: 'C:\\Projects\\demo',
        remoteUrl: 'https://user:password@example.test/repo?token=secret',
      },
      activeSolSession: { sessionId: 'sol-1', conversationId: 'conversation-1', status: 'THINKING' },
      stage: 'phase-8.2',
      status: 'RUNNING',
      taskId: 'task-1',
      governanceRevision: 3,
      architectureRevisions: [2, 'arch-main'],
      luna: { status: 'COMPLETED', sessionId: 'luna-1' },
      commits: { local: 'abcdef1234567', remote: '123456789abcd' },
      recentError: { code: 'NETWORK_ERROR', message: 'Authorization=Bearer secret full log' },
    });

    expect(snapshot).toMatchObject({
      project: {
        name: 'Demo [REDACTED]',
        remoteUrl: 'https://[REDACTED]@example.test/repo?token=[REDACTED]',
      },
      activeSolSession: { sessionId: 'sol-1', status: 'THINKING' },
      stage: 'phase-8.2',
      status: 'RUNNING',
      recentError: { code: 'NETWORK_ERROR', message: '[REDACTED] full log' },
      actions: expect.objectContaining({
        start: { enabled: false, busy: false, reason: null },
      }),
    });
    expect(snapshot.project?.remoteUrl).not.toContain('password');
    expect(snapshot.recentError?.message).not.toContain('secret');
  });

  it('backfills a safe action contract for snapshots produced by older clients', () => {
    const snapshot = sanitizeDashboardSnapshot({ status: 'IDLE' });

    expect(Object.keys(snapshot.actions)).toEqual([
      'start',
      'pause',
      'retry-current-stage',
      'rebind',
      'governance-consistency-check',
      'open-edge',
      'open-project',
      'view-report',
    ]);
    expect(snapshot.actions.start).toEqual({ enabled: false, busy: false, reason: null });
    expect(snapshot.loopGraph).toEqual({
      roundId: null,
      currentNodeId: null,
      nodes: LOOP_GRAPH_NODE_DEFINITIONS.map(({ id, label }) => ({
        id,
        label,
        state: 'PENDING',
        summary: '',
        details: [],
        startedAt: null,
        completedAt: null,
        updatedAt: '1970-01-01T00:00:00.000Z',
      })),
    });
  });

  it('keeps the fixed node contract and sanitizes graph input', () => {
    const snapshot = sanitizeDashboardSnapshot({
      loopGraph: {
        roundId: 'round-1',
        currentNodeId: 'run-luna',
        nodes: [
          {
            id: 'run-luna',
            label: '<ignored>',
            state: 'ACTIVE',
            summary: 'Token=secret ' + 'x'.repeat(300),
            details: ['Authorization=Bearer secret', 'ok', '<script>alert(1)</script>'],
            startedAt: '2026-09-10T01:02:03.000Z',
            completedAt: 'not-a-time',
            updatedAt: '2026-09-10T01:02:04.000Z',
          },
          { id: 'unknown', state: 'COMPLETED' },
          { id: 'run-luna', state: 'COMPLETED', summary: 'duplicate must be ignored' },
        ],
      },
    });

    expect(snapshot.loopGraph.nodes.map((node) => node.id)).toEqual(LOOP_GRAPH_NODE_DEFINITIONS.map(({ id }) => id));
    const lunaNode = snapshot.loopGraph.nodes[4];
    expect(lunaNode).toBeDefined();
    expect(lunaNode).toMatchObject({
      id: 'run-luna',
      label: 'Luna 执行',
      state: 'ACTIVE',
      startedAt: '2026-09-10T01:02:03.000Z',
      completedAt: null,
      updatedAt: '2026-09-10T01:02:04.000Z',
    });
    expect(lunaNode?.summary).toHaveLength(240);
    expect(lunaNode?.summary).not.toContain('secret');
    expect(lunaNode?.details).toEqual(['[REDACTED]', 'ok', '<script>alert(1)</script>']);
  });

  it('degrades an invalid current node and node state to safe idle values', () => {
    const snapshot = sanitizeDashboardSnapshot({
      loopGraph: {
        currentNodeId: 'read-sol',
        nodes: [{ id: 'read-sol', state: 'PENDING', updatedAt: '2026-02-30T01:02:03.000Z' }],
      },
    });

    expect(snapshot.loopGraph.currentNodeId).toBeNull();
    expect(snapshot.loopGraph.nodes[0]).toMatchObject({ state: 'PENDING', updatedAt: '1970-01-01T00:00:00.000Z' });
  });

  it('keeps currentNodeId only for an existing active node and rejects normalized dates', () => {
    const snapshot = sanitizeDashboardSnapshot({
      loopGraph: {
        currentNodeId: 'run-luna',
        nodes: [
          { id: 'run-luna', state: 'ACTIVE', updatedAt: '2026-02-30T01:02:03.000Z' },
          { id: 'sync-code', state: 'COMPLETED', updatedAt: '2026-02-28T01:02:03.000Z' },
        ],
      },
    });

    expect(snapshot.loopGraph.currentNodeId).toBe('run-luna');
    expect(snapshot.loopGraph.nodes[4]?.updatedAt).toBe('1970-01-01T00:00:00.000Z');

    const pendingCurrent = sanitizeDashboardSnapshot({
      loopGraph: {
        currentNodeId: 'sync-code',
        nodes: [{ id: 'sync-code', state: 'PENDING', updatedAt: '2026-02-28T01:02:03.000Z' }],
      },
    });
    expect(pendingCurrent.loopGraph.currentNodeId).toBeNull();
  });

  it('preserves a source current node when it is paused or blocked', () => {
    for (const state of ['PAUSED', 'RECOVERABLE_BLOCKED', 'NEEDS_USER_ACTION'] as const) {
      const snapshot = sanitizeDashboardSnapshot({
        loopGraph: {
          currentNodeId: 'read-sol',
          nodes: [{ id: 'read-sol', state }],
        },
      });

      expect(snapshot.loopGraph.currentNodeId).toBe('read-sol');
      expect(snapshot.loopGraph.nodes[0]?.state).toBe(state);
    }
  });

  it('normalizes another active node when current points to a paused or blocked node', () => {
    for (const state of ['PAUSED', 'RECOVERABLE_BLOCKED', 'NEEDS_USER_ACTION'] as const) {
      const snapshot = sanitizeDashboardSnapshot({
        loopGraph: {
          currentNodeId: 'read-sol',
          nodes: [
            { id: 'read-sol', state },
            { id: 'parse-task', state: 'ACTIVE' },
          ],
        },
      });

      expect(snapshot.loopGraph.currentNodeId).toBe('read-sol');
      expect(snapshot.loopGraph.nodes.find((node) => node.id === 'read-sol')?.state).toBe(state);
      expect(snapshot.loopGraph.nodes.find((node) => node.id === 'parse-task')?.state).toBe('PENDING');
      expect(snapshot.loopGraph.nodes.filter((node) => node.state === 'ACTIVE')).toHaveLength(0);
    }
  });

  it('collapses multiple active nodes to one deterministic active node', () => {
    const snapshot = sanitizeDashboardSnapshot({
      loopGraph: {
        roundId: 'round-1',
        currentNodeId: 'sync-code',
        nodes: [
          { id: 'read-sol', state: 'ACTIVE' },
          { id: 'sync-code', state: 'ACTIVE' },
          { id: 'wait-sol', state: 'ACTIVE' },
        ],
      },
    });

    expect(snapshot.loopGraph.currentNodeId).toBe('read-sol');
    expect(snapshot.loopGraph.nodes.filter((node) => node.state === 'ACTIVE')).toHaveLength(1);
    expect(snapshot.loopGraph.nodes.find((node) => node.id === 'sync-code')?.state).toBe('PENDING');
    expect(snapshot.loopGraph.nodes.find((node) => node.id === 'wait-sol')?.state).toBe('PENDING');
  });

  it('stops inspecting oversized node and detail arrays at hard limits', () => {
    const oversizedNodes = Array.from({ length: LOOP_GRAPH_MAX_SOURCE_NODES + 1 }, () => ({ id: 'unknown' }));
    Object.defineProperty(oversizedNodes, LOOP_GRAPH_MAX_SOURCE_NODES, {
      get: () => {
        throw new Error('node limit was exceeded');
      },
    });
    const oversizedDetails = Array.from({ length: LOOP_GRAPH_MAX_DETAILS + 1 }, () => 'detail');
    Object.defineProperty(oversizedDetails, LOOP_GRAPH_MAX_DETAILS, {
      get: () => {
        throw new Error('detail limit was exceeded');
      },
    });

    const oversizedNodeSnapshot = sanitizeDashboardSnapshot({ loopGraph: { nodes: oversizedNodes } });
    expect(oversizedNodeSnapshot.loopGraph.nodes).toHaveLength(LOOP_GRAPH_NODE_DEFINITIONS.length);
    expect(oversizedNodeSnapshot.loopGraph.nodes[4]?.state).toBe('PENDING');

    const oversizedDetailSnapshot = sanitizeDashboardSnapshot({
      loopGraph: {
        nodes: [{ id: 'run-luna', state: 'ACTIVE', details: oversizedDetails }],
      },
    });
    expect(oversizedDetailSnapshot.loopGraph.nodes[4]?.details).toHaveLength(LOOP_GRAPH_MAX_DETAILS);
  });

  it('sanitizes action flags and reasons without trusting malformed input', () => {
    const snapshot = sanitizeDashboardSnapshot({
      actions: {
        start: { enabled: true, busy: 'yes' as never, reason: 'Token=secret' },
        pause: { enabled: 1 as never, busy: true, reason: 'x'.repeat(500) },
      },
    });

    expect(snapshot.actions.start).toEqual({ enabled: true, busy: false, reason: '[REDACTED]' });
    expect(snapshot.actions.pause.enabled).toBe(false);
    expect(snapshot.actions.pause.busy).toBe(true);
    expect(snapshot.actions.pause.reason).toHaveLength(240);
    expect(snapshot.actions.pause.reason).toMatch(/^x+…$/);
  });

  it('requires explicit confirmation for dangerous commands and validates report paths', () => {
    expect(() => validateDashboardCommand({ command: 'start' })).toThrow(DashboardCommandValidationError);
    expect(() => validateDashboardCommand({ command: 'pause', confirm: false })).toThrow(/confirm: true/);
    expect(validateDashboardCommand({ command: 'retry-current-stage', confirm: true })).toEqual({
      command: 'retry-current-stage',
      confirm: true,
    });
    expect(validateDashboardCommand({ command: 'view-report' })).toEqual({ command: 'view-report' });
    expect(validateDashboardCommand({ command: 'governance-consistency-check' })).toEqual({
      command: 'governance-consistency-check',
    });
    expect(validateDashboardCommand({ command: 'view-report', reportPath: 'docs/task-reports/task-1.md' })).toEqual({
      command: 'view-report',
      reportPath: 'docs/task-reports/task-1.md',
    });
    expect(() => validateDashboardCommand({ command: 'view-report', reportPath: '../secrets.txt' })).toThrow();
    expect(() => validateDashboardCommand({ command: 'open-project', projectId: 'other' })).toThrow();
  });
});
