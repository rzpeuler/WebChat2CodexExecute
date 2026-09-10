import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AtomicJsonFileStore } from '../state/persistence.js';
import {
  PROJECT_CONFIG_SCHEMA_VERSION,
  parseProjectConfigList,
  type ProjectConfig,
  type ProjectConfigInput,
  type ProjectScanResult,
} from '../../shared/contracts/project-config.js';
import {
  GovernanceManifestError,
  GovernanceManifestStore,
  type GovernanceManifestDocument,
} from '../governance/manifest.js';
import { SolPromptCompiler, type SolPromptCompilation } from '../sol/prompt-compiler.js';
import {
  assertSafeFilePath,
  assertSafeProjectPath,
  realProjectRoot,
  PathSafetyError,
} from '../security/path-safety.js';
import { resolveProjectPath } from '../security/path-safety.js';

const execFile = promisify(execFileCallback);
const DEFAULT_MANIFEST_RELATIVE_PATH = 'docs/governance/governance-manifest.yaml';
const FORBIDDEN_CONFIG_KEYS = /cookie|password|token|secret|api[_-]?key/i;

export type ProjectConfigErrorCode =
  | 'INVALID_PROJECT_PATH'
  | 'NOT_GIT_REPOSITORY'
  | 'GIT_COMMAND_FAILED'
  | 'NO_HEAD_COMMIT'
  | 'PATH_OUTSIDE_PROJECT'
  | 'INVALID_PROJECT_CONFIG'
  | 'CREDENTIAL_FIELD_FORBIDDEN';

export class ProjectConfigError extends Error {
  readonly code: ProjectConfigErrorCode;

  constructor(code: ProjectConfigErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProjectConfigError';
    this.code = code;
  }
}

function trimOutput(value: string): string {
  return value.trim();
}

function candidatePathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export { isPathWithinProject, resolveProjectPath } from '../security/path-safety.js';

export function redactRemoteUrl(remoteUrl: string | null | undefined): string | null {
  if (remoteUrl === null || remoteUrl === undefined || remoteUrl.trim() === '') {
    return null;
  }
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
    .replace(/([?&](?:token|password|secret|key|auth)[^=]*=)[^&\s]+/gi, '$1[REDACTED]');
}

async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const result = await execFile('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 1024 * 1024 });
    return trimOutput(result.stdout);
  } catch (error) {
    throw new ProjectConfigError('GIT_COMMAND_FAILED', `Git command failed: git -C <project> ${args.join(' ')}`, {
      cause: error,
    });
  }
}

