import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateMissingUserData, stableUserDataDirectory } from '../../src/main/lifecycle/user-data.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('stable Electron user data', () => {
  it('uses a stable application-scoped directory', () => {
    expect(stableUserDataDirectory(join(tmpdir(), 'app-data'))).toBe(join(tmpdir(), 'app-data', 'web-chat2codex-exe'));
  });

  it('migrates missing durable data without overwriting stable data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-chat2codex-user-data-'));
    directories.push(root);
    const legacy = join(root, 'legacy');
    const stable = join(root, 'stable');
    await mkdir(join(legacy, 'edge-profile'), { recursive: true });
    await writeFile(join(legacy, 'projects.json'), 'legacy-projects', 'utf8');
    await writeFile(join(legacy, 'edge-profile', 'Cookies'), 'legacy-cookies', 'utf8');
    await mkdir(stable, { recursive: true });
    await writeFile(join(stable, 'projects.json'), 'stable-projects', 'utf8');

    await migrateMissingUserData(stable, [legacy]);

    await expect(readFile(join(stable, 'projects.json'), 'utf8')).resolves.toBe('stable-projects');
    await expect(readFile(join(stable, 'edge-profile', 'Cookies'), 'utf8')).resolves.toBe('legacy-cookies');
  });
});
