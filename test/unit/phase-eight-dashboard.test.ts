import { describe, expect, it } from 'vitest';
import {
  DashboardCommandValidationError,
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
    });
    expect(snapshot.project?.remoteUrl).not.toContain('password');
    expect(snapshot.recentError?.message).not.toContain('secret');
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
