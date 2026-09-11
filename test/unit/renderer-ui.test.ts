import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

async function readRendererFile(fileName: string): Promise<string> {
  return readFile(join(repositoryRoot, 'src', 'renderer', fileName), 'utf8');
}

describe('renderer UI layout', () => {
  it('provides a shared read-only content dialog and configuration trigger', async () => {
    const html = await readRendererFile('index.html');
    expect(html).toContain('id="view-project-details"');
    expect(html).toContain('id="content-dialog"');
    expect(html).toContain('id="content-copy"');
    expect(html).toContain('id="content-dialog-body"');
  });

  it('wires both configuration and prompt content to the shared dialog', async () => {
    const app = await readRendererFile('app.ts');
    expect(app).toContain("openContentDialog('当前项目配置'");
    expect(app).toContain("openContentDialog('Sol 初始化提示词'");
    expect(app).toContain('navigator.clipboard?.writeText');
    expect(app).toContain('closeContentDialog');
  });

  it('loads the last project config and preserves saved target/report fields after Git refresh', async () => {
    const app = await readRendererFile('app.ts');
    expect(app).toContain('window.desktopApi.loadProjectConfigs()');
    expect(app).toContain('hydrateSavedProjectConfig');
    expect(app).toContain('projectRelativePath');
    expect(app).toContain('已加载上次项目配置，但 Git 状态刷新失败');
  });

  it('keeps the feedback bar fixed and widens the desktop shell', async () => {
    const css = await readRendererFile('styles.css');
    expect(css).toContain('width: min(1360px, 100%);');
    expect(css).toContain('position: fixed;');
    expect(css).toContain('padding-bottom: 82px;');
  });
});
