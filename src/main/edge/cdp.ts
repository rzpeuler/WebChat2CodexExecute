import type { CdpTarget, CdpTransport } from './types.js';
import { isAllowedCdpWebSocketUrl } from './url-security.js';

export interface CdpTransportOptions {
  port: number;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocket;
  requestTimeoutMs?: number;
  socketTimeoutMs?: number;
}

interface CdpResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

export type CdpTransportErrorCode =
  | 'NETWORK_CDP_UNREACHABLE'
  | 'NETWORK_CDP_HTTP_ERROR'
  | 'NETWORK_CDP_INVALID_RESPONSE'
  | 'NETWORK_CDP_TIMEOUT'
  | 'SESSION_CDP_TARGET_UNAVAILABLE'
  | 'SESSION_CDP_SOCKET_CREATE_FAILED'
  | 'SESSION_CDP_SOCKET_OPEN_FAILED'
  | 'SESSION_CDP_COMMAND_FAILED'
  | 'SESSION_CDP_INVALID_RESPONSE'
  | 'SESSION_CDP_DISCONNECTED'
  | 'SESSION_CDP_CLOSED';

export class CdpTransportError extends Error {
  readonly code: CdpTransportErrorCode;

  constructor(message: string, options: { code?: CdpTransportErrorCode; cause?: unknown } = {}) {
    super(message, options);
    this.name = 'CdpTransportError';
    this.code = options.code ?? 'NETWORK_CDP_UNREACHABLE';
  }
}

export class HttpCdpTransport implements CdpTransport {
  private readonly endpoint: string;
  private readonly port: number;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketFactory: (url: string) => WebSocket;
  private readonly requestTimeoutMs: number;
  private readonly socketTimeoutMs: number;
  private readonly abortControllers = new Set<AbortController>();
  private readonly sockets = new Set<WebSocket>();
  private closed = false;

