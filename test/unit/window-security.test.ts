import { describe, expect, it } from 'vitest';
import { SECURE_WINDOW_WEB_PREFERENCES } from '../../src/main/security/window-security.js';

describe('renderer security boundary', () => {
  it('enables isolation and disables direct Node integration', () => {
    expect(SECURE_WINDOW_WEB_PREFERENCES).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
  });
});
