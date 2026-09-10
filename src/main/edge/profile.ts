import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AtomicJsonFileStore, type StateSnapshotStore } from '../state/persistence.js';
import type {
  EdgeExecutableLocatorOptions,
  EdgeProcess,
  EdgeProcessRunner,
  EdgeProfileHandle,
  EdgeProfileOwnership,
  EdgeProfileOptions,
} from './types.js';
import { isAllowedCdpWebSocketUrl } from './url-security.js';

export type EdgeProfileErrorCode =
  | 'EDGE_EXECUTABLE_NOT_FOUND'
  | 'EDGE_PROFILE_INVALID'
  | 'EDGE_DEBUG_PORT_UNAVAILABLE'
  | 'EDGE_PROFILE_OWNERSHIP_INVALID'
  | 'EDGE_PROCESS_EXITED'
  | 'EDGE_LOGIN_REQUIRED';

export class EdgeProfileError extends Error {
  readonly code: EdgeProfileErrorCode;

  constructor(code: EdgeProfileErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EdgeProfileError';
    this.code = code;
  }
}

const defaultFileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

export async function locateEdgeExecutable(options: EdgeExecutableLocatorOptions = {}): Promise<string> {
  const executablePath = options.executablePath?.trim();
  const fileExists = options.fileExists ?? defaultFileExists;
  if (executablePath !== undefined && executablePath !== '') {
    if (!(await fileExists(executablePath))) {
      throw new EdgeProfileError(
        'EDGE_EXECUTABLE_NOT_FOUND',
        'The configured Microsoft Edge executable was not found.',
      );
    }
    return executablePath;
  }

  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new EdgeProfileError('EDGE_EXECUTABLE_NOT_FOUND', 'Microsoft Edge discovery is only supported on Windows.');
  }
  const env = options.env ?? process.env;
  const candidates = [
    env.PROGRAMFILES ? join(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
    env['PROGRAMFILES(X86)'] ? join(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
  ].filter((candidate): candidate is string => candidate !== null);
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  throw new EdgeProfileError(
    'EDGE_EXECUTABLE_NOT_FOUND',
    'Microsoft Edge could not be found in its default locations.',
  );
}

const defaultProcessRunner: EdgeProcessRunner = (file, args, options) =>
  spawn(file, [...args], options) as unknown as EdgeProcess;

async function defaultPortProbe(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function defaultWaitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await defaultPortProbe(port)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return false;
}

function parseOwnership(value: unknown): EdgeProfileOwnership {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid Edge profile ownership registration.');
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.token !== 'string' ||
    record.token.trim() === '' ||
    typeof record.executablePath !== 'string' ||
    typeof record.userDataDirectory !== 'string' ||
    typeof record.remoteDebuggingPort !== 'number' ||
    typeof record.registeredAt !== 'string'
  ) {
    throw new TypeError('Invalid Edge profile ownership registration.');
  }
  return record as unknown as EdgeProfileOwnership;
}

