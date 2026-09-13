import { access, cp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const MIGRATED_DATA_ENTRIES = [
  'projects.json',
  'projects.json.bak',
  'last-project.json',
  'state',
  'streams',
  'edge-profile',
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
}

/**
 * Keep development and installed builds on the same Electron data directory.
 * This path is deliberately based on appData, not the executable's location.
 */
export function stableUserDataDirectory(appDataDirectory: string): string {
  return join(resolve(appDataDirectory), 'web-chat2codex-exe');
}

/**
 * Migrate only missing durable data from an older Electron userData directory.
 * Existing stable data always wins and legacy files are never deleted.
 */
export async function migrateMissingUserData(
  stableDirectory: string,
  legacyDirectories: readonly string[],
): Promise<void> {
  await mkdir(stableDirectory, { recursive: true });
  const seen = new Set<string>([pathKey(stableDirectory)]);
  for (const legacyDirectory of legacyDirectories) {
    if (!legacyDirectory || seen.has(pathKey(legacyDirectory))) continue;
    seen.add(pathKey(legacyDirectory));
    if (!(await exists(legacyDirectory))) continue;
    for (const entry of MIGRATED_DATA_ENTRIES) {
      const source = join(legacyDirectory, entry);
      const destination = join(stableDirectory, entry);
      if (!(await exists(source)) || (await exists(destination))) continue;
      await cp(source, destination, { recursive: true, force: false, errorOnExist: false });
    }
  }
}
