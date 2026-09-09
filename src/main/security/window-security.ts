import type { WebPreferences } from 'electron';

export const SECURE_WINDOW_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
} satisfies WebPreferences;
