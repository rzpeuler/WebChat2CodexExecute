import { describe, expect, it, vi } from 'vitest';
import {
  attachWindowSecurityHandlers,
  SECURE_WINDOW_WEB_PREFERENCES,
} from '../../src/main/security/window-security.js';

describe('renderer security boundary', () => {
  it('enables isolation and disables direct Node integration', () => {
    expect(SECURE_WINDOW_WEB_PREFERENCES).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
  });

  it('blocks navigation away from the trusted renderer and all new windows', () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const openHandlers: Array<(...args: unknown[]) => unknown> = [];
    const contents = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
      setWindowOpenHandler: (handler: (...args: unknown[]) => unknown) => openHandlers.push(handler),
    };
    attachWindowSecurityHandlers({ webContents: contents } as never, 'file:///app/renderer/index.html');

    const trustedEvent = { preventDefault: vi.fn() };
    handlers.get('will-navigate')?.(trustedEvent, 'file:///app/renderer/index.html');
    expect(trustedEvent.preventDefault).not.toHaveBeenCalled();

    const untrustedEvent = { preventDefault: vi.fn() };
    handlers.get('will-navigate')?.(untrustedEvent, 'https://evil.example/');
    expect(untrustedEvent.preventDefault).toHaveBeenCalledOnce();
    expect(openHandlers).toHaveLength(1);
    expect(openHandlers[0]?.({})).toEqual({ action: 'deny' });
  });
});
