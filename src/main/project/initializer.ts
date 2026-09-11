import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse as parsePath, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse, stringify } from 'yaml';
import type {
  ProjectInitializationInput,
  ProjectInitializationMode,
  ProjectInitializationResult,
  ProjectRemoteAccessCheckInput,
  ProjectRemoteAccessCheckResult,
} from '../../shared/contracts/project-initialization.js';
import { compareCodePoints } from '../../shared/sorting.js';
import {
  stringifyWritingBlockTemplate,
  WRITING_BLOCK_TEMPLATE_AUDIENCE,
  WRITING_BLOCK_TEMPLATE_DIRECTORY,
  WRITING_BLOCK_TEMPLATE_DOCUMENT_TYPE,
  WRITING_BLOCK_TEMPLATE_FILENAMES,
  WRITING_BLOCK_TEMPLATE_PATHS,
  WRITING_BLOCK_TEMPLATE_VERSION,
} from '../../shared/protocol/writing-block-templates.js';
import type { WritingBlockType } from '../../shared/protocol/writing-block.js';
import { assertSafeProjectPath, realProjectRoot } from '../security/path-safety.js';
import type { GovernanceManifest } from '../governance/manifest.js';
import { redactRemoteUrl } from './config.js';

const execFile = promisify(execFileCallback);
const GOVERNANCE_DIRECTORY = 'docs/governance';
const MANIFEST_PATH = `${GOVERNANCE_DIRECTORY}/governance-manifest.yaml`;
const TOOL_DIRECTORY = '.web-chat2codex';
const MANAGED_BY = 'web-chat2codex';
const TEMPLATE_VERSION = 2;

export type ProjectInitializationErrorCode =
  | 'INVALID_INPUT'
  | 'DANGEROUS_PATH'
  | 'PATH_TRAVERSAL'
  | 'PATH_UNSAFE'
  | 'TARGET_CONFLICT'
  | 'NOT_GIT_REPOSITORY'
  | 'NESTED_GIT_REPOSITORY'
  | 'REMOTE_URL_INVALID'
  | 'REMOTE_CREDENTIALS_FORBIDDEN'
  | 'BRANCH_INVALID'
  | 'CLONE_FAILED'
  | 'INITIALIZATION_DRIFT'
  | 'INITIALIZATION_FAILED';

export class ProjectInitializationError extends Error {
  readonly code: ProjectInitializationErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ProjectInitializationErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'ProjectInitializationError';
    this.code = code;
    this.details = details;
  }
}

