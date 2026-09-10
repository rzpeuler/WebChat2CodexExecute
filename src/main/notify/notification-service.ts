import { sanitizeErrorMessage, sanitizeSafeText, stableErrorCode } from '../../shared/contracts/safe-text.js';

export const NOTIFICATION_LEVELS = ['RECOVERABLE', 'NEEDS_USER', 'FATAL'] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export interface NotificationOptions {
  title: string;
  body: string;
}

export interface NotificationLike {
  show(): void;
  once?: (event: 'failed', listener: (error: unknown) => void) => unknown;
}

export type NotificationFactory = (options: NotificationOptions) => NotificationLike;

export interface NotificationInput {
  project: string;
  taskId: string | null;
  phase: string;
  suggestion: string;
  error: unknown;
  level?: NotificationLevel;
}

export interface NotificationDeliveryError {
  code:
    | 'NOTIFICATION_FACTORY_FAILED'
    | 'NOTIFICATION_LISTENER_FAILED'
    | 'NOTIFICATION_SHOW_FAILED'
    | 'NOTIFICATION_FAILED_EVENT';
  message: string;
}

export interface NotificationResult {
  notified: boolean;
  dedupeKey: string;
  errorCode: string;
  level: NotificationLevel;
  summary: string;
  deliveryError?: NotificationDeliveryError;
}

export interface NotificationServiceOptions {
  logger?: (event: string, details: Record<string, unknown>) => void;
}

const MAX_NOTIFICATION_ATTEMPTS = 2;

export class NotificationService {
  private readonly deliveredKeys = new Set<string>();
  private readonly deliveryAttempts = new Map<string, number>();
  private readonly logger: ((event: string, details: Record<string, unknown>) => void) | undefined;

  constructor(
    private readonly factory: NotificationFactory,
    options: NotificationServiceOptions = {},
  ) {
    this.logger = options.logger;
  }

  notify(input: NotificationInput): NotificationResult {
    const errorCode = stableErrorCode(input.error);
    const level = input.level ?? classifyNotificationError(input.error, errorCode);
    const project = sanitizeSafeText(input.project, 96) || '未选择项目';
    const taskId = sanitizeSafeText(input.taskId, 128) || '无';
    const phase = sanitizeSafeText(input.phase, 96) || '未知阶段';
    const suggestion = sanitizeSafeText(input.suggestion, 160) || defaultSuggestion(level);
    const dedupeKey = `${errorCode}:${taskId}:${phase}`;
    const summary = formatNotificationSummary({ project, taskId, phase, suggestion });

    if (this.deliveredKeys.has(dedupeKey)) {
      return { notified: false, dedupeKey, errorCode, level, summary };
    }

    const attempts = (this.deliveryAttempts.get(dedupeKey) ?? 0) + 1;
    this.deliveryAttempts.set(dedupeKey, attempts);

    const title = `Web Chat 2 Codex · ${level}`;
    let notification: NotificationLike;
    try {
      notification = this.factory({ title, body: summary });
    } catch (error) {
      return this.deliveryFailure(
        { notified: false, dedupeKey, errorCode, level, summary },
        { code: 'NOTIFICATION_FACTORY_FAILED', message: sanitizeErrorMessage(error, '通知对象创建失败') },
      );
    }
    try {
      notification.once?.('failed', (error) => {
        this.safeLog('notification-delivery-failed', {
          code: 'NOTIFICATION_FAILED_EVENT',
          errorCode,
          dedupeKey,
          message: sanitizeErrorMessage(error, '系统通知投递失败'),
        });
      });
    } catch (error) {
      return this.deliveryFailure(
        { notified: false, dedupeKey, errorCode, level, summary },
        { code: 'NOTIFICATION_LISTENER_FAILED', message: sanitizeErrorMessage(error, '通知事件绑定失败') },
      );
    }
    try {
      notification.show();
    } catch (error) {
      return this.deliveryFailure(
        { notified: false, dedupeKey, errorCode, level, summary },
        { code: 'NOTIFICATION_SHOW_FAILED', message: sanitizeErrorMessage(error, '通知显示失败') },
      );
    }
    this.deliveryAttempts.delete(dedupeKey);
    this.deliveredKeys.add(dedupeKey);
    return { notified: true, dedupeKey, errorCode, level, summary };
  }

  clearDedupe(): void {
    this.deliveredKeys.clear();
    this.deliveryAttempts.clear();
  }

  private deliveryFailure(
    result: Omit<NotificationResult, 'deliveryError'>,
    deliveryError: NotificationDeliveryError,
  ): NotificationResult {
    if ((this.deliveryAttempts.get(result.dedupeKey) ?? 0) >= MAX_NOTIFICATION_ATTEMPTS) {
      this.deliveredKeys.add(result.dedupeKey);
      this.deliveryAttempts.delete(result.dedupeKey);
    }
    this.safeLog('notification-delivery-error', {
      code: deliveryError.code,
      errorCode: result.errorCode,
      dedupeKey: result.dedupeKey,
      message: deliveryError.message,
    });
    return { ...result, deliveryError };
  }

  private safeLog(event: string, details: Record<string, unknown>): void {
    try {
      this.logger?.(event, details);
    } catch {
      // Logging must not turn a notification delivery diagnostic into an app failure.
    }
  }
}

export function classifyNotificationError(error: unknown, errorCode = stableErrorCode(error)): NotificationLevel {
  if (
    /(?:AUTH|LOGIN|SESSION|BASELINE|UNAUTHORIZED|PROTECTED|CREDENTIAL|INVALID|MISSING|CONTEXT|REMOTE|BRANCH)/.test(
      errorCode,
    )
  ) {
    return 'NEEDS_USER';
  }
  if (/(?:PERSISTENCE|DATABASE|INTERNAL|CORRUPT|FATAL)/.test(errorCode)) {
    return 'FATAL';
  }
  return 'RECOVERABLE';
}

function formatNotificationSummary(input: {
  project: string;
  taskId: string;
  phase: string;
  suggestion: string;
}): string {
  return [`项目：${input.project}`, `任务：${input.taskId}`, `阶段：${input.phase}`, `建议：${input.suggestion}`].join(
    '\n',
  );
}

function defaultSuggestion(level: NotificationLevel): string {
  if (level === 'FATAL') return '保存现场并重启应用后检查状态。';
  if (level === 'NEEDS_USER') return '请在状态面板确认并处理后继续。';
  return '请稍后重试当前阶段。';
}
