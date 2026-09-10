import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('phase eight renderer security boundary', () => {
  it('uses only the controlled preload API and textContent for dashboard output', async () => {
    const source = await readFile(new URL('../../src/renderer/app.ts', import.meta.url), 'utf8');
    expect(source).toContain('window.desktopApi.getDashboardSnapshot');
    expect(source).toContain('window.desktopApi.executeDashboardCommand');
    expect(source).toContain('confirm: true');
    expect(source).toContain('textContent');
    expect(source).not.toMatch(/\b(innerHTML|outerHTML|insertAdjacentHTML|ipcRenderer|require\s*\()/);
  });

  it('keeps preload exposure limited to the typed renderer API', async () => {
    const source = await readFile(new URL('../../src/main/preload.cts', import.meta.url), 'utf8');
    expect(source).toContain('contextBridge.exposeInMainWorld');
    expect(source).toContain('getDashboardSnapshot');
    expect(source).toContain('executeDashboardCommand');
    expect(source).not.toContain('nodeIntegration');
  });
});