export interface ProjectInitializerExecOptions {
  cwd: string;
  shell: false;
  windowsHide: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface ProjectInitializerCommandResult {
  stdout: string;
  stderr: string;
}

export type ProjectInitializerExecFile = (
  file: string,
  args: readonly string[],
  options: ProjectInitializerExecOptions,
) => Promise<ProjectInitializerCommandResult>;

export type ProjectInitializerRename = (sourcePath: string, targetPath: string) => Promise<void>;

export interface ProjectInitializerOptions {
  execFile?: ProjectInitializerExecFile;
  runId?: () => string;
  rename?: ProjectInitializerRename;
}

const STANDARD_DOCUMENTS = new Map<string, string>([
  [
    'README.md',
    `# Project Governance

\`docs/governance\` is the project's only governance entry point and the manifest in this directory is the only active-source registry.

Read the active documents registered by \`governance-manifest.yaml\` before changing code or project policy. Files found elsewhere are not active governance unless the manifest explicitly registers them.
`,
  ],
  [
    'PROJECT_RULES.md',
    `# Project Rules

This document is active governance under the single \`docs/governance\` entry point.

- Keep changes within the approved task scope.
- Preserve unrelated work and never overwrite unreviewed local changes.
- Treat credentials and private data as secrets; do not write them to project files or logs.
- Validate behavior in proportion to risk and report remaining limitations.
`,
  ],
  [
    'DEVELOPMENT_WORKFLOW.md',
    `# Development Workflow

This workflow is active only through the \`docs/governance/governance-manifest.yaml\` registry.

1. Inspect the repository state and applicable active governance.
2. Make the smallest scoped change that satisfies the task.
3. Run focused tests and type checking.
4. Review the final diff for safety, scope, and accidental secret exposure.
5. Commit or push only through an explicitly authorized workflow.
`,
  ],
  [
    'AGENT_ROLES.md',
    `# Agent Roles

Role authority is defined from the single \`docs/governance\` entry point.

- Sol plans and coordinates work within active governance.
- Luna implements approved tasks and reports validation evidence and governance gaps.
- The automation layer enforces repository, path, protocol, and Git safety boundaries.
- No role may silently broaden scope or promote unregistered documents to active governance.
`,
  ],
  [
    'GIT_POLICY.md',
    `# Git Policy

This policy is active through the \`docs/governance\` manifest only.

- Bind work to a verified repository root, branch, commit, and remote baseline.
- Never force-push or rewrite shared history through automation.
- Commit only approved changed paths after required validation passes.
- Treat remote uncertainty and baseline drift as blocking conditions.
`,
  ],
]);

const writingBlockTemplateTypes = Object.keys(WRITING_BLOCK_TEMPLATE_FILENAMES) as WritingBlockType[];

const STANDARD_MANIFEST: GovernanceManifest = {
  version: 1,
  managed_by: MANAGED_BY,
  template_version: TEMPLATE_VERSION,
  governance_entry_point: GOVERNANCE_DIRECTORY,
  documents: [
    standardManifestDocument('governance-readme', 'README.md', 'entry-point'),
    standardManifestDocument('project-rules', 'PROJECT_RULES.md', 'project-policy'),
    standardManifestDocument('development-workflow', 'DEVELOPMENT_WORKFLOW.md', 'workflow'),
    standardManifestDocument('agent-roles', 'AGENT_ROLES.md', 'roles'),
    standardManifestDocument('git-policy', 'GIT_POLICY.md', 'git-policy'),
    ...writingBlockTemplateTypes.map((type) => writingBlockManifestDocument(type)),
  ],
};

const LEGACY_STANDARD_MANIFEST: GovernanceManifest = {
  version: 1,
  managed_by: MANAGED_BY,
  template_version: 1,
  governance_entry_point: GOVERNANCE_DIRECTORY,
  documents: [
    standardManifestDocument('governance-readme', 'README.md', 'entry-point'),
    standardManifestDocument('project-rules', 'PROJECT_RULES.md', 'project-policy'),
    standardManifestDocument('development-workflow', 'DEVELOPMENT_WORKFLOW.md', 'workflow'),
    standardManifestDocument('agent-roles', 'AGENT_ROLES.md', 'roles'),
    standardManifestDocument('git-policy', 'GIT_POLICY.md', 'git-policy'),
  ],
};

function standardManifestDocument(id: string, fileName: string, type: string) {
  return {
    id,
    path: `${GOVERNANCE_DIRECTORY}/${fileName}`,
    audience: ['Sol', 'Luna', 'Codex'],
    version: 1,
    status: 'active' as const,
    type,
  };
}

function writingBlockManifestDocument(type: WritingBlockType) {
  return {
    id: `writing-block-template-${type.toLowerCase().replaceAll('_', '-')}`,
    path: WRITING_BLOCK_TEMPLATE_PATHS[type],
    audience: [...WRITING_BLOCK_TEMPLATE_AUDIENCE],
    version: WRITING_BLOCK_TEMPLATE_VERSION,
    status: 'active' as const,
    type: WRITING_BLOCK_TEMPLATE_DOCUMENT_TYPE,
  };
}

const STANDARD_MANIFEST_SOURCE = stringify(STANDARD_MANIFEST);
const LEGACY_MANIFEST_SOURCE = stringify(LEGACY_STANDARD_MANIFEST);
const WRITING_BLOCK_TEMPLATE_RELATIVE_DIRECTORY = WRITING_BLOCK_TEMPLATE_DIRECTORY.slice(
  `${GOVERNANCE_DIRECTORY}/`.length,
);

const STANDARD_TEMPLATE_FILES = new Map<string, string>(
  writingBlockTemplateTypes.map((type) => [
    `${WRITING_BLOCK_TEMPLATE_RELATIVE_DIRECTORY}/${WRITING_BLOCK_TEMPLATE_FILENAMES[type]}`,
    `${stringifyWritingBlockTemplate(type)}\n`,
  ]),
);

const STANDARD_MANAGED_FILES = new Map<string, string>([
  ...STANDARD_DOCUMENTS,
  ['governance-manifest.yaml', STANDARD_MANIFEST_SOURCE],
  ...STANDARD_TEMPLATE_FILES,
]);

const LEGACY_MANAGED_FILES = new Map<string, string>([
  ...STANDARD_DOCUMENTS,
  ['governance-manifest.yaml', LEGACY_MANIFEST_SOURCE],
]);

const STANDARD_PATHS = [...STANDARD_MANAGED_FILES.keys()].map((fileName) => `${GOVERNANCE_DIRECTORY}/${fileName}`);

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function pathKey(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function relativeProjectPath(projectRoot: string, targetPath: string): string {
  return relative(projectRoot, targetPath).replaceAll('\\', '/');
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodePoints);
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new ProjectInitializationError('INVALID_INPUT', `${name} must be a non-empty string`);
  }
}

