import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { describe, expect, it } from 'vitest';
import type { DashboardCommand } from '../../src/shared/contracts/dashboard.js';
import {
  DASHBOARD_COMMAND_CHANNEL,
  DASHBOARD_SNAPSHOT_CHANNEL,
  IpcSecurityError,
  registerIpcHandlers,
} from '../../src/main/security/ipc.js';

type Handler = (...args: unknown[]) => unknown;

describe('phase eight dashboard IPC contract', () => {
  it('exposes sanitized snapshots and only validated commands to the injected controller', async () => {
    const handlers = new Map<string, Handler>();
    const calls: DashboardCommand[] = [];
    const ipcMain = {
      handle(channel: string, handler: Handler) {
        handlers.set(channel, handler);
      },
    } as unknown as IpcMain;
    const frame = { url: 'file:///trusted/renderer/index.html' };
    const sender = { mainFrame: frame };
    const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    registerIpcHandlers(ipcMain, '1.0.0', undefined, {
      trustedRendererUrl: frame.url,
      getTrustedWindow: () => ({ webContents: sender }) as never,
      dashboard: {
        getSnapshot: () => ({
          project: { projectId: 'p1', name: 'Project Token=secret' },
          status: 'RUNNING',
          recentError: { code: 'NETWORK_ERROR', message: 'Cookie=secret' },
        }),
        executeCommand: (command) => {
          calls.push(command);
          return { accepted: true, code: 'OK', message: '命令完成 Token=secret' };
        },
      },
    });

    const snapshot = await handlers.get(DASHBOARD_SNAPSHOT_CHANNEL)?.(event);
    expect(snapshot).toMatchObject({
      project: { name: 'Project [REDACTED]' },
      recentError: { code: 'NETWORK_ERROR', message: '[REDACTED]' },
    });
    await expect(
      Promise.resolve().then(() => handlers.get(DASHBOARD_COMMAND_CHANNEL)?.(event, { command: 'start' })),
    ).rejects.toMatchObject({
      code: 'IPC_INVALID_ARGUMENT',
    });
    await expect(
      Promise.resolve().then(() =>
        handlers.get(DASHBOARD_COMMAND_CHANNEL)?.(event, { command: 'start', confirm: true }),
      ),
    ).resolves.toMatchObject({ accepted: true, code: 'OK', message: '命令完成 [REDACTED]' });
    expect(calls).toEqual([{ command: 'start', confirm: true }]);
  });

  it('rejects dashboard commands from an untrusted sender before validation', async () => {
    const handlers = new Map<string, Handler>();
    const ipcMain = {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    } as unknown as IpcMain;
    const frame = { url: 'file:///trusted/renderer/index.html' };
    registerIpcHandlers(ipcMain, '1.0.0', undefined, { trustedRendererUrl: frame.url });
    const event = {
      sender: { mainFrame: frame },
      senderFrame: { url: 'https://evil.example/' },
    } as unknown as IpcMainInvokeEvent;

    await expect(
      Promise.resolve().then(() => handlers.get(DASHBOARD_COMMAND_CHANNEL)?.(event, { command: 'open-edge' })),
    ).rejects.toBeInstanceOf(IpcSecurityError);
  });
});
