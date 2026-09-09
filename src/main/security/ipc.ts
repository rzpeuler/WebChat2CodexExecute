import type { IpcMain } from 'electron';
import type { RuntimeInfo, RendererApi } from '../../shared/contracts/renderer-api.js';
import type { ProjectConfigInput } from '../../shared/contracts/project-config.js';
import type { ProjectConfigService } from '../project/config.js';

export const RUNTIME_INFO_CHANNEL = 'app:get-runtime-info';
export const PROJECT_SCAN_CHANNEL = 'project:scan';
export const PROJECT_CONFIG_SAVE_CHANNEL = 'project-config:save';
export const PROJECT_CONFIG_LIST_CHANNEL = 'project-config:list';
export const SOL_PROMPT_PREVIEW_CHANNEL = 'sol:prompt-preview';

export function registerIpcHandlers(
  ipcMain: IpcMain,
  version: string,
  projectConfigService?: ProjectConfigService,
): void {
  ipcMain.handle(RUNTIME_INFO_CHANNEL, (): RuntimeInfo => ({
    appName: 'Web Chat 2 Codex',
    version,
  }));
  if (projectConfigService === undefined) {
    return;
  }
  ipcMain.handle(PROJECT_SCAN_CHANNEL, (_event, localPath: string) => projectConfigService.scan(localPath));
  ipcMain.handle(PROJECT_CONFIG_SAVE_CHANNEL, (_event, config: ProjectConfigInput) =>
    projectConfigService.save(config),
  );
  ipcMain.handle(PROJECT_CONFIG_LIST_CHANNEL, () => projectConfigService.loadAll());
  ipcMain.handle(SOL_PROMPT_PREVIEW_CHANNEL, (_event, config: ProjectConfigInput) =>
    projectConfigService.previewSolPrompt(config),
  );
}

export type ControlledProjectApi = Pick<
  RendererApi,
  'scanProject' | 'saveProjectConfig' | 'loadProjectConfigs' | 'previewSolPrompt'
>;