function assertAbsoluteDirectory(value: string, name: string): string {
  assertNonEmptyString(value, name);
  if (!isAbsolute(value)) {
    throw new ProjectInitializationError('PATH_TRAVERSAL', `${name} must be an absolute path`);
  }
  return resolve(value);
}

function assertSafeDirectoryName(value: string): string {
  assertNonEmptyString(value, 'directoryName');
  const trimmed = value.trim();
  if (
    trimmed === '.' ||
    trimmed === '..' ||
    basename(trimmed) !== trimmed ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.endsWith('.') ||
    trimmed.endsWith(' ') ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(trimmed)
  ) {
    throw new ProjectInitializationError('PATH_TRAVERSAL', 'directoryName must be one safe path segment');
  }
  return trimmed;
}

function assertNotDangerousPath(targetPath: string, label: string): void {
  const candidates = [
    parsePath(targetPath).root,
    homedir(),
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData,
  ].filter((value): value is string => typeof value === 'string' && value.trim() !== '');
  if (candidates.some((candidate) => pathKey(candidate) === pathKey(targetPath))) {
    throw new ProjectInitializationError('DANGEROUS_PATH', `${label} is too broad or system-sensitive`);
  }
}

function validateRemoteUrl(value: string): string {
  assertNonEmptyString(value, 'remoteUrl');
  const remoteUrl = value.trim();
  if (remoteUrl.startsWith('-') || /[\r\n]/.test(remoteUrl)) {
    throw new ProjectInitializationError('REMOTE_URL_INVALID', 'Remote URL is not safe for Git clone');
  }

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(remoteUrl)) {
    let parsed: URL;
    try {
      parsed = new URL(remoteUrl);
    } catch {
      throw new ProjectInitializationError('REMOTE_URL_INVALID', 'Remote URL is malformed');
    }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol) || parsed.hostname === '') {
      throw new ProjectInitializationError('REMOTE_URL_INVALID', 'Remote URL uses an unsupported scheme');
    }
    const httpUserInfo =
      ['https:', 'http:'].includes(parsed.protocol) && (parsed.username !== '' || parsed.password !== '');
    if (httpUserInfo || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
      throw new ProjectInitializationError(
        'REMOTE_CREDENTIALS_FORBIDDEN',
        'Remote URLs must not contain credentials, query parameters, or fragments',
      );
    }
    return remoteUrl;
  }

  if (!/^[a-zA-Z][a-zA-Z\d._-]*@[a-zA-Z\d.-]+:[^\s]+$/.test(remoteUrl)) {
    throw new ProjectInitializationError('REMOTE_URL_INVALID', 'Remote URL must be HTTP(S), SSH, Git, or SCP-like');
  }
  return remoteUrl;
}

async function defaultExecFile(
  file: string,
  args: readonly string[],
  options: ProjectInitializerExecOptions,
): Promise<ProjectInitializerCommandResult> {
  const result = await execFile(file, [...args], {
    cwd: options.cwd,
    shell: false,
    windowsHide: options.windowsHide,
    ...(options.env === undefined ? {} : { env: options.env }),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

async function pathState(targetPath: string): Promise<'missing' | 'empty-directory' | 'nonempty-directory' | 'other'> {
  try {
    const stats = await lstat(targetPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return 'other';
    return (await readdir(targetPath)).length === 0 ? 'empty-directory' : 'nonempty-directory';
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return 'missing';
    throw new ProjectInitializationError('PATH_UNSAFE', 'Could not inspect the selected path');
  }
}

async function listTree(projectRoot: string, directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) => compareCodePoints(left.name, right.name))) {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      paths.push(...(await listTree(projectRoot, entryPath)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      paths.push(relativeProjectPath(projectRoot, entryPath));
    }
  }
  return paths;
}

function hasManagedMarker(source: string): boolean {
  try {
    const value: unknown = parse(source);
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).managed_by === MANAGED_BY
    );
  } catch {
    return /^managed_by:\s*web-chat2codex\s*$/m.test(source);
  }
}

type ManagedDirectoryState = 'current' | 'legacy' | false;

function expectedManagedEntries(files: ReadonlyMap<string, string>): string[] {
  const directories = new Set<string>();
  for (const fileName of files.keys()) {
    const segments = fileName.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(`${segments.slice(0, index).join('/')}/`);
    }
  }
  return uniqueSorted([...directories, ...files.keys()]);
}

