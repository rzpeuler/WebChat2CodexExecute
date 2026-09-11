import { randomUUID } from 'node:crypto';
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
import {
  canonicalizeGovernanceText,
  GovernanceTextHashError,
  type CanonicalGovernanceText,
} from './canonical-text-hash.js';

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
  /** Test-only seam for exercising the validation-to-rename race. */
  beforeBackup?: (path: string, index: number) => void | Promise<void>;
}

interface PlannedReplacement {
  input: GovernanceReconciliationFile;
  relativePath: string;
  absolutePath: string;
  replacementText: CanonicalGovernanceText;
  backupPath: string;
  backupRelativePath: string;
  stagePath: string;
  movedToBackup: boolean;
  installed: boolean;
  installedBytes: Buffer | null;
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

type RollbackTargetState = 'missing' | 'regular' | 'other' | 'unknown';

async function rollbackTargetState(path: string): Promise<RollbackTargetState> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return 'other';
    try {
      await readFile(path);
      return 'regular';
    } catch {
      return 'unknown';
    }
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return 'missing';
    return 'unknown';
  }
}

function hasUtf8Bom(content: Uint8Array): boolean {
  return content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf;
}

function preferredLineEnding(text: string): '\n' | '\r\n' | '\r' {
  const endings = [...text.matchAll(/\r\n|\r|\n/g)].map(([ending]) => ending as '\n' | '\r\n' | '\r');
  if (endings.length === 0) return '\n';
  const counts = new Map<string, number>();
  for (const ending of endings) counts.set(ending, (counts.get(ending) ?? 0) + 1);
  return endings.reduce((preferred, ending) =>
    (counts.get(ending) ?? 0) > (counts.get(preferred) ?? 0) ? ending : preferred,
  );
}

