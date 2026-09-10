import type { CdpTarget, CdpTransport } from './types.js';
import { isAllowedCdpWebSocketUrl } from './url-security.js';

export interface CdpTransportOptions {
  port: number;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocket;
}

interface CdpResponse {
  id: number;
  result?: { result?: { value?: unknown; description?: string } };
  error?: { message?: string };
}

export class CdpTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CdpTransportError';
  }
}

export class HttpCdpTransport implements CdpTransport {
  private readonly endpoint: string;
  private readonly port: number;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketFactory: (url: string) => WebSocket;

  constructor(options: CdpTransportOptions) {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
      throw new CdpTransportError('Invalid CDP port.');
    }
    this.port = options.port;
    this.endpoint = `http://127.0.0.1:${options.port}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
  }

  async listTargets(): Promise<CdpTarget[]> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.endpoint}/json/list`);
    } catch (error) {
      throw new CdpTransportError('Could not reach the Edge CDP endpoint.', { cause: error });
    }
    if (!response.ok) throw new CdpTransportError(`CDP target listing failed with HTTP ${response.status}.`);
    const value: unknown = await response.json();
    if (!Array.isArray(value)) throw new CdpTransportError('CDP target listing was not an array.');
    return value.filter((target): target is CdpTarget => isTarget(target));
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
    const targets = await this.listTargets();
    const target = targets.find((candidate) => candidate.id === targetId);
    if (
      target?.webSocketDebuggerUrl === undefined ||
      !isAllowedCdpWebSocketUrl(target.webSocketDebuggerUrl, this.port)
    ) {
      throw new CdpTransportError(`CDP target ${targetId} has no WebSocket debugger endpoint.`);
    }
    const socket = this.webSocketFactory(target.webSocketDebuggerUrl);
    const id = 1;
    try {
      await waitForSocketOpen(socket);
      socket.send(JSON.stringify({ id, method, params }));
      const response = await waitForCdpResponse(socket, id);
      if (response.error !== undefined) throw new CdpTransportError(response.error.message ?? 'CDP command failed.');
      return (response.result ?? {}) as T;
    } finally {
      socket.close();
    }
  }
}

function isTarget(value: unknown): value is CdpTarget {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.type === 'string' &&
    typeof record.title === 'string' &&
    typeof record.url === 'string'
  );
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      resolve();
    };
    const onError = (event: Event): void => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      reject(new CdpTransportError('CDP WebSocket could not be opened.', { cause: event }));
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
  });
}

function waitForCdpResponse(socket: WebSocket, id: number): Promise<CdpResponse> {
  return new Promise<CdpResponse>((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      try {
        const value: unknown = JSON.parse(String(event.data));
        if (typeof value !== 'object' || value === null || (value as Record<string, unknown>).id !== id) return;
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('error', onError);
        resolve(value as CdpResponse);
      } catch (error) {
        reject(new CdpTransportError('CDP returned invalid JSON.', { cause: error }));
      }
    };
    const onError = (event: Event): void => {
      socket.removeEventListener('message', onMessage);
      reject(new CdpTransportError('CDP WebSocket failed while waiting for a response.', { cause: event }));
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
  });
}