async function listManagedEntries(directoryPath: string, currentPath = directoryPath): Promise<string[]> {
  const entries = await readdir(currentPath, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) => compareCodePoints(left.name, right.name))) {
    const entryPath = join(currentPath, entry.name);
    const entryRelativePath = relativeProjectPath(directoryPath, entryPath);
    if (entry.isSymbolicLink()) {
      paths.push(`${entryRelativePath}:symbolic-link`);
    } else if (entry.isDirectory()) {
      paths.push(`${entryRelativePath}/`);
      paths.push(...(await listManagedEntries(directoryPath, entryPath)));
    } else if (entry.isFile()) {
      paths.push(entryRelativePath);
    } else {
      paths.push(`${entryRelativePath}:unsafe-entry`);
    }
  }
  return paths;
}

interface GovernanceDirectorySnapshot {
  state: 'empty-directory' | 'nonempty-directory';
  entries: string[];
  fileContents: ReadonlyMap<string, string>;
}

function managedEntryPath(entry: string): string {
  const annotation = entry.endsWith(':symbolic-link')
    ? '（符号链接）'
    : entry.endsWith(':unsafe-entry')
      ? '（不安全条目）'
      : '';
  const path = entry.replace(/:(?:symbolic-link|unsafe-entry)$/, '').replace(/\/$/, '');
  return `${GOVERNANCE_DIRECTORY}/${path}${annotation}`;
}

function isManagedFileEntry(entry: string): boolean {
  return !entry.endsWith('/') && !entry.endsWith(':symbolic-link') && !entry.endsWith(':unsafe-entry');
}

async function captureGovernanceDirectorySnapshot(
  projectRoot: string,
  governancePath: string,
): Promise<GovernanceDirectorySnapshot> {
  const state = await pathState(governancePath);
  if (state !== 'empty-directory' && state !== 'nonempty-directory') {
    throw new ProjectInitializationError('PATH_UNSAFE', '安装前无法确认现有治理目录状态。');
  }
  let entries: string[];
  try {
    entries = await listManagedEntries(governancePath);
  } catch (error) {
    throw new ProjectInitializationError('PATH_UNSAFE', '安装前无法检查现有治理目录。', { cause: error });
  }
  const fileContents = new Map<string, string>();
  try {
    for (const entry of entries.filter(isManagedFileEntry)) {
      fileContents.set(entry, await readFile(join(governancePath, ...entry.split('/')), 'utf8'));
    }
  } catch (error) {
    throw new ProjectInitializationError('PATH_UNSAFE', '安装前无法读取现有治理文件。', { cause: error });
  }
  await assertSafeProjectPath(projectRoot, governancePath);
  return { state, entries, fileContents };
}

async function assertGovernanceDirectorySnapshotUnchanged(
  governancePath: string,
  snapshot: GovernanceDirectorySnapshot | null,
): Promise<void> {
  const currentState = await pathState(governancePath);
  if (snapshot === null) {
    if (currentState !== 'missing') {
      throw new ProjectInitializationError(
        'INITIALIZATION_DRIFT',
        '治理目录在安装期间发生变化，已停止安装。请先检查 details.paths，再手动处理或从备份恢复。',
        { paths: [GOVERNANCE_DIRECTORY] },
      );
    }
    return;
  }

  if (currentState !== snapshot.state) {
    throw new ProjectInitializationError(
      'INITIALIZATION_DRIFT',
      '治理目录在安装期间发生变化，已停止覆盖。请先检查 details.paths，再手动处理或从备份恢复。',
      { paths: [GOVERNANCE_DIRECTORY] },
    );
  }
  let currentEntries: string[];
  try {
    currentEntries = await listManagedEntries(governancePath);
  } catch (error) {
    throw new ProjectInitializationError('PATH_UNSAFE', '安装前无法再次检查现有治理目录。', { cause: error });
  }
  const changedEntries = uniqueSorted([
    ...snapshot.entries.filter((entry) => !currentEntries.includes(entry)),
    ...currentEntries.filter((entry) => !snapshot.entries.includes(entry)),
  ]);
  const changedFiles: string[] = [];
  for (const entry of snapshot.entries.filter(isManagedFileEntry)) {
    if (!currentEntries.includes(entry)) continue;
    try {
      const current = await readFile(join(governancePath, ...entry.split('/')), 'utf8');
      if (current !== snapshot.fileContents.get(entry)) changedFiles.push(entry);
    } catch {
      changedFiles.push(entry);
    }
  }
  const changedPaths = uniqueSorted([...changedEntries, ...changedFiles].map(managedEntryPath));
  if (changedPaths.length > 0) {
    throw new ProjectInitializationError(
      'INITIALIZATION_DRIFT',
      '治理目录在安装期间发生变化，已停止覆盖。请先检查 details.paths，再手动处理或从备份恢复。',
      { paths: changedPaths },
    );
  }
}

