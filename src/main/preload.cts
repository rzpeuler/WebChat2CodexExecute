import { contextBridge, ipcRenderer } from 'electron';
import type { RendererApi } from '../shared/contracts/renderer-api.js';
import {
  PROJECT_CONFIG_LIST_CHANNEL,
  PROJECT_CONFIG_SAVE_CHANNEL,
  PROJECT_SCAN_CHANNEL,
  RUNTIME_INFO_CHANNEL,
  SOL_PROMPT_PREVIEW_CHANNEL,
} from './security/ipc.js';

const rendererApi: RendererApi = {
  getRuntimeInfo: () => ipcRenderer.invoke(RUNTIME_INFO_CHANNEL),
  scanProject: (localPath) => ipcRenderer.invoke(PROJECT_SCAN_CHANNEL, localPath),
  saveProjectConfig: (config) => ipcRenderer.invoke(PROJECT_CONFIG_SAVE_CHANNEL, config),
  loadProjectConfigs: () => ipcRenderer.invoke(PROJECT_CONFIG_LIST_CHANNEL),
  previewSolPrompt: (config) => ipcRenderer.invoke(SOL_PROMPT_PREVIEW_CHANNEL, config),
};

contextBridge.exposeInMainWorld('desktopApi', rendererApi);
