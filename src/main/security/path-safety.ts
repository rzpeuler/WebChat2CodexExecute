import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type PathSafetyErrorCode = 'PATH_OUTSIDE_PROJECT' | 'PROJECT_PATH_UNSAFE';

export class PathSafetyError extends Error {
  readonly code: PathSafetyErrorCode;

  constructor(code: PathSafetyErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PathSafetyError';
    this.code = code;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export function isPathWithinProject(projectRoot: string, candidatePath: string): boolean {
  const root = resolve(projectRoot);
  const candidate = resolve(candidatePath);
  const difference = relative(root, candidate);
  return difference === '' || (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference));
}

export function resolveProjectPath(projectRoot: string, candidatePath: string): string {
  const resolved = resolve(projectRoot, candidatePath);
  if (!isPathWithinProject(projectRoot, resolved)) {
    throw new PathSafetyError('PATH_OUTSIDE_PROJECT', `Path must remain inside project: ${candidatePath}`);
  }
  return resolved;
}

async function nearestExistingParent(candidatePath: string): Promise<string> {
  let current = dirname(candidatePath);
  while (true) {
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new PathSafetyError('PATH_OUTSIDE_PROJECT', `Path component is a symlink or junction: ${current}`);
      }
      return current;
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

async function assertNoSymlinkComponents(candidatePath: string): Promise<void> {
  let current = resolve(candidatePath);
  while (true) {
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new PathSafetyError('PATH_OUTSIDE_PROJECT', `Path component is a symlink or junction: ${current}`);
      }
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) {
        throw error;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

/**
 * Checks lexical containment and then resolves every existing path component.
 * For a path that will be created later, the nearest existing parent is the
 * trust anchor, so a missing suffix cannot hide a symlink/junction escape.
 */
export async function assertSafeProjectPath(projectRoot: string, candidatePath: string): Promise<string> {
  const lexicalRoot = resolve(projectRoot);
  const lexicalCandidate = resolveProjectPath(lexicalRoot, candidatePath);
  let realRoot: string;
  try {
    await assertNoSymlinkComponents(lexicalRoot);
    realRoot = await realpath(lexicalRoot);
    const rootStats = await stat(realRoot);
    if (!rootStats.isDirectory()) {
      throw new Error('project root is not a directory');
    }
  } catch (error) {
    throw new PathSafetyError('PROJECT_PATH_UNSAFE', `Project root is not a safe directory: ${lexicalRoot}`, {
      cause: error,
    });
  }

  let realCandidate: string;
  try {
    await assertNoSymlinkComponents(lexicalCandidate);
    realCandidate = await realpath(lexicalCandidate);
  } catch (error) {
    if (error instanceof PathSafetyError) {
      throw error;
    }
    if (!isNodeError(error, 'ENOENT')) {
      throw new PathSafetyError('PROJECT_PATH_UNSAFE', `Project path cannot be resolved safely: ${lexicalCandidate}`, {
        cause: error,
      });
    }
    const parent = await nearestExistingParent(lexicalCandidate);
    try {
      realCandidate = await realpath(parent);
    } catch (parentError) {
      throw new PathSafetyError('PROJECT_PATH_UNSAFE', `Project path parent cannot be resolved safely: ${parent}`, {
        cause: parentError,
      });
    }
  }

  if (!isPathWithinProject(realRoot, realCandidate)) {
    throw new PathSafetyError('PATH_OUTSIDE_PROJECT', `Path resolves outside project: ${candidatePath}`);
  }
  return lexicalCandidate;
}

/**
 * Performs the same preflight checks for a persisted file that is not rooted
 * in a project. Node exposes symlink/junction-style reparse points through
 * lstat().isSymbolicLink(), but does not provide portable reparse tags or
 * stable directory handles for a handle-scoped no-TOCTOU guarantee. Callers
 * must invoke this immediately before each filesystem operation; this is
 * defense in depth, not a claim that a concurrent native replacement race is
 * impossible with path-based fs/promises APIs.
 */
export async function assertSafeFilePath(filePath: string): Promise<string> {
  const candidatePath = resolve(filePath);
  try {
    await assertNoSymlinkComponents(candidatePath);
    const stats = await lstat(candidatePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new PathSafetyError('PROJECT_PATH_UNSAFE', `Persisted path is not a regular file: ${candidatePath}`);
    }
    await realpath(candidatePath);
    return candidatePath;
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) {
      if (error instanceof PathSafetyError) {
        throw new PathSafetyError('PROJECT_PATH_UNSAFE', `Persisted path is not safe: ${candidatePath}`, {
          cause: error,
        });
      }
      throw new PathSafetyError('PROJECT_PATH_UNSAFE', `Persisted path is not safe: ${candidatePath}`, {
        cause: error,
      });
    }
  }

  const parent = await nearestExistingParent(candidatePath);
  try {
    await assertNoSymlinkComponents(parent);
    await realpath(parent);
  } catch (error) {
    if (error instanceof PathSafetyError) {
      throw new PathSafetyError('PROJECT_PATH_UNSAFE', `Persisted path parent is not safe: ${parent}`, {
        cause: error,
      });
    }
    throw new PathSafetyError('PROJECT_PATH_UNSAFE', `Persisted path parent is not safe: ${parent}`, { cause: error });
  }
  return candidatePath;
}

export async function realProjectRoot(projectRoot: string): Promise<string> {
  const lexicalRoot = resolve(projectRoot);
  try {
    await assertNoSymlinkComponents(lexicalRoot);
    const canonicalRoot = await realpath(lexicalRoot);
    const rootStats = await stat(canonicalRoot);
    if (!rootStats.isDirectory()) {
      throw new Error('project root is not a directory');
    }
    return canonicalRoot;
  } catch (error) {
    throw new PathSafetyError('PROJECT_PATH_UNSAFE', `Project root is not a safe directory: ${lexicalRoot}`, {
      cause: error,
    });
  }
}
