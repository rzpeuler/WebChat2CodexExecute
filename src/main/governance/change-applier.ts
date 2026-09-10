import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { GovernanceChangeBlock } from '../../shared/protocol/writing-block.js';
import {
  GovernanceManifestStore,
  type GovernanceManifest,
  type GovernanceManifestDocument,
  validateGovernanceManifest,
} from './manifest.js';
import { withSharedStateTransactionLock } from '../state/persistence.js';
import { stringify as stringifyYaml } from 'yaml';
import {
  assertSafeProjectPath,
  realProjectRoot,
  resolveProjectPath,
  PathSafetyError,
} from '../security/path-safety.js';

export type GovernanceChangeOperation =
  'add_document' | 'update_document' | 'append_section' | 'deprecate_document' | 'record_decision';

export type GovernanceChangeApplyStatus = 'active' | 'candidate' | 'idempotent';

export interface GovernanceChangeApplyResult {
  changeId: string;
  documentId: string;
  status: GovernanceChangeApplyStatus;
  activated: boolean;
  manifestVersion: string | number;
  changedPaths: string[];
  diagnostics: GovernanceChangeDiagnostic[];
}

export interface GovernanceChangeDiagnostic {
  code: 'HIGH_RISK_CANDIDATE' | 'GOVERNANCE_CHANGE_IDEMPOTENT';
  message: string;
}

export interface GovernanceChangeApplierOptions {
  manifestStore?: GovernanceManifestStore;
  now?: () => Date;
  source?: string;
  beforeCommit?: (path: string, index: number) => void | Promise<void>;
}

export type GovernanceChangeErrorCode =
  | 'GOVERNANCE_CHANGE_INVALID'
  | 'GOVERNANCE_CHANGE_ID_CONFLICT'
  | 'GOVERNANCE_CHANGE_UNSUPPORTED_OPERATION'
  | 'GOVERNANCE_CHANGE_DOCUMENT_EXISTS'
  | 'GOVERNANCE_CHANGE_TARGET_EXISTS'
  | 'GOVERNANCE_CHANGE_DOCUMENT_NOT_FOUND'
  | 'GOVERNANCE_CHANGE_PATH_OUTSIDE_PROJECT'
  | 'GOVERNANCE_CHANGE_PATH_PROTECTED'
  | 'GOVERNANCE_CHANGE_DOCUMENT_UNREADABLE'
  | 'GOVERNANCE_CHANGE_COMMIT_FAILED';

export class GovernanceChangeError extends Error {
  readonly code: GovernanceChangeErrorCode;

  constructor(code: GovernanceChangeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GovernanceChangeError';
    this.code = code;
  }
}

interface AppliedGovernanceChange {
  change_id: string;
  fingerprint: string;
  document_id: string;
  status: Exclude<GovernanceChangeApplyStatus, 'idempotent'>;
  changed_paths: string[];
  source: string;
  recorded_at: string;
  extensions: Record<string, unknown>;
}

const PROTECTED_PREFIXES = ['.git', 'node_modules', 'dist', 'docs/superpowers'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function relativeProjectPath(projectRoot: string, path: string): string {
  return relative(projectRoot, path).replaceAll('\\', '/');
}

function safeSegment(value: string): string {
  const segment = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '_');
  return segment.length > 0 ? segment : 'change';
}

function assertGovernancePath(projectRoot: string, candidate: string): Promise<string> {
  let resolvedPath: string;
  try {
    resolvedPath = resolveProjectPath(projectRoot, candidate);
  } catch (error) {
    throw new GovernanceChangeError(
      'GOVERNANCE_CHANGE_PATH_OUTSIDE_PROJECT',
      `Governance path is outside project: ${candidate}`,
      {
        cause: error,
      },
    );
  }
  const normalized = relativeProjectPath(projectRoot, resolvedPath).toLowerCase();
  if (PROTECTED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    throw new GovernanceChangeError('GOVERNANCE_CHANGE_PATH_PROTECTED', `Governance path is protected: ${candidate}`);
  }
  return assertSafeProjectPath(projectRoot, resolvedPath).catch((error: unknown) => {
    if (error instanceof PathSafetyError && error.code === 'PATH_OUTSIDE_PROJECT') {
      throw new GovernanceChangeError(
        'GOVERNANCE_CHANGE_PATH_OUTSIDE_PROJECT',
        `Governance path is outside project: ${candidate}`,
        {
          cause: error,
        },
      );
    }
    throw new GovernanceChangeError('GOVERNANCE_CHANGE_INVALID', `Governance path is not safe: ${candidate}`, {
      cause: error,
    });
  });
}

