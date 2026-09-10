import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type { RuntimeInfo, RendererApi } from '../../shared/contracts/renderer-api.js';
import type { ProjectConfigInput } from '../../shared/contracts/project-config.js';
import type { ProjectConfigService } from '../project/config.js';

export const RUNTIME_INFO_CHANNEL = 'app:get-runtime-info';
export const PROJECT_SCAN_CHANNEL = 'project:scan';
export const PROJECT_CONFIG_SAVE_CHANNEL = 'project-config:save';
export const PROJECT_CONFIG_LIST_CHANNEL = 'project-config:list';
export const SOL_PROMPT_PREVIEW_CHANNEL = 'sol:prompt-preview';

export interface IpcHandlerOptions {
  trustedRendererUrl: string;
  getTrustedWindow?: () => BrowserWindow | null;
}

export class IpcSecurityError extends Error {
  readonly code: 'IPC_UNAUTHORIZED' | 'IPC_INVALID_ARGUMENT';

  constructor(code: 'IPC_UNAUTHORIZED' | 'IPC_INVALID_ARGUMENT', message: string) {
    super(message);
    this.name = 'IpcSecurityError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertTrustedSender(event: IpcMainInvokeEvent, options: IpcHandlerOptions): void {
  const senderFrame = event.senderFrame;
  if (senderFrame === null || senderFrame !== event.sender.mainFrame) {
    throw new IpcSecurityError('IPC_UNAUTHORIZED', 'IPC requests must come from the main frame');
  }
  const trustedWindow = options.getTrustedWindow?.();
  if (trustedWindow !== undefined && (trustedWindow === null || trustedWindow.webContents !== event.sender)) {
    throw new IpcSecurityError('IPC_UNAUTHORIZED', 'IPC sender is not the trusted main window');
  }
  if (senderFrame.url !== options.trustedRendererUrl) {
    throw new IpcSecurityError('IPC_UNAUTHORIZED', 'IPC sender is not the trusted renderer document');
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IpcSecurityError('IPC_INVALID_ARGUMENT', `${field} must be a non-empty string`);
  }
}

function assertProjectConfigInput(value: unknown): asserts value is ProjectConfigInput {
  if (!isRecord(value)) {
    throw new IpcSecurityError('IPC_INVALID_ARGUMENT', 'Project config must be an object');
  }
  assertNonEmptyString(value.localPath, 'localPath');
  assertNonEmptyString(value.reportDirectory, 'reportDirectory');
  for (const field of ['projectId', 'targetBranch', 'currentBranch', 'headCommit', 'governanceManifestPath']) {
    if (value[field] !== undefined) assertNonEmptyString(value[field], field);
  }
  if (value.remoteUrl !== undefined && value.remoteUrl !== null && typeof value.remoteUrl !== 'string') {
    throw new IpcSecurityError('IPC_INVALID_ARGUMENT', 'remoteUrl must be a string or null');
  }
}

export function registerIpcHandlers(
  ipcMain: IpcMain,
  version: string,
  projectConfigService: ProjectConfigService | undefined,
  options: IpcHandlerOptions,
): void {
  ipcMain.handle(RUNTIME_INFO_CHANNEL, (event): RuntimeInfo => {
    assertTrustedSender(event, options);
    return {
      appName: 'Web Chat 2 Codex',
      version,
    };
  });
  if (projectConfigService === undefined) {
    return;
  }
  ipcMain.handle(PROJECT_SCAN_CHANNEL, (event, localPath: unknown) => {
    assertTrustedSender(event, options);
    assertNonEmptyString(localPath, 'localPath');
    return projectConfigService.scan(localPath);
  });
  ipcMain.handle(PROJECT_CONFIG_SAVE_CHANNEL, (event, config: unknown) => {
    assertTrustedSender(event, options);
    assertProjectConfigInput(config);
    return projectConfigService.save(config);
  });
  ipcMain.handle(PROJECT_CONFIG_LIST_CHANNEL, (event) => {
    assertTrustedSender(event, options);
    return projectConfigService.loadAll();
  });
  ipcMain.handle(SOL_PROMPT_PREVIEW_CHANNEL, (event, config: unknown) => {
    assertTrustedSender(event, options);
    assertProjectConfigInput(config);
    return projectConfigService.previewSolPrompt(config);
  });
}

export type ControlledProjectApi = Pick<
  RendererApi,
  'scanProject' | 'saveProjectConfig' | 'loadProjectConfigs' | 'previewSolPrompt'
>;