function formatReplacement(original: CanonicalGovernanceText, replacement: CanonicalGovernanceText): Buffer {
  const lineEnding = preferredLineEnding(original.text);
  const text = replacement.canonicalText.replaceAll('\n', lineEnding);
  const bytes = Buffer.from(text, 'utf8');
  return hasUtf8Bom(original.rawBytes) ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes;
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

async function readRegularTextFile(path: string, relativePath: string): Promise<CanonicalGovernanceText> {
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
    return canonicalizeGovernanceText(content, relativePath);
  } catch (error) {
    if (error instanceof GovernanceReconciliationError) throw error;
    if (error instanceof GovernanceTextHashError) {
      throw new GovernanceReconciliationError(
        'GOVERNANCE_RECONCILIATION_NOT_REGULAR_TEXT',
        `Reconciliation target is not regular UTF-8 text: ${relativePath}`,
        { path: relativePath, cause: error },
      );
    }
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
  private readonly beforeBackup: GovernanceReconciliationApplierOptions['beforeBackup'];

  constructor(projectRoot: string, options: GovernanceReconciliationApplierOptions = {}) {
    this.projectRoot = resolve(projectRoot);
    this.runIdFactory = options.runId ?? randomUUID;
    this.beforeReplace = options.beforeReplace;
    this.beforeBackup = options.beforeBackup;
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
      if (original.sha256 !== input.sha256_before.toLowerCase()) {
        throw new GovernanceReconciliationError(
          'GOVERNANCE_RECONCILIATION_SHA_CONFLICT',
          `Reconciliation before SHA does not match: ${relativePath}`,
          { path: relativePath },
        );
      }
      let replacementText: CanonicalGovernanceText;
      try {
        replacementText = canonicalizeGovernanceText(Buffer.from(input.content, 'utf8'), relativePath);
      } catch (error) {
        if (error instanceof GovernanceTextHashError) {
          throw new GovernanceReconciliationError(
            'GOVERNANCE_RECONCILIATION_NOT_REGULAR_TEXT',
            `Replacement content is not regular UTF-8 text: ${relativePath}`,
            { path: relativePath, cause: error },
          );
        }
        throw error;
      }
      const backupRelativePath = `.web-chat2codex/backups/reconciliation/${runIdFrom(backupRoot)}/${relativePath}`;
      planned.push({
        input,
        relativePath,
        absolutePath,
        replacementText,
        backupPath: resolve(backupRoot, relativePath),
        backupRelativePath,
        stagePath: resolve(stageRoot, `file-${index}.stage`),
        movedToBackup: false,
        installed: false,
        installedBytes: null,
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
      }

      for (const item of planned) {
        await safeTargetPath(this.projectRoot, item.relativePath);
        const current = await readRegularTextFile(item.absolutePath, item.relativePath);
        if (current.sha256 !== item.input.sha256_before.toLowerCase()) {
          throw new GovernanceReconciliationError(
            'GOVERNANCE_RECONCILIATION_SHA_CONFLICT',
            `Reconciliation target changed before replacement: ${item.relativePath}`,
            { path: item.relativePath },
          );
        }
      }

      for (const [index, item] of planned.entries()) {
        await this.beforeReplace?.(item.relativePath, index);
        const current = await readRegularTextFile(item.absolutePath, item.relativePath);
        if (current.sha256 !== item.input.sha256_before.toLowerCase()) {
          throw new GovernanceReconciliationError(
            'GOVERNANCE_RECONCILIATION_SHA_CONFLICT',
            `Reconciliation target changed before replacement: ${item.relativePath}`,
            { path: item.relativePath },
          );
        }
        // Formatting is deliberately selected from the bytes observed at the
        // last commit-stage check, rather than from the plan-stage snapshot.
        const replacement = formatReplacement(current, item.replacementText);
        await writeFile(item.stagePath, replacement, { flag: 'wx', mode: 0o600 });
        await this.beforeBackup?.(item.relativePath, index);
        await rename(item.absolutePath, item.backupPath);
        item.movedToBackup = true;
        const backup = await readRegularTextFile(item.backupPath, item.relativePath);
        if (backup.sha256 !== item.input.sha256_before.toLowerCase()) {
          throw new GovernanceReconciliationError(
            'GOVERNANCE_RECONCILIATION_SHA_CONFLICT',
            `Reconciliation target changed during backup: ${item.relativePath}`,
            { path: item.relativePath },
          );
        }
        await rename(item.stagePath, item.absolutePath);
        item.installed = true;
        item.installedBytes = replacement;
      }
      for (const item of planned) {
        if (!item.installed || item.installedBytes === null) continue;
        const installed = await readRegularTextFile(item.absolutePath, item.relativePath);
        if (!installed.rawBytes.equals(item.installedBytes)) {
          throw new GovernanceReconciliationError(
            'GOVERNANCE_RECONCILIATION_SHA_CONFLICT',
            `Reconciliation target changed after replacement: ${item.relativePath}`,
            { path: item.relativePath },
          );
        }
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
          let restoreBackup = item.movedToBackup;
          if (item.installed) {
            const state = await rollbackTargetState(item.absolutePath);
            if (state === 'regular' && item.installedBytes !== null) {
              const installed = await readFile(item.absolutePath);
              // Compare exact installed bytes here: formatting-only external
              // edits are still external edits and must be retained.
              if (!installed.equals(item.installedBytes)) {
                restoreBackup = false;
              } else {
                await rm(item.absolutePath, { force: true });
              }
            } else {
              // A missing, non-regular, unreadable, or otherwise uncertain
              // target is external state. Never delete or overwrite it.
              restoreBackup = false;
            }
          } else if (restoreBackup && (await rollbackTargetState(item.absolutePath)) !== 'missing') {
            // The backup was created, but the target is no longer the expected
            // empty path. Preserve external state instead of overwriting it.
            restoreBackup = false;
          }
          if (restoreBackup) await rename(item.backupPath, item.absolutePath);
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
