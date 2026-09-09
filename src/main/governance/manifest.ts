import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { AtomicTextFileStore } from '../state/persistence.js';
import {
  assertSafeProjectPath,
  isPathWithinProject,
  realProjectRoot,
  resolveProjectPath,
  PathSafetyError,
} from '../security/path-safety.js';

export const GOVERNANCE_DOCUMENT_STATUSES = ['active', 'candidate', 'history'] as const;
export type GovernanceDocumentStatus = (typeof GOVERNANCE_DOCUMENT_STATUSES)[number];

export interface GovernanceManifestDocument {
  id: string;
  path: string;
  audience: string[];
  version: string | number;
  status: GovernanceDocumentStatus;
  type?: string;
  [key: string]: unknown;
}

export interface GovernanceManifest {
  version: string | number;
  documents: GovernanceManifestDocument[];
  [key: string]: unknown;
}

export interface GovernanceManifestIndex {
  version: string | number;
  extensions: Record<string, unknown>;
  all: GovernanceManifestDocument[];
  active: GovernanceManifestDocument[];
  candidate: GovernanceManifestDocument[];
  history: GovernanceManifestDocument[];
  byId: ReadonlyMap<string, GovernanceManifestDocument>;
}

export type GovernanceManifestErrorCode =
  | 'MANIFEST_NOT_FOUND'
  | 'MANIFEST_INVALID_YAML'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_PATH_OUTSIDE_PROJECT'
  | 'MANIFEST_PATH_UNSAFE';

export class GovernanceManifestError extends Error {
  readonly code: GovernanceManifestErrorCode;

  constructor(code: GovernanceManifestErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GovernanceManifestError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVersion(value: unknown): value is string | number {
  return (
    (typeof value === 'string' && value.trim().length > 0) || (typeof value === 'number' && Number.isFinite(value))
  );
}

function validateDocument(value: unknown, projectRoot: string, index: number): GovernanceManifestDocument {
  if (!isRecord(value)) {
    throw new GovernanceManifestError('MANIFEST_INVALID', `Manifest document ${index} must be an object`);
  }
  if (typeof value.id !== 'string' || value.id.trim() === '') {
    throw new GovernanceManifestError('MANIFEST_INVALID', `Manifest document ${index} requires an id`);
  }
  if (typeof value.path !== 'string' || value.path.trim() === '') {
    throw new GovernanceManifestError('MANIFEST_INVALID', `Manifest document ${index} requires a path`);
  }
  if (!isPathWithinProject(projectRoot, resolve(projectRoot, value.path))) {
    throw new GovernanceManifestError(
      'MANIFEST_PATH_OUTSIDE_PROJECT',
      `Manifest path is outside project: ${value.path}`,
    );
  }
  if (!Array.isArray(value.audience) || value.audience.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new GovernanceManifestError('MANIFEST_INVALID', `Manifest document ${index} requires an audience list`);
  }
  if (!isVersion(value.version)) {
    throw new GovernanceManifestError('MANIFEST_INVALID', `Manifest document ${index} requires a version`);
  }
  if (!GOVERNANCE_DOCUMENT_STATUSES.includes(value.status as GovernanceDocumentStatus)) {
    throw new GovernanceManifestError('MANIFEST_INVALID', `Manifest document ${index} has an unsupported status`);
  }
  return value as GovernanceManifestDocument;
}

export function validateGovernanceManifest(value: unknown, projectRoot: string): GovernanceManifest {
  if (!isRecord(value)) {
    throw new GovernanceManifestError('MANIFEST_INVALID', 'Governance manifest must be an object');
  }
  if (!isVersion(value.version)) {
    throw new GovernanceManifestError('MANIFEST_INVALID', 'Governance manifest requires a version');
  }
  if (!Array.isArray(value.documents)) {
    throw new GovernanceManifestError('MANIFEST_INVALID', 'Governance manifest requires a documents list');
  }
  const documents = value.documents.map((document, index) => validateDocument(document, projectRoot, index));
  const ids = new Set<string>();
  for (const document of documents) {
    if (ids.has(document.id)) {
      throw new GovernanceManifestError('MANIFEST_INVALID', `Duplicate governance document id: ${document.id}`);
    }
    ids.add(document.id);
  }
  return { ...value, documents } as GovernanceManifest;
}

export function indexGovernanceManifest(manifest: GovernanceManifest): GovernanceManifestIndex {
  const all = [...manifest.documents];
  const extensions = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== 'version' && key !== 'documents'),
  );
  return {
    version: manifest.version,
    extensions,
    all,
    active: all.filter((document) => document.status === 'active'),
    candidate: all.filter((document) => document.status === 'candidate'),
    history: all.filter((document) => document.status === 'history'),
    byId: new Map(all.map((document) => [document.id, document])),
  };
}