function manifestTemplateVersion(source: string): string | number | null {
  try {
    const value: unknown = parse(source);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const version = (value as Record<string, unknown>).template_version;
    return typeof version === 'string' || typeof version === 'number' ? version : null;
  } catch {
    return null;
  }
}

async function assertManagedDirectoryUnchanged(
  projectRoot: string,
  governancePath: string,
): Promise<ManagedDirectoryState> {
  const manifestPath = join(governancePath, 'governance-manifest.yaml');
  let source: string;
  try {
    source = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw new ProjectInitializationError('PATH_UNSAFE', 'Could not inspect the governance manifest');
  }
  if (!hasManagedMarker(source)) return false;

  let actualEntries: string[];
  try {
    actualEntries = await listManagedEntries(governancePath);
  } catch (error) {
    if (error instanceof ProjectInitializationError) throw error;
    throw new ProjectInitializationError('PATH_UNSAFE', 'Could not inspect the managed governance directory');
  }

  const currentStructure = expectedManagedEntries(STANDARD_MANAGED_FILES);
  const legacyStructure = expectedManagedEntries(LEGACY_MANAGED_FILES);
  const isLegacyVersion = manifestTemplateVersion(source) === 1;
  const expectedStructure = isLegacyVersion ? legacyStructure : currentStructure;
  const isExpectedStructure =
    actualEntries.length === expectedStructure.length &&
    actualEntries.every((entry, index) => entry === expectedStructure[index]);
  if (!isExpectedStructure) {
    const missingPaths = expectedStructure.filter((entry) => !actualEntries.includes(entry)).map(managedEntryPath);
    const extraPaths = actualEntries.filter((entry) => !expectedStructure.includes(entry)).map(managedEntryPath);
    throw new ProjectInitializationError(
      'INITIALIZATION_DRIFT',
      '治理目录结构已发生漂移，发现缺失或多余的治理文件/模板。请先检查 details.paths，再手动处理或从备份恢复。',
      { paths: uniqueSorted([...missingPaths, ...extraPaths]) },
    );
  }

  const expectedFiles = isLegacyVersion ? LEGACY_MANAGED_FILES : STANDARD_MANAGED_FILES;
  const mismatches: string[] = [];
  for (const [fileName, expected] of expectedFiles) {
    try {
      const actual = await readFile(join(governancePath, fileName), 'utf8');
      if (actual !== expected) mismatches.push(`${GOVERNANCE_DIRECTORY}/${fileName}`);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        mismatches.push(`${GOVERNANCE_DIRECTORY}/${fileName}`);
        continue;
      }
      throw new ProjectInitializationError('PATH_UNSAFE', 'Could not inspect a managed governance document');
    }
  }
  if (mismatches.length > 0) {
    throw new ProjectInitializationError(
      'INITIALIZATION_DRIFT',
      isLegacyVersion
        ? '发现托管治理 v1 文件已被修改，拒绝自动升级。请先检查 details.paths，再手动处理或从备份恢复。'
        : '发现托管治理文件或 Writing Block 模板已被修改。请先检查 details.paths，再手动处理或从备份恢复；初始化不会覆盖这些修改。',
      { paths: mismatches },
    );
  }
  await assertSafeProjectPath(projectRoot, manifestPath);
  return isLegacyVersion ? 'legacy' : 'current';
}

async function writeStandardGovernance(stageGovernancePath: string): Promise<void> {
  for (const [fileName, contents] of STANDARD_MANAGED_FILES) {
    const targetPath = join(stageGovernancePath, ...fileName.split('/'));
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, contents, { encoding: 'utf8', flag: 'wx' });
  }
}

function assertRunId(value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new ProjectInitializationError('INITIALIZATION_FAILED', 'Generated initialization run id is unsafe');
  }
  return value;
}

export class ProjectInitializer {
  private readonly execFile: ProjectInitializerExecFile;
  private readonly createRunId: () => string;
  private readonly renamePath: ProjectInitializerRename;

  constructor(options: ProjectInitializerOptions = {}) {
    this.execFile = options.execFile ?? defaultExecFile;
    this.createRunId = options.runId ?? randomUUID;
    this.renamePath = options.rename ?? rename;
  }

