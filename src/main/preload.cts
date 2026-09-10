import { contextBridge, ipcRenderer } from 'electron';
import type { RendererApi } from '../shared/contracts/renderer-api.js';

// Sandboxed Electron preloads can load Electron built-ins, but cannot require
// local application modules. Keep this allowlisted channel table local to the
// bridge so the renderer never receives arbitrary IPC access.
const RUNTIME_INFO_CHANNEL = 'app:get-runtime-info';
const PROJECT_DIRECTORY_SELECT_CHANNEL = 'project:directory-select';
const PROJECT_REMOTE_ACCESS_CHECK_CHANNEL = 'project:remote-access-check';
const PROJECT_INITIALIZE_CHANNEL = 'project:initialize';
const PROJECT_SCAN_CHANNEL = 'project:scan';
const PROJECT_CONFIG_SAVE_CHANNEL = 'project-config:save';
const PROJECT_CONFIG_LIST_CHANNEL = 'project-config:list';
const SOL_PROMPT_PREVIEW_CHANNEL = 'sol:prompt-preview';
const DASHBOARD_SNAPSHOT_CHANNEL = 'dashboard:get-snapshot';
const DASHBOARD_COMMAND_CHANNEL = 'dashboard:command';

const rendererApi: RendererApi = {
  getRuntimeInfo: () => ipcRenderer.invoke(RUNTIME_INFO_CHANNEL),
  selectProjectDirectory: () => ipcRenderer.invoke(PROJECT_DIRECTORY_SELECT_CHANNEL),
  checkProjectRemoteAccess: (input) => ipcRenderer.invoke(PROJECT_REMOTE_ACCESS_CHECK_CHANNEL, input),
  initializeProject: (input) => ipcRenderer.invoke(PROJECT_INITIALIZE_CHANNEL, input),
  scanProject: (localPath) => ipcRenderer.invoke(PROJECT_SCAN_CHANNEL, localPath),
  saveProjectConfig: (config) => ipcRenderer.invoke(PROJECT_CONFIG_SAVE_CHANNEL, config),
  loadProjectConfigs: () => ipcRenderer.invoke(PROJECT_CONFIG_LIST_CHANNEL),
  previewSolPrompt: (config) => ipcRenderer.invoke(SOL_PROMPT_PREVIEW_CHANNEL, config),
  getDashboardSnapshot: () => ipcRenderer.invoke(DASHBOARD_SNAPSHOT_CHANNEL),
  executeDashboardCommand: (command) => ipcRenderer.invoke(DASHBOARD_COMMAND_CHANNEL, command),
};

contextBridge.exposeInMainWorld('desktopApi', rendererApi);