export class GovernanceManifestStore {
  private readonly projectRoot: string;
  private readonly manifestPath: string;
  private readonly textStore: AtomicTextFileStore;

  constructor(projectRoot: string, manifestPath = 'docs/governance/governance-manifest.yaml') {
    this.projectRoot = resolve(projectRoot);
    try {
      this.manifestPath = resolveProjectPath(this.projectRoot, manifestPath);
    } catch (error) {
      throw new GovernanceManifestError(
        'MANIFEST_PATH_OUTSIDE_PROJECT',
        `Manifest path is outside project: ${manifestPath}`,
        {
          cause: error,
        },
      );
    }
    this.textStore = new AtomicTextFileStore(this.manifestPath);
  }

  getPath(): string {
    return this.manifestPath;
  }

  async load(): Promise<GovernanceManifest | null> {
    await this.assertSafeManifestPath();
    const source = await this.textStore.load();
    if (source === null) {
      return null;
    }
    let value: unknown;
    try {
      value = parse(source) as unknown;
    } catch (error) {
      throw new GovernanceManifestError(
        'MANIFEST_INVALID_YAML',
        `Could not parse governance manifest: ${this.manifestPath}`,
        {
          cause: error,
        },
      );
    }
    const manifest = validateGovernanceManifest(value, this.projectRoot);
    await this.assertSafeDocumentPaths(manifest);
    return manifest;
  }

  async loadIndex(): Promise<GovernanceManifestIndex> {
    const manifest = await this.load();
    return indexGovernanceManifest(manifest ?? { version: 1, documents: [] });
  }

  async save(manifest: GovernanceManifest): Promise<void> {
    await this.assertSafeManifestPath();
    const validated = validateGovernanceManifest(manifest, this.projectRoot);
    await this.assertSafeDocumentPaths(validated);
    await this.textStore.save(stringify(validated));
  }

  async readDocument(document: GovernanceManifestDocument): Promise<string> {
    const documentPath = await this.safeDocumentPath(document);
    try {
      return await readFile(documentPath, 'utf8');
    } catch (error) {
      throw new GovernanceManifestError('MANIFEST_INVALID', `Could not read registered document: ${document.path}`, {
        cause: error,
      });
    }
  }

  private async assertSafeManifestPath(): Promise<void> {
    try {
      await realProjectRoot(this.projectRoot);
      await assertSafeProjectPath(this.projectRoot, this.manifestPath);
    } catch (error) {
      if (error instanceof PathSafetyError) {
        throw new GovernanceManifestError(
          error.code === 'PATH_OUTSIDE_PROJECT' ? 'MANIFEST_PATH_OUTSIDE_PROJECT' : 'MANIFEST_PATH_UNSAFE',
          `Manifest path is not safe: ${this.manifestPath}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async safeDocumentPath(document: GovernanceManifestDocument): Promise<string> {
    try {
      return await assertSafeProjectPath(this.projectRoot, resolveProjectPath(this.projectRoot, document.path));
    } catch (error) {
      if (error instanceof PathSafetyError) {
        throw new GovernanceManifestError(
          'MANIFEST_PATH_OUTSIDE_PROJECT',
          `Manifest document path is not safe: ${document.path}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async assertSafeDocumentPaths(manifest: GovernanceManifest): Promise<void> {
    await Promise.all(manifest.documents.map((document) => this.safeDocumentPath(document)));
  }
}

export function createGovernanceManifestStore(projectRoot: string, manifestPath?: string): GovernanceManifestStore {
  return new GovernanceManifestStore(projectRoot, manifestPath);
}
