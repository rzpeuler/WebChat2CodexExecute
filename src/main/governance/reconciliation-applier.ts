import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type {
  GovernanceReconciliationBlock,
  GovernanceReconciliationFile,
} from '../../shared/protocol/writing-block.js';
import {
  assertSafeProjectPath,
  PathSafetyError,
  realProjectRoot,
  resolveProjectPath,
} from '../security/path-safety.js';
import { withSharedStateTransactionLock } from '../state/persistence.js';

const PROTECTED_PREFIXES = ['.git', '.web-chat2codex', 'node_modules', 'dist'];

export type GovernanceReconciliationErrorCode =
  | 'GOVERNANCE_RECONCILIATION_INVALID'
  | 'GOVERNANCE_RECONCILIATION_DUPLICATE_PATH'
  | 'GOVERNANCE_RECONCILIATION_PATH_OUTSIDE_PROJECT'
  | 'GOVERNANCE_RECONCILIATION_PATH_PROTECTED'
  | 'GOVERNANCE_RECONCILIATION_FILE_NOT_FOUND'
  | 'GOVERNANCE_RECONCILIATION_NOT_REGULAR_TEXT'
  | 'GOVERNANCE_RECONCILIATION_SHA_CONFLICT'
  | 'GOVERNANCE_RECONCILIATION_COMMIT_FAILED';

export class GovernanceReconciliationError extends Error {
  readonly code: GovernanceReconciliationErrorCode;
  readonly path: string | null;

  constructor(
    code: GovernanceReconciliationErrorCode,
    message: string,
    options: { path?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GovernanceReconciliationError';
    this.code = code;
    this.path = options.path ?? null;
  }
}

export interface GovernanceReconciliationApplyResult {
  runId: string;
  changedPaths: string[];
  backupPaths: string[];
}

export interface GovernanceReconciliationApplierOptions {
  runId?: () => string;
  beforeReplace?: (path: string, index: number) => void | Promise<void>;
}

interface PlannedReplacement {
  input: GovernanceReconciliationFile;
  relativePath: string;
  absolutePath: string;
  original: Buffer;
  replacement: Buffer;
  backupPath: string;
  backupRelativePath: string;
  stagePath: string;
  movedToBackup: boolean;
  installed: boolean;
}

function normalizeRelativePath(projectRoot: string, absolutePath: string): string {
  return relative(projectRoot, absolutePath).replaceAll('\\', '/');
}

function pathKey(path: string): string {
  return path.toLowerCase();
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function assertOrdinaryText(content: Buffer, path: string, label: 'existing file' | 'replacement content'): void {
  if (content.length === 0 || content.includes(0)) {
    throw new GovernanceReconciliationError(
      'GOVERNANCE_RECONCILIATION_NOT_REGULAR_TEXT',
      `${label} is empty or binary: ${path}`,
      { path },
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch (error) {
    throw new GovernanceReconciliationError(
      'GOVERNANCE_RECONCILIATION_NOT_REGULAR_TEXT',
      `${label} is not valid UTF-8 text: ${path}`,
      { path, cause: error },
    );
  }
  const controls = [...text].filter((character) => {
    const code = character.charCodeAt(0);
    return code < 32 && character !== '\t' && character !== '\n' && character !== '\r';
  }).length;
  if (controls > Math.max(1, Math.floor(text.length / 100))) {
    throw new GovernanceReconciliationError(
      'GOVERNANCE_RECONCILIATION_NOT_REGULAR_TEXT',
      `${label} contains binary control data: ${path}`,
      { path },
    );
  }
}

function validatedRunId(value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new GovernanceReconciliationError(
      'GOVERNANCE_RECONCILIATION_INVALID',
      'Reconciliation run id contains unsupported characters',
    );
  }
  return value;
}

async function safeTargetPath(projectRoot: string, candidate: string): Promise<string> {
  let absolutePath: string;
  try {
    absolutePath = resolveProjectPath(projectRoot, candidate);
  } catch (error) {
    throw new GovernanceReconciliationError(
      'GOVERNANCE_RECONCILIATION_PATH_OUTSIDE_PROJECT',
      `Reconciliation path is outside the project: ${candidate}`,
      { path: candidate, cause: error },
    );
  }
  const normalized = normalizeRelativePath(projectRoot, absolutePath);
  if (
    normalized === '' ||
    PROTECTED_PREFIXES.some(
      (prefix) => normalized.toLowerCase() === prefix || normalized.toLowerCase().startsWith(`${prefix}/`),
    )
  ) {
    throw new GovernanceReconciliationError(
      'GOVERNANCE_RECONCILIATION_PATH_PROTECTED',
      `Reconciliation path is protected: ${candidate}`,
      { path: candidate },
    );
  }
  try {
    return await assertSafeProjectPath(projectRoot, absolutePath);
  } catch (error) {
    if (error instanceof PathSafetyError && error.code === 'PATH_OUTSIDE_PROJECT') {
      throw new GovernanceReconciliationError(
        'GOVERNANCE_RECONCILIATION_PATH_OUTSIDE_PROJECT',
        `Reconciliation path resolves outside the project: ${candidate}`,
        { path: candidate, cause: error },
      );
    }
    throw new GovernanceReconciliationError(
      'GOVERNANCE_RECONCILIATION_INVALID',
      `Reconciliation path is not safe: ${candidate}`,
      { path: candidate, cause: error },
    );
  }
}

async function readRegularTextFile(path: string, relativePath: string): Promise<Buffer> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new GovernanceReconciliationError(
        'GOVERNANCE_RECONCILIATION_NOT_REGULAR_TEXT',
        `Reconciliation target is not a regular file: ${relativePath}`,
        { path: relativePath },
      );
    }
    const content = await readFile(path);
    assertOrdinaryText(content, relativePath, 'existing file');
    return content;
  } catch (error) {
    if (error instanceof GovernanceReconciliationError) throw error;
    if (isNodeError(error, 'ENOENT')) {
      throw new GovernanceReconciliationError(
        'GOVERNANCE_RECONCILIATION_FILE_NOT_FOUND',
        `Reconciliation target does not exist: ${relativePath}`,
        { path: relativePath, cause: error },
      );
    }
    throw new GovernanceReconciliationError(
      'GOVERNANCE_RECONCILIATION_INVALID',
      `Reconciliation target could not be read: ${relativePath}`,
      { path: relativePath, cause: error },
    );
  }
}

