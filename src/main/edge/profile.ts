import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type {
  EdgeExecutableLocatorOptions,
  EdgeProcess,
  EdgeProcessRunner,
  EdgeProfileHandle,
  EdgeProfileOptions,
} from './types.js';

export type EdgeProfileErrorCode =
  | 'EDGE_EXECUTABLE_NOT_FOUND'
  | 'EDGE_PROFILE_INVALID'
  | 'EDGE_DEBUG_PORT_UNAVAILABLE'
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

export class EdgeProfileManager {
  private readonly options: EdgeProfileOptions;
  private readonly processRunner: EdgeProcessRunner;
  private process: EdgeProcess | null = null;
  private exited = false;
  private loginRequired = false;

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
      return this.handle(executablePath, null, true);
    }

    const args = [
      `--user-data-dir=${this.options.userDataDirectory}`,
      `--remote-debugging-port=${this.options.remoteDebuggingPort}`,
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
    return {
      executablePath,
      userDataDirectory: this.options.userDataDirectory,
      remoteDebuggingPort: this.options.remoteDebuggingPort,
      process,
      reused,
      loginRequired: this.loginRequired,
    };
  }
}

export function dedicatedEdgeProfileDirectory(appUserDataDirectory: string): string {
  return join(appUserDataDirectory, 'edge-profile');
}