function createOwnershipStore(filePath: string): StateSnapshotStore<EdgeProfileOwnership> {
  return new AtomicJsonFileStore<EdgeProfileOwnership>(filePath, { validate: parseOwnership });
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function ownershipArgsMatch(args: readonly string[], ownership: EdgeProfileOwnership): boolean {
  const normalized = args.map((arg) => arg.replace(/^"|"$/g, ''));
  return (
    normalized.includes(`--remote-debugging-port=${ownership.remoteDebuggingPort}`) &&
    normalized.some(
      (arg) =>
        arg.startsWith('--user-data-dir=') &&
        samePath(arg.slice('--user-data-dir='.length), ownership.userDataDirectory),
    ) &&
    normalized.includes(`--web-chat2codex-edge-ownership=${ownership.token}`)
  );
}

interface BrowserCommandLineResponse {
  id?: number;
  result?: { arguments?: unknown };
}

async function defaultOwnershipProbe(
  port: number,
  ownership: EdgeProfileOwnership,
  fetchImpl: typeof fetch = fetch,
  webSocketFactory: (url: string) => WebSocket = (url) => new WebSocket(url),
): Promise<boolean> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`);
    if (!response.ok) return false;
    const value: unknown = await response.json();
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    if (typeof record.Browser !== 'string' || !/microsoft edge|\bedg(?:e)?\//i.test(record.Browser)) return false;
    if (
      typeof record.webSocketDebuggerUrl !== 'string' ||
      !isAllowedCdpWebSocketUrl(record.webSocketDebuggerUrl, port)
    ) {
      return false;
    }
    const socket = webSocketFactory(record.webSocketDebuggerUrl);
    const commandLine = await browserCommandLine(socket);
    return ownershipArgsMatch(commandLine, ownership);
  } catch {
    return false;
  }
}

function browserCommandLine(socket: WebSocket): Promise<readonly string[]> {
  return new Promise<readonly string[]>((resolveResult, reject) => {
    const onOpen = (): void => {
      socket.send(JSON.stringify({ id: 1, method: 'Browser.getBrowserCommandLine' }));
    };
    const onMessage = (event: MessageEvent): void => {
      try {
        const value = JSON.parse(String(event.data)) as BrowserCommandLineResponse;
        if (value.id !== 1) return;
        const args = value.result?.arguments;
        if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
          cleanup();
          reject(new Error('Edge did not return its command line.'));
          return;
        }
        cleanup();
        resolveResult(args);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (): void => {
      cleanup();
      reject(new Error('Edge ownership probe failed.'));
    };
    const cleanup = (): void => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      socket.close();
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    if (socket.readyState === 1) onOpen();
  });
}

export class EdgeProfileManager {
  private readonly options: EdgeProfileOptions;
  private readonly processRunner: EdgeProcessRunner;
  private process: EdgeProcess | null = null;
  private exited = false;
  private loginRequired = false;
  private readonly ownershipStore: StateSnapshotStore<EdgeProfileOwnership>;
  private ownership: EdgeProfileOwnership | null = null;

  constructor(options: EdgeProfileOptions) {
    if (
      !Number.isInteger(options.remoteDebuggingPort) ||
      options.remoteDebuggingPort < 1 ||
      options.remoteDebuggingPort > 65535
    ) {
      throw new EdgeProfileError('EDGE_PROFILE_INVALID', 'The remote debugging port must be a valid TCP port.');
    }
    if (options.userDataDirectory.trim() === '') {
      throw new EdgeProfileError('EDGE_PROFILE_INVALID', 'The dedicated Edge user-data directory is required.');
    }
    this.options = options;
    this.processRunner = options.processRunner ?? defaultProcessRunner;
    this.ownershipStore = createOwnershipStore(
      options.ownershipFilePath ?? join(options.userDataDirectory, '.web-chat2codex-edge-ownership.json'),
    );
  }

  async startOrReuse(): Promise<EdgeProfileHandle> {
    const executablePath = await locateEdgeExecutable({
      ...(this.options.executablePath === undefined ? {} : { executablePath: this.options.executablePath }),
      ...(this.options.fileExists === undefined ? {} : { fileExists: this.options.fileExists }),
      ...(this.options.platform === undefined ? {} : { platform: this.options.platform }),
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
    });
    await mkdir(this.options.userDataDirectory, { recursive: true });
    const probe = this.options.debugPortProbe ?? defaultPortProbe;
    if (await probe(this.options.remoteDebuggingPort)) {
      const ownership = await this.loadOrRejectOwnership(executablePath);
      const owned =
        this.options.ownershipProbe === undefined
          ? await defaultOwnershipProbe(
              this.options.remoteDebuggingPort,
              ownership,
              this.options.ownershipFetchImpl,
              this.options.ownershipWebSocketFactory,
            )
          : await this.options.ownershipProbe(this.options.remoteDebuggingPort, ownership);
      if (!owned) {
        throw new EdgeProfileError(
          'EDGE_PROFILE_OWNERSHIP_INVALID',
          'The existing Edge debugging port is not owned by this application profile.',
        );
      }
      this.ownership = ownership;
      return this.handle(executablePath, null, true);
    }

    const ownership = await this.loadOrCreateOwnership(executablePath);
    this.ownership = ownership;

    const args = [
      `--user-data-dir=${this.options.userDataDirectory}`,
      `--remote-debugging-port=${this.options.remoteDebuggingPort}`,
      `--web-chat2codex-edge-ownership=${ownership.token}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(this.options.initialUrl === undefined ? [] : [this.options.initialUrl]),
    ];
    try {
      this.process = this.processRunner(executablePath, args, {
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: 'ignore',
      });
    } catch (error) {
      throw new EdgeProfileError('EDGE_PROCESS_EXITED', 'The dedicated Edge process could not be started.', {
        cause: error,
      });
    }
    this.exited = false;
    this.process.once('exit', () => {
      this.exited = true;
      this.process = null;
      this.options.onProcessExit?.('exit');
    });
    this.process.once('error', () => {
      this.exited = true;
      this.options.onProcessExit?.('error');
    });
    const waitForPort = this.options.waitForDebugPort ?? defaultWaitForPort;
    if (!(await waitForPort(this.options.remoteDebuggingPort, 10_000))) {
      this.process.kill();
      this.process = null;
      throw new EdgeProfileError(
        'EDGE_DEBUG_PORT_UNAVAILABLE',
        'The dedicated Edge debugging port did not become available.',
      );
    }
    return this.handle(executablePath, this.process, false);
  }

  markLoginRequired(): void {
    this.loginRequired = true;
  }

  assertUsable(): void {
    if (this.exited || (this.process !== null && this.process.exitCode !== null)) {
      throw new EdgeProfileError('EDGE_PROCESS_EXITED', 'The dedicated Edge process has exited.');
    }
    if (this.loginRequired) {
      throw new EdgeProfileError('EDGE_LOGIN_REQUIRED', 'The dedicated Edge profile requires manual login.');
    }
  }

  close(): void {
    this.process?.kill();
    this.process = null;
  }

  private handle(executablePath: string, process: EdgeProcess | null, reused: boolean): EdgeProfileHandle {
    if (this.ownership === null) {
      throw new EdgeProfileError('EDGE_PROFILE_OWNERSHIP_INVALID', 'Edge profile ownership was not registered.');
    }
    return {
      executablePath,
      userDataDirectory: this.options.userDataDirectory,
      remoteDebuggingPort: this.options.remoteDebuggingPort,
      process,
      reused,
      loginRequired: this.loginRequired,
      ownershipToken: this.ownership.token,
    };
  }

  private async loadOrRejectOwnership(executablePath: string): Promise<EdgeProfileOwnership> {
    const ownership = await this.ownershipStore.load();
    if (ownership === null || !this.matchesOwnership(ownership, executablePath)) {
      throw new EdgeProfileError(
        'EDGE_PROFILE_OWNERSHIP_INVALID',
        'The existing Edge debugging port has no matching application ownership registration.',
      );
    }
    return ownership;
  }

  private async loadOrCreateOwnership(executablePath: string): Promise<EdgeProfileOwnership> {
    const existing = await this.ownershipStore.load();
    if (existing !== null) {
      if (!this.matchesOwnership(existing, executablePath)) {
        throw new EdgeProfileError(
          'EDGE_PROFILE_OWNERSHIP_INVALID',
          'The Edge profile ownership registration does not match.',
        );
      }
      return existing;
    }
    const ownership: EdgeProfileOwnership = {
      version: 1,
      token: randomUUID(),
      executablePath,
      userDataDirectory: this.options.userDataDirectory,
      remoteDebuggingPort: this.options.remoteDebuggingPort,
      registeredAt: (this.options.now ?? (() => new Date()))().toISOString(),
    };
    await this.ownershipStore.save(ownership);
    return ownership;
  }

  private matchesOwnership(ownership: EdgeProfileOwnership, executablePath: string): boolean {
    return (
      samePath(ownership.executablePath, executablePath) &&
      samePath(ownership.userDataDirectory, this.options.userDataDirectory) &&
      ownership.remoteDebuggingPort === this.options.remoteDebuggingPort
    );
  }
}

export function dedicatedEdgeProfileDirectory(appUserDataDirectory: string): string {
  return join(appUserDataDirectory, 'edge-profile');
}
