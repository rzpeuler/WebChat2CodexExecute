import { realpath, stat } from 'node:fs/promises';
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
      await stat(current);
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
    realCandidate = await realpath(lexicalCandidate);
  } catch (error) {
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

export async function realProjectRoot(projectRoot: string): Promise<string> {
  const lexicalRoot = resolve(projectRoot);
  try {
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