export class GovernanceReconciliationApplier {
  private readonly projectRoot: string;
  private readonly runIdFactory: () => string;
  private readonly beforeReplace: GovernanceReconciliationApplierOptions['beforeReplace'];

  constructor(projectRoot: string, options: GovernanceReconciliationApplierOptions = {}) {
    this.projectRoot = resolve(projectRoot);
    this.runIdFactory = options.runId ?? randomUUID;
    this.beforeReplace = options.beforeReplace;
  }

  async apply(block: GovernanceReconciliationBlock): Promise<GovernanceReconciliationApplyResult> {
    const files = block.fields.files;
    if (block.fields.status !== 'CHANGES_REQUIRED' || files === undefined || files.length === 0) {
      throw new GovernanceReconciliationError(
        'GOVERNANCE_RECONCILIATION_INVALID',
        'The reconciliation applier requires a CHANGES_REQUIRED block with files',
      );
    }
    await realProjectRoot(this.projectRoot);
    return withSharedStateTransactionLock(`${this.projectRoot}/.reconciliation.batch`, async () => {
      const runId = validatedRunId(this.runIdFactory());
      const backupRoot = resolve(this.projectRoot, '.web-chat2codex', 'backups', 'reconciliation', runId);
      const stageRoot = resolve(backupRoot, '.staging');
      const planned = await this.plan(files, backupRoot, stageRoot);
      return this.commit(runId, backupRoot, stageRoot, planned);
    });
  }

