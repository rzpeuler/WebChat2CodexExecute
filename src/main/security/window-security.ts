import type { BrowserWindow, WebPreferences } from 'electron';

export const SECURE_WINDOW_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
} satisfies WebPreferences;

export function attachWindowSecurityHandlers(
  window: Pick<BrowserWindow, 'webContents'>,
  trustedRendererUrl: string,
): void {
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== trustedRendererUrl) {
      event.preventDefault();
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}
