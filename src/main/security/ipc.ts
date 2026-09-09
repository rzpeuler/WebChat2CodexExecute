import type { IpcMain } from 'electron';
import type { RuntimeInfo } from '../../shared/contracts/renderer-api.js';

export const RUNTIME_INFO_CHANNEL = 'app:get-runtime-info';

export function registerIpcHandlers(ipcMain: IpcMain, version: string): void {
  ipcMain.handle(RUNTIME_INFO_CHANNEL, (): RuntimeInfo => ({
    appName: 'Web Chat 2 Codex',
    version,
  }));
}