export async function scanGitProject(localPath: string): Promise<ProjectScanResult> {
  if (typeof localPath !== 'string' || localPath.trim() === '') {
    throw new ProjectConfigError('INVALID_PROJECT_PATH', 'A local project path is required');
  }
  const requestedPath = resolve(localPath);
  try {
    await realProjectRoot(requestedPath);
  } catch (error) {
    throw new ProjectConfigError('INVALID_PROJECT_PATH', `Project path is not accessible: ${requestedPath}`, {
      cause: error,
    });
  }

  let repositoryRoot: string;
  try {
    repositoryRoot = await realProjectRoot(await runGit(['rev-parse', '--show-toplevel'], requestedPath));
    if (trimOutput(await runGit(['rev-parse', '--is-inside-work-tree'], requestedPath)) !== 'true') {
      throw new Error('not a work tree');
    }
  } catch (error) {
    if (error instanceof ProjectConfigError && error.code === 'GIT_COMMAND_FAILED') {
      throw new ProjectConfigError('NOT_GIT_REPOSITORY', `Directory is not a Git repository: ${requestedPath}`, {
        cause: error,
      });
    }
    throw error;
  }

  const [remoteResult, branchResult, headResult] = await Promise.allSettled([
    runGit(['remote', 'get-url', 'origin'], repositoryRoot),
    runGit(['branch', '--show-current'], repositoryRoot),
    runGit(['rev-parse', 'HEAD'], repositoryRoot),
  ]);
  if (headResult.status === 'rejected') {
    throw new ProjectConfigError('NO_HEAD_COMMIT', 'Git repository has no readable HEAD commit', {
      cause: headResult.reason,
    });
  }
  const manifestPath = resolveProjectPath(repositoryRoot, DEFAULT_MANIFEST_RELATIVE_PATH);
  try {
    await assertSafeProjectPath(repositoryRoot, manifestPath);
  } catch (error) {
    if (error instanceof PathSafetyError) {
      throw new ProjectConfigError(
        error.code === 'PATH_OUTSIDE_PROJECT' ? 'PATH_OUTSIDE_PROJECT' : 'INVALID_PROJECT_PATH',
        error.message,
        { cause: error },
      );
    }
    throw error;
  }
  let manifestExists = false;
  try {
    await access(manifestPath);
    manifestExists = true;
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) {
      throw new ProjectConfigError('GIT_COMMAND_FAILED', `Could not inspect governance manifest: ${manifestPath}`, {
        cause: error,
      });
    }
  }

  let registeredGovernanceDocumentCandidates: ProjectScanResult['governanceDocumentCandidates'] = [];
  let governanceManifestStatus: ProjectScanResult['governanceManifestStatus'] = manifestExists ? 'valid' : 'missing';
  let governanceManifestError: ProjectScanResult['governanceManifestError'];
  if (manifestExists) {
    try {
      const manifest = await new GovernanceManifestStore(repositoryRoot, manifestPath).load();
      if (manifest === null) {
        governanceManifestStatus = 'missing';
      }
      registeredGovernanceDocumentCandidates = await Promise.all(
        (manifest?.documents ?? []).map((document) => toGovernanceDocumentCandidate(repositoryRoot, document)),
      );
    } catch (error) {
      if (!(
        error instanceof GovernanceManifestError && ['MANIFEST_INVALID_YAML', 'MANIFEST_INVALID'].includes(error.code)
      )) {
        throw error;
      }
      governanceManifestStatus = 'invalid';
      governanceManifestError = { code: error.code, message: error.message };
    }
  }
  // External-document conflict selection is deliberately delegated to Sol.
  // The software exposes only manifest-registered governance documents here;
  // it must not infer semantic candidates from directory or file names.
  const governanceDocumentCandidates = registeredGovernanceDocumentCandidates;

  return {
    projectId: randomUUID(),
    localPath: repositoryRoot,
    remoteUrl: remoteResult.status === 'fulfilled' ? redactRemoteUrl(remoteResult.value) : null,
    currentBranch: branchResult.status === 'fulfilled' && branchResult.value !== '' ? branchResult.value : 'HEAD',
    headCommit: headResult.value,
    governanceManifestPath: manifestPath,
    governanceManifestExists: manifestExists,
    governanceManifestStatus,
    ...(governanceManifestError === undefined ? {} : { governanceManifestError }),
    governanceDocumentCandidates,
  };
}

async function toGovernanceDocumentCandidate(
  projectRoot: string,
  document: GovernanceManifestDocument,
): Promise<ProjectScanResult['governanceDocumentCandidates'][number]> {
  const documentPath = await assertSafeProjectPath(projectRoot, document.path);
  let exists = false;
  try {
    await access(documentPath);
    exists = true;
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) {
      throw new ProjectConfigError('INVALID_PROJECT_PATH', `Could not inspect governance document: ${document.path}`, {
        cause: error,
      });
    }
  }
  return {
    id: document.id,
    path: document.path,
    exists,
    audience: [...document.audience],
    version: document.version,
    status: document.status,
    ...(typeof document.type === 'string' ? { type: document.type } : {}),
  };
}

function assertNoForbiddenKeys(value: unknown, path = 'config'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CONFIG_KEYS.test(key)) {
      throw new ProjectConfigError(
        'CREDENTIAL_FIELD_FORBIDDEN',
        `Credential-like field is not allowed: ${path}.${key}`,
      );
    }
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}

