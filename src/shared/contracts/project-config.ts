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
  writingBlockTemplates: WritingBlockTemplateScanResult;
}

export type GovernanceManifestStatus = 'missing' | 'valid' | 'invalid';

export interface GovernanceManifestErrorInfo {
  code: string;
  message: string;
}

export type WritingBlockTemplateScanStatus = 'missing' | 'invalid' | 'valid';

export interface WritingBlockTemplateScanFile {
  type: string;
  fileName: string;
  path: string;
  schemaVersion?: number;
}

export interface WritingBlockTemplateScanError {
  code: string;
  message: string;
  path: string;
  manifestPath: string;
  expectedVersion: number;
  actualVersion?: unknown;
}

export interface WritingBlockTemplateScanResult {
  status: WritingBlockTemplateScanStatus;
  directory: string;
  version: number;
  files: WritingBlockTemplateScanFile[];
  error?: WritingBlockTemplateScanError;
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
const FIXED_GOVERNANCE_MANIFEST_RELATIVE_PATH = 'docs/governance/governance-manifest.yaml';

function normalizePortablePath(value: string): string {
  const slashPath = value.replaceAll('\\', '/');
  const prefix = slashPath.startsWith('/') ? '/' : /^[A-Za-z]:\//.test(slashPath) ? slashPath.slice(0, 3) : '';
  const body = slashPath.slice(prefix.length);
  const segments: string[] = [];
  for (const segment of body.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..' && segments.length > 0 && segments.at(-1) !== '..') {
      segments.pop();
    } else if (segment !== '..') {
      segments.push(segment);
    }
  }
  const normalized = `${prefix}${segments.join('/')}`;
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function hasFixedGovernanceManifestPath(config: ProjectConfig): boolean {
  const localPath = normalizePortablePath(config.localPath).replace(/\/$/, '');
  const candidate = normalizePortablePath(config.governanceManifestPath);
  return (
    candidate === normalizePortablePath(FIXED_GOVERNANCE_MANIFEST_RELATIVE_PATH) ||
    candidate === `${localPath}/${FIXED_GOVERNANCE_MANIFEST_RELATIVE_PATH}`
  );
}

function redactRemoteUrl(remoteUrl: string | null): string | null {
  if (remoteUrl === null || remoteUrl.trim() === '') return null;
  const value = remoteUrl.trim();
  try {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
      const parsed = new URL(value);
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString().replace(/\/$/, '');
    }
  } catch {
    // Fall through to conservative textual redaction for malformed remotes.
  }
  return value
    .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/g, '://[REDACTED]@')
    .replace(/([?&](?:token|password|secret|key|auth|credentials?)[^=]*=)[^&\s]+/gi, '$1[REDACTED]');
}

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
  const config = value as ProjectConfig;
  const sanitizedRemoteUrl = redactRemoteUrl(config.remoteUrl);
  if (sanitizedRemoteUrl !== config.remoteUrl) {
    throw new TypeError('项目配置 remoteUrl 必须已脱敏，不能包含用户密码或 token 查询参数');
  }
  if (!hasFixedGovernanceManifestPath(config)) {
    throw new TypeError(`治理 manifest 路径必须固定为 ${FIXED_GOVERNANCE_MANIFEST_RELATIVE_PATH}`);
  }
  return { ...config, remoteUrl: sanitizedRemoteUrl };
}

export function assertProjectConfigList(value: unknown): asserts value is ProjectConfig[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Project config store must be an array');
  }
  value.forEach(assertProjectConfig);
}

export function parseProjectConfigList(value: unknown): ProjectConfig[] {
  assertProjectConfigList(value);
  return value.map((config) => parseProjectConfig(config));
}
