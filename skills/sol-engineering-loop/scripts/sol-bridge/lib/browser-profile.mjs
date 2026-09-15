import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, constants, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CdpTransport, readBrowserCommandLine } from './cdp.mjs';
import { loadJsonWithBackup, writeJsonAtomic } from './io.mjs';
import { BridgeError, isAllowedCdpWebSocketUrl } from './security.mjs';

const exists = (path) => new Promise((resolve) => access(path, constants.X_OK, (error) => resolve(!error)));

export function locateEdgeExecutable(explicit = undefined) {
  const candidates = [explicit,
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')].filter(Boolean);
  return Promise.all(candidates.map(async (path) => (await exists(path)) ? path : null)).then((found) => found.find(Boolean) || null);
}

export class EdgeProfileManager {
  constructor({ stateDir, userDataDirectory, port = 9229, executablePath, initialUrl = 'https://chatgpt.com/' } = {}) {
    this.stateDir = stateDir || join(homedir(), '.codex', 'sol-engineering-loop');
    this.userDataDirectory = userDataDirectory || join(this.stateDir, 'edge-profile');
    this.port = Number(port);
    this.executablePath = executablePath;
    this.initialUrl = initialUrl;
    this.ownershipPath = join(this.userDataDirectory, '.sol-bridge-ownership.json');
    this.process = null;
  }

  async ensure() {
    if (process.platform !== 'win32') throw new BridgeError('ENVIRONMENT_UNSUPPORTED', 'Sol Bridge V1.1 requires Windows and Microsoft Edge.');
    const executable = await locateEdgeExecutable(this.executablePath);
    if (!executable) throw new BridgeError('EDGE_EXECUTABLE_NOT_FOUND', 'Microsoft Edge executable was not found.');
    await fs.mkdir(this.userDataDirectory, { recursive: true });
    const ownership = (await loadJsonWithBackup(this.ownershipPath)).value;
    const endpoint = await this.probeEndpoint();
    if (endpoint) {
      if (!ownership || ownership.port !== this.port || ownership.user_data_directory !== this.userDataDirectory || ownership.executable_path !== executable) {
        throw new BridgeError('EDGE_PROFILE_OWNERSHIP_INVALID', 'A live CDP endpoint is not proven to belong to this Sol Bridge profile.');
      }
      const args = await readBrowserCommandLine(fetch, (url) => new WebSocket(url), this.port).catch(() => null);
      if (!args || !args.includes(`--remote-debugging-port=${this.port}`) || !args.includes(`--user-data-dir=${this.userDataDirectory}`) || !args.includes(`--web-chat2codex-sol-ownership=${ownership.token}`) || !args.includes('--enable-automation')) {
        throw new BridgeError('EDGE_PROFILE_OWNERSHIP_INVALID', 'Live Edge command line does not match the owned profile.');
      }
      return { browser_running: true, endpoint, executable_path: executable, reused: true };
    }
    const token = ownership?.token || randomUUID();
    await writeJsonAtomic(this.ownershipPath, { version: 1, token, port: this.port, user_data_directory: this.userDataDirectory, executable_path: executable });
    this.process = spawn(executable, [`--user-data-dir=${this.userDataDirectory}`, `--remote-debugging-port=${this.port}`, `--web-chat2codex-sol-ownership=${token}`, '--enable-automation', '--no-first-run', '--no-default-browser-check', '--new-window', this.initialUrl], { detached: false, windowsHide: true, stdio: 'ignore' });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const ready = await this.probeEndpoint();
      if (ready) return { browser_running: true, endpoint: ready, executable_path: executable, reused: false };
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new BridgeError('CDP_UNAVAILABLE', 'Edge did not expose localhost CDP within the bounded startup window.');
  }

  async probeEndpoint() {
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/json/version`);
      if (!response.ok) return null;
      const value = await response.json();
      return isAllowedCdpWebSocketUrl(value.webSocketDebuggerUrl, this.port) ? value : null;
    } catch { return null; }
  }

  async close() {
    if (this.process && !this.process.killed) this.process.kill();
    this.process = null;
  }
}
