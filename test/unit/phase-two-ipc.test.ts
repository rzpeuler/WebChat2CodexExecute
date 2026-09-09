import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_CONFIG_SAVE_CHANNEL,
  PROJECT_SCAN_CHANNEL,
  RUNTIME_INFO_CHANNEL,
  registerIpcHandlers,
} from '../../src/main/security/ipc.js';
import type { ProjectConfigService } from '../../src/main/project/config.js';

type Handler = (...args: unknown[]) => unknown;

function invoke(handler: Handler | undefined, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve().then(() => {
    if (handler === undefined) throw new Error('Missing test handler');
    return handler(...args);
  });
}

function setup() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle(channel: string, handler: Handler) {
      handlers.set(channel, handler);
    },
  } as unknown as IpcMain;
  const frame = { url: 'file:///trusted/renderer/index.html' };
  const sender = { mainFrame: frame };
  const service = {
    scan: async (localPath: string) => ({ localPath }),
    save: async (config: unknown) => config,
    loadAll: async () => [],
    previewSolPrompt: async (config: unknown) => config,
  } as unknown as ProjectConfigService;
  const trustedWindow = { webContents: sender };
  registerIpcHandlers(ipcMain, '1.0.0', service, { getTrustedWindow: () => trustedWindow as never });
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  return { event, frame, handlers };
}

describe('IPC authorization and runtime argument boundary', () => {
  it('accepts only the trusted main frame and validates arguments', async () => {
    const { event, handlers } = setup();
    await expect(invoke(handlers.get(RUNTIME_INFO_CHANNEL), event)).resolves.toMatchObject({ version: '1.0.0' });
    await expect(invoke(handlers.get(PROJECT_SCAN_CHANNEL), event, 'C:\\repo')).resolves.toEqual({
      localPath: 'C:\\repo',
    });
    await expect(invoke(handlers.get(PROJECT_SCAN_CHANNEL), event, 42)).rejects.toMatchObject({
      code: 'IPC_INVALID_ARGUMENT',
    });
    await expect(invoke(handlers.get(PROJECT_CONFIG_SAVE_CHANNEL), event, null)).rejects.toMatchObject({
      code: 'IPC_INVALID_ARGUMENT',
    });
    await expect(
      invoke(handlers.get(PROJECT_CONFIG_SAVE_CHANNEL), event, { localPath: 'C:\\repo', reportDirectory: 42 }),
    ).rejects.toMatchObject({ code: 'IPC_INVALID_ARGUMENT' });
  });

  it('rejects subframes, non-file renderers, and a different window', async () => {
    const { event, frame, handlers } = setup();
    const subframeEvent = { ...event, senderFrame: { url: frame.url } } as unknown as IpcMainInvokeEvent;
    await expect(invoke(handlers.get(RUNTIME_INFO_CHANNEL), subframeEvent)).rejects.toMatchObject({
      code: 'IPC_UNAUTHORIZED',
    });

    const nonFileEvent = {
      ...event,
      senderFrame: { url: 'https://evil.example/' },
    } as unknown as IpcMainInvokeEvent;
    await expect(invoke(handlers.get(RUNTIME_INFO_CHANNEL), nonFileEvent)).rejects.toMatchObject({
      code: 'IPC_UNAUTHORIZED',
    });

    const otherSender = { mainFrame: frame };
    const otherWindowEvent = { sender: otherSender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    await expect(invoke(handlers.get(RUNTIME_INFO_CHANNEL), otherWindowEvent)).rejects.toMatchObject({
      code: 'IPC_UNAUTHORIZED',
    });
  });
});
