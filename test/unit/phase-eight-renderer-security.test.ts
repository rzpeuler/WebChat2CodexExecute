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
    expect(source).toContain("from '../shared/contracts/dashboard.js'");
    expect(source).not.toContain('RendererDashboardSnapshot');
    expect(source).not.toContain('if (action === undefined) return { enabled: true');
    expect(source).toContain('状态动作不可用，请刷新状态面板。');
  });

  it('prioritizes protocol and governance recent errors over unrelated action reasons', async () => {
    const source = await readFile(new URL('../../src/renderer/app.ts', import.meta.url), 'utf8');
    expect(source).toContain('请让 Sol 重新输出/规划任务，不要重复旧输出。');
    expect(source.indexOf('needsNewSolOutput')).toBe(-1);
    expect(source.indexOf('recentError !== null')).toBeLessThan(source.indexOf('actionReasonSuggestion(snapshot)'));
    expect(source).toContain('GOVERNANCE.*(?:CONFLICT|BLOCKED)');
  });

  it('keeps the Loop Graph fixed, accessible, and state-colored without a DOM dependency', async () => {
    const source = await readFile(new URL('../../src/renderer/app.ts', import.meta.url), 'utf8');
    const markup = await readFile(new URL('../../src/renderer/index.html', import.meta.url), 'utf8');
    const styles = await readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('LOOP_GRAPH_NODE_DEFINITIONS');
    expect(source).toContain("aria-controls', 'loop-graph-details'");
    expect(source).toContain('loopGraphNodeButtons');
    expect(source).not.toContain('loopGraphElement.replaceChildren');
    expect(markup).toContain('id="loop-graph-details"');
    expect(markup).toContain('role="list"');
    for (const state of [
      'pending',
      'active',
      'completed',
      'recoverable_blocked',
      'needs_user_action',
      'paused',
      'not_applicable',
    ]) {
      expect(styles).toContain(`.loop-node.state-${state}`);
      expect(styles).toContain(`.loop-graph-details-state.state-${state}`);
    }
  });

  it('keeps preload exposure limited to the typed renderer API', async () => {
    const source = await readFile(new URL('../../src/main/preload.cts', import.meta.url), 'utf8');
    expect(source).toContain('contextBridge.exposeInMainWorld');
    expect(source).toContain('getDashboardSnapshot');
    expect(source).toContain('executeDashboardCommand');
    expect(source).not.toContain('nodeIntegration');
  });
});