  constructor(options: CdpTransportOptions) {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
      throw new CdpTransportError('Invalid CDP port.');
    }
    this.port = options.port;
    this.endpoint = `http://127.0.0.1:${options.port}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.requestTimeoutMs = finiteTimeout(options.requestTimeoutMs ?? 10_000);
    this.socketTimeoutMs = finiteTimeout(options.socketTimeoutMs ?? 10_000);
  }

  close(): void {
    this.closed = true;
    for (const controller of this.abortControllers) controller.abort();
    this.abortControllers.clear();
    for (const socket of this.sockets) {
      try {
        socket.close();
      } catch {
        // Cleanup is best effort; bounded waits still fail closed.
      }
    }
    this.sockets.clear();
  }

  async listTargets(): Promise<CdpTarget[]> {
    this.assertOpen();
    let response: Response;
    const controller = new AbortController();
    this.abortControllers.add(controller);
    try {
      response = await withTimeout(
        this.fetchImpl(`${this.endpoint}/json/list`, { signal: controller.signal }),
        this.requestTimeoutMs,
        () => controller.abort(),
        'CDP target listing timed out.',
      );
    } catch (error) {
      if (error instanceof CdpTransportError) throw error;
      if (this.closed) throw this.closedError();
      throw new CdpTransportError('Could not reach the Edge CDP endpoint.', {
        code: 'NETWORK_CDP_UNREACHABLE',
        cause: error,
      });
    } finally {
      this.abortControllers.delete(controller);
    }
    this.assertOpen();
    if (
      typeof response.ok !== 'boolean' ||
      typeof response.status !== 'number' ||
      typeof response.json !== 'function'
    ) {
      throw new CdpTransportError('CDP target listing returned an invalid HTTP response.', {
        code: 'NETWORK_CDP_INVALID_RESPONSE',
      });
    }
    if (!response.ok)
      throw new CdpTransportError(`CDP target listing failed with HTTP ${response.status}.`, {
        code: 'NETWORK_CDP_HTTP_ERROR',
      });
    let value: unknown;
    try {
      value = await withTimeout(
        response.json(),
        this.requestTimeoutMs,
        () => controller.abort(),
        'CDP target listing JSON parsing timed out.',
      );
    } catch (error) {
      if (error instanceof CdpTransportError) throw error;
      throw new CdpTransportError('CDP target listing returned invalid JSON.', {
        code: 'NETWORK_CDP_INVALID_RESPONSE',
        cause: error,
      });
    }
    if (!Array.isArray(value))
      throw new CdpTransportError('CDP target listing was not an array.', { code: 'NETWORK_CDP_INVALID_RESPONSE' });
    if (!value.every((target) => isTarget(target))) {
      throw new CdpTransportError('CDP target listing contains a malformed target.', {
        code: 'SESSION_CDP_INVALID_RESPONSE',
      });
    }
    return value as CdpTarget[];
  }

  async evaluate<T = unknown>(targetId: string, expression: string): Promise<T> {
    const result = await this.sendCommand<{ result?: { value?: unknown } }>(targetId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return (result.result?.value ?? null) as T;
  }

  async sendCommand<T = unknown>(targetId: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.assertOpen();
    const targets = await this.listTargets();
    this.assertOpen();
    const target = targets.find((candidate) => candidate.id === targetId);
    if (
      target?.webSocketDebuggerUrl === undefined ||
      !isAllowedCdpWebSocketUrl(target.webSocketDebuggerUrl, this.port)
    ) {
      throw new CdpTransportError(`CDP target ${targetId} has no WebSocket debugger endpoint.`, {
        code: 'SESSION_CDP_TARGET_UNAVAILABLE',
      });
    }
    let socket: WebSocket;
    try {
      socket = this.webSocketFactory(target.webSocketDebuggerUrl);
    } catch (error) {
      throw new CdpTransportError('CDP WebSocket could not be created.', {
        code: 'SESSION_CDP_SOCKET_CREATE_FAILED',
        cause: error,
      });
    }
    this.sockets.add(socket);
    const id = 1;
    try {
      await waitForSocketOpen(socket, this.socketTimeoutMs, () => this.closed);
      this.assertOpen();
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        throw new CdpTransportError('CDP WebSocket could not send the command.', {
          code: 'SESSION_CDP_DISCONNECTED',
          cause: error,
        });
      }
      const response = await waitForCdpResponse(socket, id, this.socketTimeoutMs, () => this.closed);
      if (response.error !== undefined)
        throw new CdpTransportError(response.error.message as string, {
          code: 'SESSION_CDP_COMMAND_FAILED',
        });
      return (response.result ?? {}) as T;
    } finally {
      this.sockets.delete(socket);
      try {
        socket.close();
      } catch {
        // Socket cleanup is best effort after a failed command.
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw this.closedError();
  }

  private closedError(): CdpTransportError {
    return new CdpTransportError('CDP transport is closed.', { code: 'SESSION_CDP_CLOSED' });
  }
}

function isTarget(value: unknown): value is CdpTarget {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.type === 'string' &&
    typeof record.title === 'string' &&
    typeof record.url === 'string' &&
    (!Object.prototype.hasOwnProperty.call(record, 'webSocketDebuggerUrl') ||
      typeof record.webSocketDebuggerUrl === 'string')
  );
}

function finiteTimeout(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 10_000;
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new CdpTransportError(message, { code: 'NETWORK_CDP_TIMEOUT' }));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function waitForSocketOpen(socket: WebSocket, timeoutMs: number, isClosed: () => boolean): Promise<void> {
  if (isClosed())
    return Promise.reject(new CdpTransportError('CDP transport is closed.', { code: 'SESSION_CDP_CLOSED' }));
  if (socket.readyState === 1) return Promise.resolve();
  if (socket.readyState === 3)
    return Promise.reject(
      new CdpTransportError('CDP WebSocket is already closed.', { code: 'SESSION_CDP_DISCONNECTED' }),
    );
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      cleanup();
      try {
        socket.close();
      } catch {
        // best effort
      }
      reject(new CdpTransportError('CDP WebSocket open timed out.', { code: 'NETWORK_CDP_TIMEOUT' }));
    }, timeoutMs);
    const closedTimer = setInterval(() => {
      if (!isClosed()) return;
      cleanup();
      reject(new CdpTransportError('CDP transport is closed.', { code: 'SESSION_CDP_CLOSED' }));
    }, 10);
    const cleanup = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      clearInterval(closedTimer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
    };
    const onOpen = (): void => {
      if (isClosed()) {
        cleanup();
        reject(new CdpTransportError('CDP transport is closed.', { code: 'SESSION_CDP_CLOSED' }));
        return;
      }
      cleanup();
      resolve();
    };
    const onError = (event: Event): void => {
      cleanup();
      reject(
        new CdpTransportError('CDP WebSocket could not be opened.', {
          code: 'SESSION_CDP_SOCKET_OPEN_FAILED',
          cause: event,
        }),
      );
    };
    const onClose = (): void => {
      cleanup();
      reject(new CdpTransportError('CDP WebSocket closed before it opened.', { code: 'SESSION_CDP_DISCONNECTED' }));
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  });
}

function waitForCdpResponse(
  socket: WebSocket,
  id: number,
  timeoutMs: number,
  isClosed: () => boolean,
): Promise<CdpResponse> {
  return new Promise<CdpResponse>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      cleanup();
      reject(new CdpTransportError('CDP response timed out.', { code: 'NETWORK_CDP_TIMEOUT' }));
    }, timeoutMs);
    const closedTimer = setInterval(() => {
      if (!isClosed()) return;
      cleanup();
      reject(new CdpTransportError('CDP transport is closed.', { code: 'SESSION_CDP_CLOSED' }));
    }, 10);
    const cleanup = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      clearInterval(closedTimer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
    };
    const onMessage = (event: MessageEvent): void => {
      try {
        const value: unknown = JSON.parse(String(event.data));
        if (!isRecord(value)) {
          cleanup();
          reject(
            new CdpTransportError('CDP returned a malformed command response.', {
              code: 'SESSION_CDP_INVALID_RESPONSE',
            }),
          );
          return;
        }
        if (!Object.prototype.hasOwnProperty.call(value, 'id')) return;
        if (value.id !== id) {
          cleanup();
          reject(
            new CdpTransportError('CDP returned a response for an unexpected command.', {
              code: 'SESSION_CDP_INVALID_RESPONSE',
            }),
          );
          return;
        }
        cleanup();
        resolve(assertCdpResponse(value, id));
      } catch (error) {
        cleanup();
        if (error instanceof CdpTransportError) {
          reject(error);
          return;
        }
        reject(
          new CdpTransportError('CDP returned invalid JSON.', {
            code: 'SESSION_CDP_INVALID_RESPONSE',
            cause: error,
          }),
        );
      }
    };
    const onError = (event: Event): void => {
      cleanup();
      reject(
        new CdpTransportError('CDP WebSocket failed while waiting for a response.', {
          code: 'SESSION_CDP_DISCONNECTED',
          cause: event,
        }),
      );
    };
    const onClose = (): void => {
      cleanup();
      if (isClosed()) {
        reject(new CdpTransportError('CDP transport is closed.', { code: 'SESSION_CDP_CLOSED' }));
        return;
      }
      reject(
        new CdpTransportError('CDP WebSocket disconnected before the response arrived.', {
          code: 'SESSION_CDP_DISCONNECTED',
        }),
      );
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  });
}

function assertCdpResponse(value: unknown, expectedId: number): CdpResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidResponse();
  const record = value as Record<string, unknown>;
  if (record.id !== expectedId) invalidResponse();
  const hasResult = Object.prototype.hasOwnProperty.call(record, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(record, 'error');
  if (
    hasResult === hasError ||
    (hasResult && !isRecord(record.result)) ||
    (hasResult && isRecord(record.result) && 'result' in record.result && !isRecord(record.result.result)) ||
    (hasError && !isCdpError(record.error))
  ) {
    invalidResponse();
  }
  return record as unknown as CdpResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCdpError(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.message === 'string' && value.message.trim() !== '';
}

function invalidResponse(): never {
  throw new CdpTransportError('CDP returned a malformed command response.', {
    code: 'SESSION_CDP_INVALID_RESPONSE',
  });
}