function normalizeOperation(value: string): GovernanceChangeOperation {
  const normalized = value.trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  const aliases: Record<string, GovernanceChangeOperation> = {
    add: 'add_document',
    create: 'add_document',
    new: 'add_document',
    add_document: 'add_document',
    update: 'update_document',
    update_document: 'update_document',
    append: 'append_section',
    section: 'append_section',
    add_section: 'append_section',
    append_section: 'append_section',
    deprecate: 'deprecate_document',
    retire: 'deprecate_document',
    deprecate_document: 'deprecate_document',
    decision: 'record_decision',
    record_decision: 'record_decision',
  };
  const operation = aliases[normalized];
  if (operation === undefined) {
    throw new GovernanceChangeError(
      'GOVERNANCE_CHANGE_UNSUPPORTED_OPERATION',
      `Unsupported governance operation: ${value}`,
    );
  }
  return operation;
}

function isHighRiskChange(operation: GovernanceChangeOperation, change: GovernanceChangeBlock): boolean {
  const risk = change.fields.risk_level.toLowerCase();
  if (risk.includes('high') || risk.includes('critical')) return true;
  if (operation === 'deprecate_document') return true;
  const searchable = [change.fields.operation, change.fields.reason, change.fields.path, change.fields.content]
    .join(' ')
    .toLowerCase();
  return /delete|delet|permission|access control|branch|push|force|security|weaken|remove|删除|权限|分支|推送|安全|削弱/.test(
    searchable,
  );
}

function nextVersion(value: string | number | undefined): string | number {
  if (value === undefined) return 1;
  if (typeof value === 'number' && Number.isFinite(value)) return value + 1;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric + 1 : `${value}.1`;
}

function stableFingerprint(change: GovernanceChangeBlock): string {
  return createHash('sha256')
    .update(JSON.stringify({ type: change.type, fields: change.fields, extensions: change.extensions }), 'utf8')
    .digest('hex');
}

function getAppliedChanges(manifest: GovernanceManifest): Record<string, AppliedGovernanceChange> {
  return isRecord(manifest.applied_changes)
    ? (manifest.applied_changes as Record<string, AppliedGovernanceChange>)
    : {};
}

