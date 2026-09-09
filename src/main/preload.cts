import { contextBridge, ipcRenderer } from 'electron';
import type { RendererApi } from '../shared/contracts/renderer-api.js';
import { RUNTIME_INFO_CHANNEL } from './security/ipc.js';

const rendererApi: RendererApi = {
  getRuntimeInfo: () => ipcRenderer.invoke(RUNTIME_INFO_CHANNEL),
};

contextBridge.exposeInMainWorld('desktopApi', rendererApi);