  async checkRemoteAccess(input: ProjectRemoteAccessCheckInput): Promise<ProjectRemoteAccessCheckResult> {
    let directory: string;
    let remoteUrl: string;
    try {
      directory = assertAbsoluteDirectory(input.directory, 'directory');
      assertNotDangerousPath(directory, 'directory');
      directory = await realProjectRoot(directory);
      remoteUrl = validateRemoteUrl(input.remoteUrl);
    } catch (error) {
      const code =
        error instanceof ProjectInitializationError && error.code === 'REMOTE_URL_INVALID'
          ? 'REMOTE_INVALID'
          : error instanceof ProjectInitializationError && error.code === 'REMOTE_CREDENTIALS_FORBIDDEN'
            ? 'REMOTE_INVALID'
            : 'DIRECTORY_INVALID';
      return {
        accessible: false,
        remoteUrl: redactRemoteUrl(typeof input.remoteUrl === 'string' ? input.remoteUrl : null) ?? '',
        code,
        message:
          code === 'REMOTE_INVALID' ? '远程仓库地址无效或包含不允许的凭证信息。' : '请选择安全且已存在的本地目录。',
      };
    }
    try {
      await this.execFile('git', ['ls-remote', '--', remoteUrl, 'HEAD'], {
        cwd: directory,
        shell: false,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      return { accessible: true, remoteUrl, code: 'OK', message: 'Git 远程仓库可访问，当前本机授权有效。' };
    } catch (error) {
      const stderr =
        typeof error === 'object' && error !== null && 'stderr' in error
          ? String((error as { stderr?: unknown }).stderr ?? '')
          : '';
      const diagnostic = `${error instanceof Error ? error.message : ''} ${stderr} ${String(error)}`;
      const authFailure =
        /authenticat|credential|permission denied|could not read username|repository not found|access denied/i.test(
          diagnostic,
        );
      return {
        accessible: false,
        remoteUrl,
        code: authFailure ? 'REMOTE_AUTH_REQUIRED' : 'REMOTE_UNREACHABLE',
        message: authFailure
          ? '远程仓库需要授权或当前授权无效。请使用 Git Credential Manager 或 SSH 配置后重试。软件不会保存凭证。'
          : '远程仓库暂时不可访问，请检查网络、地址和 Git 安装。',
      };
    }
  }

  async initialize(input: ProjectInitializationInput): Promise<ProjectInitializationResult> {
    if (typeof input !== 'object' || input === null || !['clone', 'adopt'].includes(input.mode)) {
      throw new ProjectInitializationError('INVALID_INPUT', 'Project initialization input is invalid');
    }

    const projectRoot = input.mode === 'clone' ? await this.clone(input) : await this.adopt(input.targetDirectory);
    return this.initializeGovernance(projectRoot, input.mode);
  }

  private async clone(input: Extract<ProjectInitializationInput, { mode: 'clone' }>): Promise<string> {
    const parentDirectory = assertAbsoluteDirectory(input.parentDirectory, 'parentDirectory');
    assertNotDangerousPath(parentDirectory, 'parentDirectory');
    let canonicalParent: string;
    try {
      canonicalParent = await realProjectRoot(parentDirectory);
    } catch {
      throw new ProjectInitializationError('PATH_UNSAFE', 'Clone parent directory is not a safe existing directory');
    }

    const directoryName = assertSafeDirectoryName(input.directoryName);
    const targetDirectory = resolve(canonicalParent, directoryName);
    if (dirname(targetDirectory) !== canonicalParent) {
      throw new ProjectInitializationError('PATH_TRAVERSAL', 'Clone target must remain directly under its parent');
    }
    assertNotDangerousPath(targetDirectory, 'targetDirectory');
    await assertSafeProjectPath(canonicalParent, targetDirectory).catch(() => {
      throw new ProjectInitializationError('PATH_UNSAFE', 'Clone target path is unsafe');
    });

    if ((await this.tryGitRoot(canonicalParent)) !== null) {
      throw new ProjectInitializationError('NESTED_GIT_REPOSITORY', 'Cannot clone inside an existing Git worktree');
    }
    const state = await pathState(targetDirectory);
    if (!['missing', 'empty-directory'].includes(state)) {
      throw new ProjectInitializationError('TARGET_CONFLICT', 'Clone target must be missing or an empty directory');
    }

    const remoteUrl = validateRemoteUrl(input.remoteUrl);
    const targetBranch = input.targetBranch;
    if (targetBranch !== undefined && !isValidBranchName(targetBranch)) {
      throw new ProjectInitializationError('BRANCH_INVALID', 'Clone target branch is invalid');
    }
    try {
      await this.execFile(
        'git',
        ['clone', ...(targetBranch === undefined ? [] : ['--branch', targetBranch]), '--', remoteUrl, targetDirectory],
        {
          cwd: canonicalParent,
          shell: false,
          windowsHide: true,
        },
      );
    } catch {
      throw new ProjectInitializationError('CLONE_FAILED', 'Git clone failed');
    }
    return this.assertExactGitRoot(targetDirectory);
  }

  private async adopt(targetDirectoryInput: string): Promise<string> {
    const targetDirectory = assertAbsoluteDirectory(targetDirectoryInput, 'targetDirectory');
    assertNotDangerousPath(targetDirectory, 'targetDirectory');
    const state = await pathState(targetDirectory);
    if (state === 'nonempty-directory' || state === 'empty-directory') return this.assertExactGitRoot(targetDirectory);
    if (state === 'missing') {
      throw new ProjectInitializationError('NOT_GIT_REPOSITORY', 'Selected Git repository does not exist');
    }
    throw new ProjectInitializationError('PATH_UNSAFE', 'Selected project path is not a safe directory');
  }

  private async assertExactGitRoot(targetDirectory: string): Promise<string> {
    let canonicalTarget: string;
    try {
      canonicalTarget = await realProjectRoot(targetDirectory);
    } catch {
      throw new ProjectInitializationError('PATH_UNSAFE', 'Selected project path is not a safe directory');
    }
    const repositoryRoot = await this.tryGitRoot(canonicalTarget);
    if (repositoryRoot === null) {
      const entries = await readdir(canonicalTarget);
      throw new ProjectInitializationError(
        entries.length > 0 ? 'TARGET_CONFLICT' : 'NOT_GIT_REPOSITORY',
        entries.length > 0
          ? 'Selected non-empty directory is not a Git repository'
          : 'Selected directory is not a Git repository',
      );
    }
    let canonicalRepositoryRoot: string;
    try {
      canonicalRepositoryRoot = await realpath(repositoryRoot);
    } catch {
      throw new ProjectInitializationError('PATH_UNSAFE', 'Git returned an unsafe repository root');
    }
    if (pathKey(canonicalRepositoryRoot) !== pathKey(canonicalTarget)) {
      throw new ProjectInitializationError(
        'NESTED_GIT_REPOSITORY',
        'Selected directory must be the Git repository root, not a nested path',
      );
    }
    return canonicalTarget;
  }

  private async tryGitRoot(cwd: string): Promise<string | null> {
    try {
      const result = await this.execFile('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        shell: false,
        windowsHide: true,
      });
      const root = result.stdout.trim();
      return root === '' ? null : root;
    } catch {
      return null;
    }
  }

  private async initializeGovernance(
    projectRoot: string,
    mode: ProjectInitializationMode,
  ): Promise<ProjectInitializationResult> {
    const governancePath = join(projectRoot, ...GOVERNANCE_DIRECTORY.split('/'));
    const existingState = await pathState(governancePath);
    if (existingState === 'other') {
      throw new ProjectInitializationError('TARGET_CONFLICT', 'docs/governance exists but is not a safe directory');
    }
    if (existingState !== 'missing') {
      await assertSafeProjectPath(projectRoot, governancePath).catch(() => {
        throw new ProjectInitializationError('PATH_UNSAFE', 'Existing governance directory is unsafe');
      });
      if ((await assertManagedDirectoryUnchanged(projectRoot, governancePath)) === 'current') {
        return {
          mode,
          projectRoot,
          governanceManifestPath: MANIFEST_PATH,
          changedPaths: [],
          backupPath: null,
          idempotent: true,
        };
      }
    }

    const governanceSnapshot =
      existingState === 'missing' ? null : await captureGovernanceDirectorySnapshot(projectRoot, governancePath);

    const runId = assertRunId(this.createRunId());
    const stageRunPath = join(projectRoot, TOOL_DIRECTORY, 'staging', runId);
    const stageGovernancePath = join(stageRunPath, 'governance');
    const backupRelativePath = `${TOOL_DIRECTORY}/backups/governance/${runId}`;
    const backupPath = join(projectRoot, ...backupRelativePath.split('/'));
    const originalPaths = existingState === 'missing' ? [] : await listTree(projectRoot, governancePath);

    for (const target of [stageRunPath, stageGovernancePath, backupPath, dirname(backupPath), governancePath]) {
      await assertSafeProjectPath(projectRoot, target).catch(() => {
        throw new ProjectInitializationError('PATH_UNSAFE', 'Initialization path is unsafe');
      });
    }
    if ((await pathState(stageRunPath)) !== 'missing' || (await pathState(backupPath)) !== 'missing') {
      throw new ProjectInitializationError('INITIALIZATION_FAILED', '初始化运行路径已存在，未安装治理模板。', {
        backupPath: null,
        recovery: '原有治理目录未被修改，可以更换运行 ID 后重试。',
      });
    }

    let backupInstalled = false;
    try {
      await writeStandardGovernance(stageGovernancePath);
      await mkdir(dirname(governancePath), { recursive: true });
      if (existingState !== 'missing') {
        await assertGovernanceDirectorySnapshotUnchanged(governancePath, governanceSnapshot);
        await mkdir(dirname(backupPath), { recursive: true });
        try {
          await assertSafeProjectPath(projectRoot, governancePath);
          await assertSafeProjectPath(projectRoot, backupPath);
          await assertGovernanceDirectorySnapshotUnchanged(governancePath, governanceSnapshot);
          await this.renamePath(governancePath, backupPath);
        } catch (error) {
          throw new ProjectInitializationError('INITIALIZATION_FAILED', '备份现有治理目录失败，未覆盖原目录。', {
            backupPath: null,
            recovery: '原有治理目录仍在原位置，请检查文件占用后重试。',
            cause: error,
          });
        }
        backupInstalled = true;
      }
      try {
        await assertGovernanceDirectorySnapshotUnchanged(governancePath, null);
        await assertSafeProjectPath(projectRoot, governancePath);
        await this.renamePath(stageGovernancePath, governancePath);
      } catch (installError) {
        if (!backupInstalled) {
          throw new ProjectInitializationError('INITIALIZATION_FAILED', '安装治理模板失败，原有目录未被覆盖。', {
            backupPath: null,
            recovery: '原有治理目录未被修改，可以检查错误后重试。',
            cause: installError,
          });
        }
        try {
          await this.renamePath(backupPath, governancePath);
          backupInstalled = false;
        } catch (rollbackError) {
          throw new ProjectInitializationError('INITIALIZATION_FAILED', '治理模板安装失败且原目录回滚失败。', {
            backupPath: backupRelativePath,
            recovery: '请使用该备份路径恢复 docs/governance，然后检查文件占用或并发修改。',
            cause: rollbackError,
            installError,
          });
        }
        throw new ProjectInitializationError('INITIALIZATION_FAILED', '治理模板安装失败，原目录已回滚。', {
          backupPath: null,
          recovery: '原有治理目录已恢复，可以检查错误后重试。',
          cause: installError,
        });
      }
    } catch (error) {
      if (error instanceof ProjectInitializationError) throw error;
      throw new ProjectInitializationError('INITIALIZATION_FAILED', '安装标准治理模板失败。', {
        backupPath: backupInstalled ? backupRelativePath : null,
        recovery: backupInstalled
          ? '请使用该备份路径恢复 docs/governance。'
          : '原有治理目录未被修改，可以检查错误后重试。',
        cause: error,
      });
    } finally {
      await rm(stageRunPath, { recursive: true, force: true }).catch(() => undefined);
    }

    // Backups are recovery material only. They intentionally remain local and
    // are never handed to Git as changed paths.
    const changedPaths = [...STANDARD_PATHS, ...originalPaths];
    return {
      mode,
      projectRoot,
      governanceManifestPath: MANIFEST_PATH,
      changedPaths: uniqueSorted(changedPaths),
      backupPath: backupInstalled ? backupRelativePath : null,
      idempotent: false,
    };
  }
}

function isValidBranchName(branch: string): boolean {
  const components = branch.split('/');
  return (
    branch.trim() === branch &&
    branch !== '' &&
    branch !== 'HEAD' &&
    components.every(
      (component) =>
        component !== '' &&
        component !== '.' &&
        component !== '..' &&
        !component.startsWith('.') &&
        !component.startsWith('-') &&
        !component.endsWith('.lock'),
    ) &&
    !branch.includes('..') &&
    !branch.includes('~') &&
    !branch.includes('^') &&
    !branch.includes(':') &&
    !branch.includes('\\') &&
    !branch.includes(' ') &&
    !branch.includes('*') &&
    !branch.includes('?') &&
    !branch.includes('[') &&
    !branch.includes('//') &&
    !branch.startsWith('/') &&
    !branch.endsWith('/') &&
    !branch.endsWith('.') &&
    !branch.endsWith('.lock') &&
    !branch.includes('@{') &&
    !/[\u0000-\u001f\u007f]/.test(branch)
  );
}