async function readDocumentIfPresent(projectRoot: string, documentPath: string): Promise<string | null> {
  const safePath = await assertGovernancePath(projectRoot, documentPath);
  try {
    return await readFile(safePath, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw new GovernanceChangeError(
      'GOVERNANCE_CHANGE_DOCUMENT_UNREADABLE',
      `Could not read governance document: ${documentPath}`,
      {
        cause: error,
      },
    );
  }
}

function buildManifestDocument(
  id: string,
  path: string,
  version: string | number,
  status: 'active' | 'candidate' | 'history',
  audience: string[],
  source: string,
  changeId: string,
  extensions: Record<string, unknown>,
): GovernanceManifestDocument {
  return {
    ...extensions,
    id,
    path,
    audience: [...audience],
    version,
    status,
    source,
    source_change_id: changeId,
  };
}

interface PlannedFile {
  relativePath: string;
  absolutePath: string;
  content: string;
}

interface BatchPlan {
  results: GovernanceChangeApplyResult[];
  files: PlannedFile[];
}

function fileKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function normalizedDocumentContent(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}

function commitError(error: unknown): GovernanceChangeError {
  if (error instanceof GovernanceChangeError) return error;
  return new GovernanceChangeError('GOVERNANCE_CHANGE_COMMIT_FAILED', 'Governance change batch commit failed', {
    cause: error,
  });
}

async function stageAndCommit(
  projectRoot: string,
  files: PlannedFile[],
  beforeCommit: ((path: string, index: number) => void | Promise<void>) | undefined,
): Promise<void> {
  const stageDirectory = await mkdtemp(join(projectRoot, '.governance-stage-'));
  const stageFiles: Array<{
    planned: PlannedFile;
    stagePath: string;
    backupPath: string;
    hadOriginal: boolean;
    backedUp: boolean;
    installed: boolean;
  }> = [];
  try {
    await mkdir(join(stageDirectory, 'backups'), { recursive: true });
    for (const [index, planned] of files.entries()) {
      await assertGovernancePath(projectRoot, planned.relativePath);
      const stagePath = join(stageDirectory, `file-${index}.stage`);
      await writeFile(stagePath, planned.content, { flag: 'wx', mode: 0o600 });
      let hadOriginal = false;
      try {
        await readFile(planned.absolutePath);
        hadOriginal = true;
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }
      stageFiles.push({
        planned,
        stagePath,
        backupPath: join(stageDirectory, 'backups', `file-${index}.backup`),
        hadOriginal,
        backedUp: false,
        installed: false,
      });
    }

    try {
      for (const item of stageFiles) {
        await assertGovernancePath(projectRoot, item.planned.relativePath);
        if (item.hadOriginal) {
          await rename(item.planned.absolutePath, item.backupPath);
          item.backedUp = true;
        }
      }
      for (const [index, item] of stageFiles.entries()) {
        await beforeCommit?.(item.planned.relativePath, index);
        await assertGovernancePath(projectRoot, item.planned.relativePath);
        await mkdir(dirname(item.planned.absolutePath), { recursive: true });
        await rename(item.stagePath, item.planned.absolutePath);
        item.installed = true;
      }
      await Promise.all(
        stageFiles.filter((item) => item.hadOriginal).map((item) => rm(item.backupPath, { force: true })),
      );
    } catch (error) {
      for (const item of [...stageFiles].reverse()) {
        try {
          if (item.installed) await rm(item.planned.absolutePath, { force: true });
          if (item.backedUp) await rename(item.backupPath, item.planned.absolutePath);
        } catch {
          // Preserve the original commit error; the backup remains available for recovery.
        }
      }
      throw commitError(error);
    }
  } catch (error) {
    throw commitError(error);
  } finally {
    await rm(stageDirectory, { recursive: true, force: true });
  }
}

export class GovernanceChangeApplier {
  private readonly projectRoot: string;
  private readonly manifestStore: GovernanceManifestStore;
  private readonly now: () => Date;
  private readonly source: string;
  private readonly beforeCommit: GovernanceChangeApplierOptions['beforeCommit'];

  constructor(projectRoot: string, options: GovernanceChangeApplierOptions = {}) {
    this.projectRoot = resolve(projectRoot);
    this.manifestStore = options.manifestStore ?? new GovernanceManifestStore(this.projectRoot);
    this.now = options.now ?? (() => new Date());
    this.source = options.source ?? 'Sol Writing Block';
    this.beforeCommit = options.beforeCommit;
  }

  async apply(change: GovernanceChangeBlock): Promise<GovernanceChangeApplyResult> {
    const results = await this.applyAll([change]);
    return results[0]!;
  }

  async applyAll(changes: GovernanceChangeBlock[]): Promise<GovernanceChangeApplyResult[]> {
    await realProjectRoot(this.projectRoot);
    await assertGovernancePath(this.projectRoot, relative(this.projectRoot, this.manifestStore.getPath()));
    return withSharedStateTransactionLock(`${this.manifestStore.getPath()}.batch`, async () => {
      const plan = await this.planBatch(changes);
      if (plan.files.length > 0) await stageAndCommit(this.projectRoot, plan.files, this.beforeCommit);
      return plan.results;
    });
  }

  private async planBatch(changes: GovernanceChangeBlock[]): Promise<BatchPlan> {
    const manifest = (await this.manifestStore.load()) ?? { version: 1, documents: [] };
    const appliedChanges = getAppliedChanges(manifest);
    const plannedContents = new Map<string, string | null>();
    const plannedFiles = new Map<string, PlannedFile>();
    const results: GovernanceChangeApplyResult[] = [];
    let nextDocuments = [...manifest.documents];
    let nextAppliedChanges = { ...appliedChanges };
    let nextManifestVersion = manifest.version;

    const readPlannedDocument = async (documentPath: string): Promise<string | null> => {
      const safePath = await assertGovernancePath(this.projectRoot, documentPath);
      const key = fileKey(safePath);
      if (plannedContents.has(key)) return plannedContents.get(key) ?? null;
      const content = await readDocumentIfPresent(this.projectRoot, documentPath);
      plannedContents.set(key, content);
      return content;
    };
    const planFile = async (documentPath: string, content: string): Promise<void> => {
      const safePath = await assertGovernancePath(this.projectRoot, documentPath);
      const normalized = normalizedDocumentContent(content);
      const planned: PlannedFile = {
        relativePath: relativeProjectPath(this.projectRoot, safePath),
        absolutePath: safePath,
        content: normalized,
      };
      plannedFiles.set(fileKey(safePath), planned);
      plannedContents.set(fileKey(safePath), normalized);
    };

    for (const change of changes) {
      const fields = change.fields;
      const operation = normalizeOperation(fields.operation);
      const fingerprint = stableFingerprint(change);
      const existingApplication = nextAppliedChanges[fields.change_id];
      if (existingApplication !== undefined) {
        if (existingApplication.fingerprint !== fingerprint) {
          throw new GovernanceChangeError(
            'GOVERNANCE_CHANGE_ID_CONFLICT',
            `change_id was already used with different content: ${fields.change_id}`,
          );
        }
        results.push({
          changeId: fields.change_id,
          documentId: existingApplication.document_id,
          status: 'idempotent',
          activated: existingApplication.status === 'active',
          manifestVersion: nextManifestVersion,
          changedPaths: [...existingApplication.changed_paths],
          diagnostics: [
            {
              code: 'GOVERNANCE_CHANGE_IDEMPOTENT',
              message: `Governance change was already applied: ${fields.change_id}`,
            },
          ],
        });
        continue;
      }

      const existingDocument = nextDocuments.find((document) => document.id === fields.document_id);
      const existingContent = existingDocument === undefined ? null : await readPlannedDocument(existingDocument.path);
      if (operation === 'add_document' && existingDocument !== undefined) {
        throw new GovernanceChangeError(
          'GOVERNANCE_CHANGE_DOCUMENT_EXISTS',
          `Governance document already exists: ${fields.document_id}`,
        );
      }
      if (operation !== 'add_document' && operation !== 'record_decision' && existingDocument === undefined) {
        throw new GovernanceChangeError(
          'GOVERNANCE_CHANGE_DOCUMENT_NOT_FOUND',
          `Governance document was not found: ${fields.document_id}`,
        );
      }
      if (existingDocument !== undefined && existingContent === null) {
        throw new GovernanceChangeError(
          'GOVERNANCE_CHANGE_DOCUMENT_UNREADABLE',
          `Governance document is missing: ${existingDocument.path}`,
        );
      }

      const targetPath = fields.path;
      const targetContent = await readPlannedDocument(targetPath);
      if (
        targetContent !== null &&
        (existingDocument === undefined || existingDocument.path.toLowerCase() !== targetPath.toLowerCase())
      ) {
        throw new GovernanceChangeError(
          'GOVERNANCE_CHANGE_TARGET_EXISTS',
          `Governance target already exists: ${targetPath}`,
        );
      }
      let content = fields.content;
      if (operation === 'append_section') {
        content = `${existingContent ?? ''}${existingContent?.endsWith('\n') ? '' : '\n'}\n${fields.content}`;
      }
      const highRisk = isHighRiskChange(operation, change);
      const changedPaths: string[] = [];
      const status: Exclude<GovernanceChangeApplyStatus, 'idempotent'> = highRisk ? 'candidate' : 'active';
      let documentId = fields.document_id;

      if (highRisk) {
        const candidatePath = `docs/governance/candidates/${safeSegment(fields.document_id)}/${safeSegment(fields.change_id)}.md`;
        await planFile(candidatePath, content);
        changedPaths.push(candidatePath);
        documentId =
          existingDocument === undefined ? fields.document_id : `${fields.document_id}@candidate@${fields.change_id}`;
        nextDocuments = nextDocuments.filter((document) => document.id !== documentId);
        nextDocuments.push(
          buildManifestDocument(
            documentId,
            candidatePath,
            nextVersion(existingDocument?.version),
            'candidate',
            fields.affected_agents,
            this.source,
            fields.change_id,
            change.extensions,
          ),
        );
      } else {
        if (existingDocument !== undefined && existingContent !== null) {
          const historyPath = `docs/governance/history/${safeSegment(fields.document_id)}/v${safeSegment(String(existingDocument.version))}-${safeSegment(fields.change_id)}.md`;
          await planFile(historyPath, existingContent);
          changedPaths.push(historyPath);
          nextDocuments.push(
            buildManifestDocument(
              `${fields.document_id}@history@${fields.change_id}`,
              historyPath,
              existingDocument.version,
              'history',
              existingDocument.audience,
              this.source,
              fields.change_id,
              { previous_document_id: fields.document_id },
            ),
          );
        }
        await planFile(targetPath, content);
        changedPaths.push(targetPath);
        nextDocuments = nextDocuments.filter((document) => document.id !== fields.document_id);
        nextDocuments.push(
          buildManifestDocument(
            fields.document_id,
            targetPath,
            nextVersion(existingDocument?.version),
            'active',
            fields.affected_agents,
            this.source,
            fields.change_id,
            change.extensions,
          ),
        );
      }

      nextManifestVersion = nextVersion(nextManifestVersion);
      nextAppliedChanges = {
        ...nextAppliedChanges,
        [fields.change_id]: {
          change_id: fields.change_id,
          fingerprint,
          document_id: documentId,
          status,
          changed_paths: changedPaths,
          source: this.source,
          recorded_at: this.now().toISOString(),
          extensions: { ...change.extensions },
        } satisfies AppliedGovernanceChange,
      };
      results.push({
        changeId: fields.change_id,
        documentId,
        status,
        activated: status === 'active',
        manifestVersion: nextManifestVersion,
        changedPaths,
        diagnostics: highRisk
          ? [
              {
                code: 'HIGH_RISK_CANDIDATE',
                message: 'High-risk governance changes are stored as candidates and are not active authority.',
              },
            ]
          : [],
      });
    }

    const nextManifest: GovernanceManifest = {
      ...manifest,
      version: nextManifestVersion,
      documents: nextDocuments,
      applied_changes: nextAppliedChanges,
    };
    const validatedManifest = validateGovernanceManifest(nextManifest, this.projectRoot);
    if (results.some((result) => result.status !== 'idempotent')) {
      const manifestPath = await assertGovernancePath(
        this.projectRoot,
        relativeProjectPath(this.projectRoot, this.manifestStore.getPath()),
      );
      plannedFiles.set(fileKey(manifestPath), {
        relativePath: relativeProjectPath(this.projectRoot, manifestPath),
        absolutePath: manifestPath,
        content: stringifyYaml(validatedManifest),
      });
    }
    return { results, files: [...plannedFiles.values()] };
  }
}

export async function applyGovernanceChange(
  projectRoot: string,
  change: GovernanceChangeBlock,
  options: GovernanceChangeApplierOptions = {},
): Promise<GovernanceChangeApplyResult> {
  return new GovernanceChangeApplier(projectRoot, options).apply(change);
}

export async function applyGovernanceChanges(
  projectRoot: string,
  changes: GovernanceChangeBlock[],
  options: GovernanceChangeApplierOptions = {},
): Promise<GovernanceChangeApplyResult[]> {
  return new GovernanceChangeApplier(projectRoot, options).applyAll(changes);
}