export function normalizeProjectConfig(input: ProjectConfigInput): ProjectConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ProjectConfigError('INVALID_PROJECT_CONFIG', 'Project config must be an object');
  }
  assertNoForbiddenKeys(input);
  const localPath = resolve(input.localPath);
  const headCommit = input.headCommit?.trim() || '';
  const reportDirectory = resolveProjectPath(localPath, input.reportDirectory);
  const governanceManifestPath = resolveProjectPath(
    localPath,
    input.governanceManifestPath ?? DEFAULT_MANIFEST_RELATIVE_PATH,
  );
  if (headCommit === '') {
    throw new ProjectConfigError('INVALID_PROJECT_CONFIG', 'Project config requires the scanned HEAD commit');
  }
  const config: ProjectConfig = {
    schemaVersion: PROJECT_CONFIG_SCHEMA_VERSION,
    projectId: input.projectId?.trim() || randomUUID(),
    localPath,
    remoteUrl: redactRemoteUrl(input.remoteUrl),
    targetBranch: input.targetBranch?.trim() || input.currentBranch?.trim() || 'HEAD',
    reportDirectory,
    currentBranch: input.currentBranch?.trim() || 'HEAD',
    headCommit,
    governanceManifestPath,
  };
  try {
    assertNoForbiddenKeys(config);
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      throw error;
    }
    throw new ProjectConfigError('INVALID_PROJECT_CONFIG', 'Project config contains invalid data', { cause: error });
  }
  return config;
}

export class ProjectConfigStore {
  private readonly store: AtomicJsonFileStore<ProjectConfig[]>;

  constructor(filePath: string) {
    const persistedFilePath = resolve(filePath);
    const safePersistenceCheck = async (): Promise<void> => {
      await assertSafeFilePath(persistedFilePath);
      await assertSafeFilePath(`${persistedFilePath}.lock`);
      await assertSafeFilePath(`${persistedFilePath}.bak`);
    };
    this.store = new AtomicJsonFileStore(persistedFilePath, {
      validate: (value) => {
        assertNoForbiddenKeys(value);
        return parseProjectConfigList(value);
      },
      beforeOperation: safePersistenceCheck,
    });
  }

  async loadAll(): Promise<ProjectConfig[]> {
    return (await this.store.load()) ?? [];
  }

  async get(projectId: string): Promise<ProjectConfig | null> {
    return (await this.loadAll()).find((config) => config.projectId === projectId) ?? null;
  }

  async save(configInput: ProjectConfigInput | ProjectConfig): Promise<ProjectConfig> {
    const config = normalizeProjectConfig(configInput);
    const configs = await this.loadAll();
    const index = configs.findIndex((item) => item.projectId === config.projectId);
    if (index === -1) {
      configs.push(config);
    } else {
      configs[index] = config;
    }
    assertNoForbiddenKeys(configs);
    await this.store.save(configs);
    return config;
  }
}

export class ProjectConfigService {
  constructor(private readonly store: ProjectConfigStore) {}

  scan(localPath: string): Promise<ProjectScanResult> {
    return scanGitProject(localPath);
  }

  async save(configInput: ProjectConfigInput | ProjectConfig): Promise<ProjectConfig> {
    if (typeof configInput !== 'object' || configInput === null || Array.isArray(configInput)) {
      throw new ProjectConfigError('INVALID_PROJECT_CONFIG', 'Project config must be an object');
    }
    const scan = await scanGitProject(configInput.localPath);
    if (scan.governanceManifestStatus === 'invalid') {
      throw new ProjectConfigError(
        'INVALID_PROJECT_CONFIG',
        `Governance manifest is invalid: ${scan.governanceManifestError?.message ?? 'unknown manifest error'}`,
      );
    }
    const suppliedBranch = typeof configInput.currentBranch === 'string' ? configInput.currentBranch.trim() : '';
    if (suppliedBranch !== '' && suppliedBranch !== scan.currentBranch) {
      throw new ProjectConfigError('INVALID_PROJECT_CONFIG', 'Project current branch does not match the Git scan');
    }
    const suppliedCommit = typeof configInput.headCommit === 'string' ? configInput.headCommit.trim() : '';
    if (suppliedCommit !== '' && suppliedCommit !== scan.headCommit) {
      throw new ProjectConfigError('INVALID_PROJECT_CONFIG', 'Project HEAD commit does not match the Git scan');
    }
    const suppliedRemote =
      configInput.remoteUrl === undefined ? scan.remoteUrl : redactRemoteUrl(configInput.remoteUrl);
    if (suppliedRemote !== scan.remoteUrl) {
      throw new ProjectConfigError('INVALID_PROJECT_CONFIG', 'Project remote does not match the Git scan');
    }
    const normalized = normalizeProjectConfig({
      ...configInput,
      projectId: configInput.projectId ?? scan.projectId,
      localPath: scan.localPath,
      remoteUrl: scan.remoteUrl,
      currentBranch: scan.currentBranch,
      headCommit: scan.headCommit,
      governanceManifestPath: configInput.governanceManifestPath ?? scan.governanceManifestPath,
    });
    await assertSafeProjectPath(normalized.localPath, normalized.reportDirectory);
    await assertSafeProjectPath(normalized.localPath, normalized.governanceManifestPath);
    return this.store.save(normalized);
  }

