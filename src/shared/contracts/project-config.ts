export interface ProjectConfig {
  schemaVersion: 1;
  projectId: string;
  localPath: string;
  remoteUrl: string | null;
  targetBranch: string;
  reportDirectory: string;
  currentBranch: string;
  headCommit: string;
  governanceManifestPath: string;
}

export interface ProjectScanResult {
  projectId: string;
  localPath: string;
  remoteUrl: string | null;
  currentBranch: string;
  headCommit: string;
  governanceManifestPath: string;
  governanceManifestExists: boolean;
  governanceManifestStatus: GovernanceManifestStatus;
  governanceManifestError?: GovernanceManifestErrorInfo;
  governanceDocumentCandidates: GovernanceDocumentCandidate[];
}

export type GovernanceManifestStatus = 'missing' | 'valid' | 'invalid';

export interface GovernanceManifestErrorInfo {
  code: string;
  message: string;
}

export interface GovernanceDocumentCandidate {
  id: string;
  path: string;
  exists: boolean;
  audience: string[];
  version: string | number;
  status: 'active' | 'candidate' | 'history';
  type?: string;
}

export interface ProjectConfigInput {
  projectId?: string;
  localPath: string;
  remoteUrl?: string | null;
  targetBranch?: string;
  reportDirectory: string;
  currentBranch?: string;
  headCommit?: string;
  governanceManifestPath?: string;
}

export const PROJECT_CONFIG_SCHEMA_VERSION = 1 as const;

export function assertProjectConfig(value: unknown): asserts value is ProjectConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Project config must be a JSON object');
  }
  const config = value as Record<string, unknown>;
  if (config.schemaVersion !== PROJECT_CONFIG_SCHEMA_VERSION) {
    throw new TypeError('Unsupported project config schema version');
  }
  for (const field of [
    'projectId',
    'localPath',
    'targetBranch',
    'reportDirectory',
    'currentBranch',
    'headCommit',
    'governanceManifestPath',
  ]) {
    if (typeof config[field] !== 'string' || config[field].trim().length === 0) {
      throw new TypeError(`Project config ${field} must be a non-empty string`);
    }
  }
  if (config.remoteUrl !== null && typeof config.remoteUrl !== 'string') {
    throw new TypeError('Project config remoteUrl must be a string or null');
  }
}

export function parseProjectConfig(value: unknown): ProjectConfig {
  assertProjectConfig(value);
  return value;
}

export function assertProjectConfigList(value: unknown): asserts value is ProjectConfig[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Project config store must be an array');
  }
  value.forEach(assertProjectConfig);
}

export function parseProjectConfigList(value: unknown): ProjectConfig[] {
  assertProjectConfigList(value);
  return value;
}
