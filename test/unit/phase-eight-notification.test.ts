import { describe, expect, it } from 'vitest';
import { NotificationService } from '../../src/main/notify/index.js';

describe('phase eight notification service', () => {
  it('deduplicates by stable error code, task and phase', () => {
    const shown: Array<{ title: string; body: string }> = [];
    const service = new NotificationService((options) => ({ show: () => shown.push(options) }));

    const input = {
      project: 'ResearchHub',
      taskId: 'task-1',
      phase: 'phase-8.1',
      suggestion: '稍后重试',
      error: { code: 'PROCESS_OUTPUT_FAILED', message: 'first' },
    };
    expect(service.notify(input)).toMatchObject({
      notified: true,
      errorCode: 'PROCESS_OUTPUT_FAILED',
      level: 'RECOVERABLE',
    });
    expect(service.notify({ ...input, error: { code: 'PROCESS_OUTPUT_FAILED', message: 'changed' } })).toMatchObject({
      notified: false,
    });
    expect(service.notify({ ...input, phase: 'phase-8.2' })).toMatchObject({ notified: true });
    expect(shown).toHaveLength(2);
  });

  it('keeps notification bodies to sanitized project, task, phase and suggestion fields', () => {
    const shown: Array<{ title: string; body: string }> = [];
    const service = new NotificationService((options) => ({ show: () => shown.push(options) }));
    const result = service.notify({
      project: 'Project Cookie=project-secret',
      taskId: 'task-1 Token=task-secret',
      phase: 'phase-8\nlog: full output',
      suggestion: '检查 Token=secret；不要展示完整日志',
      error: { code: 'BASELINE_CHANGED', message: 'Cookie=secret full log' },
    });

    expect(result).toMatchObject({ errorCode: 'BASELINE_CHANGED', level: 'NEEDS_USER' });
    expect(shown[0]?.body).toContain('项目：Project [REDACTED]');
    expect(shown[0]?.body).toContain('任务：task-1 [REDACTED]');
    expect(shown[0]?.body).toContain('阶段：phase-8 log: full output');
    expect(shown[0]?.body).toContain('建议：检查 [REDACTED]；不要展示完整日志');
    expect(shown[0]?.body).not.toContain('full log');
    expect(shown[0]?.body).not.toContain('secret');
    expect(shown[0]?.body).not.toContain('BASELINE_CHANGED');
  });

  it('returns structured delivery failures without throwing', () => {
    const logs: Array<{ event: string; details: Record<string, unknown> }> = [];
    const service = new NotificationService(
      () => {
        throw new Error('Token=secret');
      },
      { logger: (event, details) => logs.push({ event, details }) },
    );
    const result = service.notify({
      project: 'Project',
      taskId: null,
      phase: 'phase-8.1',
      suggestion: '重试',
      error: { code: 'PERSISTENCE_UNAVAILABLE', message: 'storage failed' },
    });

    expect(result).toMatchObject({
      notified: false,
      level: 'FATAL',
      deliveryError: { code: 'NOTIFICATION_FACTORY_FAILED', message: '[REDACTED]' },
    });
    expect(logs[0]?.details.message).toBe('[REDACTED]');
  });

  it('normalizes notification show failures into a structured result', () => {
    const service = new NotificationService(() => ({
      show: () => {
        throw new Error('notification backend unavailable');
      },
    }));

    expect(
      service.notify({
        project: 'Project',
        taskId: 'task-1',
        phase: 'phase-8.1',
        suggestion: '重试',
        error: new Error('runner failed'),
      }),
    ).toMatchObject({
      notified: false,
      deliveryError: { code: 'NOTIFICATION_SHOW_FAILED', message: 'notification backend unavailable' },
    });
  });
});