  load(projectId: string): Promise<ProjectConfig | null> {
    return this.store.get(projectId);
  }

  loadAll(): Promise<ProjectConfig[]> {
    return this.store.loadAll();
  }

  async previewSolPrompt(configInput: ProjectConfigInput | ProjectConfig): Promise<SolPromptCompilation> {
    if (typeof configInput !== 'object' || configInput === null || Array.isArray(configInput)) {
      throw new ProjectConfigError('INVALID_PROJECT_CONFIG', 'Project config must be an object');
    }
    const scan = await scanGitProject(configInput.localPath);
    const suppliedBranch = typeof configInput.currentBranch === 'string' ? configInput.currentBranch.trim() : '';
    if (suppliedBranch !== '' && suppliedBranch !== scan.currentBranch) {
      throw new ProjectConfigError('INVALID_PROJECT_CONFIG', 'Project current branch does not match the Git scan');
    }
    const suppliedCommit = typeof configInput.headCommit === 'string' ? configInput.headCommit.trim() : '';
    if (suppliedCommit !== '' && suppliedCommit !== scan.headCommit) {
      throw new ProjectConfigError('INVALID_PROJECT_CONFIG', 'Project HEAD commit does not match the Git scan');
    }
    const suppliedRemote =
      configInput.remoteUrl === undefined ? scan.remoteUrl : redactRemoteUrl(configInput.remoteUrl);
    if (suppliedRemote !== scan.remoteUrl) {
      throw new ProjectConfigError('INVALID_PROJECT_CONFIG', 'Project remote does not match the Git scan');
    }
    const requestedManifestPath = resolveProjectPath(
      scan.localPath,
      configInput.governanceManifestPath ?? scan.governanceManifestPath,
    );
    if (
      scan.governanceManifestStatus === 'invalid' &&
      candidatePathKey(requestedManifestPath) === candidatePathKey(scan.governanceManifestPath)
    ) {
      throw new ProjectConfigError(
        'INVALID_PROJECT_CONFIG',
        `Governance manifest is invalid: ${scan.governanceManifestError?.message ?? 'unknown manifest error'}`,
      );
    }
    const project = normalizeProjectConfig({
      ...configInput,
      projectId: configInput.projectId ?? scan.projectId,
      localPath: scan.localPath,
      remoteUrl: scan.remoteUrl,
      currentBranch: scan.currentBranch,
      headCommit: scan.headCommit,
      governanceManifestPath: configInput.governanceManifestPath ?? scan.governanceManifestPath,
    });
    await realProjectRoot(project.localPath);
    await assertSafeProjectPath(project.localPath, project.reportDirectory);
    await assertSafeProjectPath(project.localPath, project.governanceManifestPath);
    const manifest = await new GovernanceManifestStore(project.localPath, project.governanceManifestPath).load();
    return new SolPromptCompiler().compile({
      project,
      governance: manifest ?? { version: 1, documents: [] },
    });
  }
}

export function createProjectConfigStore(filePath: string): ProjectConfigStore {
  return new ProjectConfigStore(filePath);
}

export function defaultProjectConfigPath(userDataPath: string): string {
  return join(resolve(userDataPath), 'projects.json');
}
