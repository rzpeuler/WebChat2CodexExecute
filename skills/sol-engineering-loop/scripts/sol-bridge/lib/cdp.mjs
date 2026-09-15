import { BridgeError, isAllowedCdpWebSocketUrl } from './security.mjs';

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

export class CdpTransport {
  constructor({ port, requestTimeoutMs = 4000, socketTimeoutMs = 5000, fetchImpl = globalThis.fetch, webSocketFactory = (url) => new WebSocket(url) }) {
    this.port = Number(port);
    this.requestTimeoutMs = requestTimeoutMs;
    this.socketTimeoutMs = socketTimeoutMs;
    this.fetchImpl = fetchImpl;
    this.webSocketFactory = webSocketFactory;
  }

  async listTargets() {
    const { signal, clear } = timeoutSignal(this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${this.port}/json/list`, { signal });
      if (!response.ok) throw new BridgeError('CDP_HTTP_ERROR', `CDP returned HTTP ${response.status}.`);
      const value = await response.json();
      if (!Array.isArray(value)) throw new BridgeError('CDP_INVALID_RESPONSE', 'CDP target list was not an array.');
      return value.filter((target) => target && typeof target.id === 'string' && typeof target.url === 'string');
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (error.name === 'AbortError') throw new BridgeError('CDP_TIMEOUT', 'CDP target request timed out.');
      throw new BridgeError('CDP_UNAVAILABLE', `CDP target request failed: ${error.message}`);
    } finally {
      clear();
    }
  }

  async evaluate(targetId, expression) {
    const result = await this.sendCommand(targetId, 'Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    return result?.result?.value;
  }

  async sendCommand(targetId, method, params = {}) {
    const targets = await this.listTargets();
    const target = targets.find((item) => item.id === targetId);
    if (!target || !isAllowedCdpWebSocketUrl(target.webSocketDebuggerUrl, this.port)) {
      throw new BridgeError('CDP_TARGET_UNAVAILABLE', 'The selected CDP target is unavailable or unsafe.');
    }
    return this.sendToWebSocket(target.webSocketDebuggerUrl, method, params);
  }

  async sendToWebSocket(url, method, params = {}) {
    const socket = this.webSocketFactory(url);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch {}
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new BridgeError('CDP_SOCKET_TIMEOUT', 'CDP command timed out.')), this.socketTimeoutMs);
      socket.addEventListener('open', () => {
        try { socket.send(JSON.stringify({ id: 1, method, params })); }
        catch (error) { finish(new BridgeError('CDP_SOCKET_SEND_FAILED', error.message)); }
      });
      socket.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
          if (message.id !== 1) return;
          if (message.error) finish(new BridgeError('CDP_COMMAND_FAILED', message.error.message || 'CDP command failed.', message.error));
          else finish(null, message.result);
        } catch (error) { finish(new BridgeError('CDP_INVALID_RESPONSE', error.message)); }
      });
      socket.addEventListener('error', () => finish(new BridgeError('CDP_SOCKET_FAILED', 'CDP WebSocket failed.')));
      socket.addEventListener('close', () => finish(new BridgeError('CDP_DISCONNECTED', 'CDP WebSocket closed before confirmation.')));
    });
  }
}

export async function readBrowserCommandLine(fetchImpl, webSocketFactory, port, timeoutMs = 4000) {
  const { signal, clear } = timeoutSignal(timeoutMs);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal });
    if (!response.ok) throw new BridgeError('CDP_HTTP_ERROR', `CDP returned HTTP ${response.status}.`);
    const version = await response.json();
    if (!isAllowedCdpWebSocketUrl(version.webSocketDebuggerUrl, port)) throw new BridgeError('CDP_INVALID_RESPONSE', 'Unsafe browser WebSocket URL.');
    const socket = webSocketFactory(version.webSocketDebuggerUrl);
    return await new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); try { socket.close(); } catch {} if (error) reject(error); else resolve(value); };
      const timer = setTimeout(() => finish(new BridgeError('CDP_SOCKET_TIMEOUT', 'Browser command line query timed out.')), timeoutMs);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Browser.getBrowserCommandLine', params: {} })));
      socket.addEventListener('message', (event) => {
        try { const message = JSON.parse(String(event.data)); if (message.id === 1) finish(message.error ? new BridgeError('CDP_COMMAND_FAILED', message.error.message) : null, message.result?.arguments || []); }
        catch (error) { finish(error); }
      });
      socket.addEventListener('error', () => finish(new BridgeError('CDP_SOCKET_FAILED', 'CDP WebSocket failed.')));
      socket.addEventListener('close', () => finish(new BridgeError('CDP_DISCONNECTED', 'CDP WebSocket closed.')));
    });
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(error.name === 'AbortError' ? 'CDP_TIMEOUT' : 'CDP_UNAVAILABLE', error.message);
  } finally { clear(); }
}

