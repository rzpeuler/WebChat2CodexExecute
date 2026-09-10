import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { GovernanceChangeBlock } from '../../shared/protocol/writing-block.js';
import { GovernanceManifestStore, type GovernanceManifest, type GovernanceManifestDocument } from './manifest.js';
import { AtomicTextFileStore } from '../state/persistence.js';
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
  | 'GOVERNANCE_CHANGE_DOCUMENT_UNREADABLE';

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

async function writeDocument(projectRoot: string, documentPath: string, content: string): Promise<void> {
  const safePath = await assertGovernancePath(projectRoot, documentPath);
  const store = new AtomicTextFileStore(safePath, {
    beforeOperation: async () => {
      await assertGovernancePath(projectRoot, safePath);
      await assertSafeProjectPath(projectRoot, `${safePath}.lock`);
      await assertSafeProjectPath(projectRoot, `${safePath}.bak`);
    },
  });
  await store.save(content.endsWith('\n') ? content : `${content}\n`);
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

export class GovernanceChangeApplier {
  private readonly projectRoot: string;
  private readonly manifestStore: GovernanceManifestStore;
  private readonly now: () => Date;
  private readonly source: string;

  constructor(projectRoot: string, options: GovernanceChangeApplierOptions = {}) {
    this.projectRoot = resolve(projectRoot);
    this.manifestStore = options.manifestStore ?? new GovernanceManifestStore(this.projectRoot);
    this.now = options.now ?? (() => new Date());
    this.source = options.source ?? 'Sol Writing Block';
  }

  async apply(change: GovernanceChangeBlock): Promise<GovernanceChangeApplyResult> {
    await realProjectRoot(this.projectRoot);
    const fields = change.fields;
    const operation = normalizeOperation(fields.operation);
    const fingerprint = stableFingerprint(change);
    const manifest = (await this.manifestStore.load()) ?? { version: 1, documents: [] };
    const appliedChanges = getAppliedChanges(manifest);
    const existingApplication = appliedChanges[fields.change_id];
    if (existingApplication !== undefined) {
      if (existingApplication.fingerprint !== fingerprint) {
        throw new GovernanceChangeError(
          'GOVERNANCE_CHANGE_ID_CONFLICT',
          `change_id was already used with different content: ${fields.change_id}`,
        );
      }
      return {
        changeId: fields.change_id,
        documentId: existingApplication.document_id,
        status: 'idempotent',
        activated: existingApplication.status === 'active',
        manifestVersion: manifest.version,
        changedPaths: [...existingApplication.changed_paths],
        diagnostics: [
          {
            code: 'GOVERNANCE_CHANGE_IDEMPOTENT',
            message: `Governance change was already applied: ${fields.change_id}`,
          },
        ],
      };
    }

    const existingDocument = manifest.documents.find((document) => document.id === fields.document_id);
    const existingContent =
      existingDocument === undefined ? null : await readDocumentIfPresent(this.projectRoot, existingDocument.path);
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
    await assertGovernancePath(this.projectRoot, targetPath);
    const targetContent = await readDocumentIfPresent(this.projectRoot, targetPath);
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
    let status: Exclude<GovernanceChangeApplyStatus, 'idempotent'> = highRisk ? 'candidate' : 'active';
    let documentId = fields.document_id;
    let nextDocuments = [...manifest.documents];

    if (highRisk) {
      const candidatePath = `docs/governance/candidates/${safeSegment(fields.document_id)}/${safeSegment(fields.change_id)}.md`;
      await writeDocument(this.projectRoot, candidatePath, content);
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
        await writeDocument(this.projectRoot, historyPath, existingContent);
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
      await writeDocument(this.projectRoot, targetPath, content);
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

    const nextManifest: GovernanceManifest = {
      ...manifest,
      version: nextVersion(manifest.version),
      documents: nextDocuments,
      applied_changes: {
        ...appliedChanges,
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
      },
    };
    await this.manifestStore.save(nextManifest);
    const diagnostics: GovernanceChangeDiagnostic[] = highRisk
      ? [
          {
            code: 'HIGH_RISK_CANDIDATE',
            message: 'High-risk governance changes are stored as candidates and are not active authority.',
          },
        ]
      : [];
    return {
      changeId: fields.change_id,
      documentId,
      status,
      activated: status === 'active',
      manifestVersion: nextManifest.version,
      changedPaths,
      diagnostics,
    };
  }

  async applyAll(changes: GovernanceChangeBlock[]): Promise<GovernanceChangeApplyResult[]> {
    const results: GovernanceChangeApplyResult[] = [];
    for (const change of changes) results.push(await this.apply(change));
    return results;
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