  private async plan(
    files: GovernanceReconciliationFile[],
    backupRoot: string,
    stageRoot: string,
  ): Promise<PlannedReplacement[]> {
    const seen = new Set<string>();
    const planned: PlannedReplacement[] = [];
    for (const [index, input] of files.entries()) {
      if (input.action !== 'replace' || input.content.trim() === '') {
        throw new GovernanceReconciliationError(
          'GOVERNANCE_RECONCILIATION_INVALID',
          `Reconciliation file ${input.path} must provide a complete replacement`,
          { path: input.path },
        );
      }
      const absolutePath = await safeTargetPath(this.projectRoot, input.path);
      const relativePath = normalizeRelativePath(this.projectRoot, absolutePath);
      const key = pathKey(relativePath);
      if (seen.has(key)) {
        throw new GovernanceReconciliationError(
          'GOVERNANCE_RECONCILIATION_DUPLICATE_PATH',
          `Reconciliation path appears more than once: ${relativePath}`,
          { path: relativePath },
        );
      }
      seen.add(key);
      const original = await readRegularTextFile(absolutePath, relativePath);
      if (sha256(original) !== input.sha256_before.toLowerCase()) {
        throw new GovernanceReconciliationError(
          'GOVERNANCE_RECONCILIATION_SHA_CONFLICT',
          `Reconciliation before SHA does not match: ${relativePath}`,
          { path: relativePath },
        );
      }
      const replacement = Buffer.from(input.content, 'utf8');
      assertOrdinaryText(replacement, relativePath, 'replacement content');
      const backupRelativePath = `.web-chat2codex/backups/reconciliation/${runIdFrom(backupRoot)}/${relativePath}`;
      planned.push({
        input,
        relativePath,
        absolutePath,
        original,
        replacement,
        backupPath: resolve(backupRoot, relativePath),
        backupRelativePath,
        stagePath: resolve(stageRoot, `file-${index}.stage`),
        movedToBackup: false,
        installed: false,
      });
    }
    return planned;
  }

  private async commit(
    runId: string,
    backupRoot: string,
    stageRoot: string,
    planned: PlannedReplacement[],
  ): Promise<GovernanceReconciliationApplyResult> {
    try {
      await assertSafeProjectPath(this.projectRoot, backupRoot);
      try {
        await lstat(backupRoot);
        throw new GovernanceReconciliationError(
          'GOVERNANCE_RECONCILIATION_INVALID',
          `Reconciliation run already exists: ${runId}`,
        );
      } catch (error) {
        if (error instanceof GovernanceReconciliationError) throw error;
        if (!isNodeError(error, 'ENOENT')) throw error;
      }
      await mkdir(stageRoot, { recursive: true });
      for (const item of planned) {
        await mkdir(dirname(item.backupPath), { recursive: true });
        await writeFile(item.stagePath, item.replacement, { flag: 'wx', mode: 0o600 });
      }

      for (const item of planned) {
        await safeTargetPath(this.projectRoot, item.relativePath);
        const current = await readRegularTextFile(item.absolutePath, item.relativePath);
        if (sha256(current) !== item.input.sha256_before.toLowerCase()) {
          throw new GovernanceReconciliationError(
            'GOVERNANCE_RECONCILIATION_SHA_CONFLICT',
            `Reconciliation target changed before replacement: ${item.relativePath}`,
            { path: item.relativePath },
          );
        }
      }

      for (const item of planned) {
        await rename(item.absolutePath, item.backupPath);
        item.movedToBackup = true;
      }
      for (const [index, item] of planned.entries()) {
        await this.beforeReplace?.(item.relativePath, index);
        await rename(item.stagePath, item.absolutePath);
        item.installed = true;
      }
      await rm(stageRoot, { recursive: true, force: true });
      return {
        runId,
        changedPaths: planned.map((item) => item.relativePath),
        backupPaths: planned.map((item) => item.backupRelativePath),
      };
    } catch (error) {
      for (const item of [...planned].reverse()) {
        try {
          if (item.installed) await rm(item.absolutePath, { force: true });
          if (item.movedToBackup) await rename(item.backupPath, item.absolutePath);
        } catch {
          // Keep the original commit error. Any remaining backup is recoverable under backupRoot.
        }
      }
      // Keep the backup directory after a failed batch. It is the recovery
      // evidence if a concurrent filesystem change prevents full rollback.
      await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof GovernanceReconciliationError) throw error;
      throw new GovernanceReconciliationError(
        'GOVERNANCE_RECONCILIATION_COMMIT_FAILED',
        'Governance reconciliation batch replacement failed',
        { cause: error },
      );
    }
  }
}

function runIdFrom(backupRoot: string): string {
  return backupRoot.replaceAll('\\', '/').split('/').at(-1)!;
}

export async function applyGovernanceReconciliation(
  projectRoot: string,
  block: GovernanceReconciliationBlock,
  options: GovernanceReconciliationApplierOptions = {},
): Promise<GovernanceReconciliationApplyResult> {
  return new GovernanceReconciliationApplier(projectRoot, options).apply(block);
}
