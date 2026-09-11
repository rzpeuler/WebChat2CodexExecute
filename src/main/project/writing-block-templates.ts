import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import {
  SUPPORTED_WRITING_BLOCK_TEMPLATE_VERSIONS,
  WRITING_BLOCK_TEMPLATE_AUDIENCE,
  WRITING_BLOCK_TEMPLATE_DIRECTORY,
  WRITING_BLOCK_TEMPLATE_DOCUMENT_TYPE,
  WRITING_BLOCK_TEMPLATE_FILENAMES,
  WRITING_BLOCK_TEMPLATE_PATHS,
  WRITING_BLOCK_TEMPLATE_VERSION,
} from '../../shared/protocol/writing-block-templates.js';
import { WRITING_BLOCK_JSON_SCHEMAS, type WritingBlockType } from '../../shared/protocol/writing-block.js';
import type {
  WritingBlockTemplateScanError,
  WritingBlockTemplateScanFile,
  WritingBlockTemplateScanResult,
} from '../../shared/contracts/project-config.js';
import type { GovernanceManifest } from '../governance/manifest.js';
import { assertSafeProjectPath, PathSafetyError, resolveProjectPath } from '../security/path-safety.js';

const TEMPLATE_TYPES = Object.keys(WRITING_BLOCK_TEMPLATE_FILENAMES) as WritingBlockType[];
// The manifest's top-level template_version tracks the managed governance tree
// revision. The per-file schema_version remains WRITING_BLOCK_TEMPLATE_VERSION.
const SUPPORTED_MANIFEST_TEMPLATE_VERSION = 2;
const WRITING_BLOCK_CLOSE_MARKER = '[/WRITING_BLOCK]';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function fixedPath(projectRoot: string, relativePath: string): string {
  return resolveProjectPath(projectRoot, relativePath);
}

function normalizedManifestPath(projectRoot: string, candidatePath: string): string | null {
  try {
    const lexicalPath = resolveProjectPath(projectRoot, candidatePath.replaceAll('\\', '/'));
    const relativePath = relative(resolve(projectRoot), lexicalPath)
      .replaceAll('\\', '/')
      .split('/')
      .filter((segment) => segment !== '' && segment !== '.')
      .join('/');
    return process.platform === 'win32' ? relativePath.toLowerCase() : relativePath;
  } catch {
    return null;
  }
}

function isSafeRegularFile(stats: { isFile(): boolean; isSymbolicLink(): boolean }): boolean {
  return stats.isFile() && !stats.isSymbolicLink();
}

function hasReservedClosingMarker(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === 'string') return value.includes(WRITING_BLOCK_CLOSE_MARKER);
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasReservedClosingMarker(item, seen));
  return Object.entries(value).some(
    ([key, child]) => key.includes(WRITING_BLOCK_CLOSE_MARKER) || hasReservedClosingMarker(child, seen),
  );
}

function sameFileIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev !== 0 && left.ino !== 0 && left.dev === right.dev && left.ino === right.ino;
}

class InvalidUtf8Error extends Error {
  readonly code = 'WRITING_BLOCK_TEMPLATE_INVALID_UTF8';

  constructor(path: string, cause: unknown) {
    super(`模板文件 ${path} 不是合法 UTF-8，无法可靠读取或计算 canonical-text-v1。`, { cause });
    this.name = 'InvalidUtf8Error';
  }
}

async function readSafeTemplateFile(projectRoot: string, relativePath: string): Promise<string> {
  const templatePath = fixedPath(projectRoot, relativePath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertSafeProjectPath(projectRoot, templatePath);
    const beforeOpen = await lstat(templatePath);
    if (!isSafeRegularFile(beforeOpen)) {
      throw new PathSafetyError('PROJECT_PATH_UNSAFE', `模板文件不是安全的普通文件：${relativePath}`);
    }
    // POSIX gets an atomic no-follow open. Node does not expose O_NOFOLLOW on
    // Windows, so the open handle is matched to a post-open non-reparse path
    // by file identity before the handle is read; a replacement after that
    // point cannot redirect the already-open handle.
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    try {
      handle = await open(templatePath, flags);
    } catch (error) {
      if (isNodeError(error, 'ELOOP')) {
        throw new PathSafetyError('PATH_OUTSIDE_PROJECT', `模板文件存在符号链接：${relativePath}`, { cause: error });
      }
      throw error;
    }
    // Re-check the path after opening and require the path and handle to name
    // the same object. This is the Windows fallback because Node exposes no
    // O_NOFOLLOW/reparse-point open flag there; unavailable file identity
    // fails closed instead of falling back to path-based readFile().
    await assertSafeProjectPath(projectRoot, templatePath);
    const opened = await handle.stat();
    const pathAfterOpen = await lstat(templatePath);
    if (!isSafeRegularFile(opened) || !isSafeRegularFile(pathAfterOpen) || !sameFileIdentity(opened, pathAfterOpen)) {
      throw new PathSafetyError('PROJECT_PATH_UNSAFE', `打开的模板文件不是安全的普通文件：${relativePath}`);
    }
    const bytes = await handle.readFile();
    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw new InvalidUtf8Error(relativePath, error);
    }
    const finalStats = await handle.stat();
    const pathAfterRead = await lstat(templatePath);
    if (
      !isSafeRegularFile(finalStats) ||
      !isSafeRegularFile(pathAfterRead) ||
      !sameFileIdentity(finalStats, pathAfterRead)
    ) {
      throw new PathSafetyError('PROJECT_PATH_UNSAFE', `模板文件句柄状态不安全：${relativePath}`);
    }
    return source;
  } finally {
    await handle?.close();
  }
}

function errorResult(
  status: 'missing' | 'invalid',
  error: WritingBlockTemplateScanError,
  files: WritingBlockTemplateScanFile[] = [],
): WritingBlockTemplateScanResult {
  return {
    status,
    directory: WRITING_BLOCK_TEMPLATE_DIRECTORY,
    version: WRITING_BLOCK_TEMPLATE_VERSION,
    files,
    error,
  };
}

function failure(
  code: string,
  message: string,
  path: string,
  manifestPath: string,
  actualVersion?: unknown,
  expectedVersion: number = WRITING_BLOCK_TEMPLATE_VERSION,
): WritingBlockTemplateScanError {
  return {
    code,
    message,
    path,
    manifestPath,
    expectedVersion,
    ...(actualVersion === undefined ? {} : { actualVersion }),
  };
}

export class WritingBlockTemplateValidationError extends Error {
  readonly code = 'WRITING_BLOCK_TEMPLATE_VALIDATION_FAILED';
  readonly details: WritingBlockTemplateScanResult;

  constructor(result: WritingBlockTemplateScanResult) {
    super(
      result.error?.message ??
        `Writing Block 模板校验失败：目录=${result.directory}，manifest=${result.error?.manifestPath ?? '未知'}。`,
    );
    this.name = 'WritingBlockTemplateValidationError';
    this.details = result;
  }
}

interface TemplateSchema {
  type?: string;
  const?: unknown;
  enum?: readonly unknown[];
  items?: TemplateSchema;
  oneOf?: readonly TemplateSchema[];
  required?: readonly string[];
  properties?: Readonly<Record<string, TemplateSchema>>;
}

function matchesTemplateSchema(value: unknown, schema: TemplateSchema): boolean {
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum !== undefined && !schema.enum.includes(value)) return false;
  if (schema.oneOf !== undefined && !schema.oneOf.some((candidate) => matchesTemplateSchema(value, candidate))) {
    return false;
  }
  if (schema.type === undefined) return true;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'array') {
    return (
      Array.isArray(value) &&
      (schema.items === undefined || value.every((item) => matchesTemplateSchema(item, schema.items!)))
    );
  }
  if (schema.type === 'object') {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  if (schema.type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (schema.type === 'string') return typeof value === 'string' && value.trim().length > 0;
  if (schema.type === 'boolean') return typeof value === 'boolean';
  return false;
}

function expectedTemplateSchema(schema: TemplateSchema): string {
  if (schema.oneOf !== undefined) return schema.oneOf.map(expectedTemplateSchema).join(' 或 ');
  if (schema.type === 'array') return schema.items ? `array<${expectedTemplateSchema(schema.items)}>` : 'array';
  return schema.type ?? 'JSON value';
}

function structureFailure(
  type: WritingBlockType,
  path: string,
  manifestPath: string,
  field: string,
  message: string,
): WritingBlockTemplateScanError {
  return failure(
    'WRITING_BLOCK_TEMPLATE_INVALID_STRUCTURE',
    `模板文件 ${path}（type=${type}）字段 ${field} ${message}，已停止读取。`,
    path,
    manifestPath,
  );
}

function standardTemplateStructureError(
  type: Exclude<WritingBlockType, 'GOVERNANCE_RECONCILIATION'>,
  value: Record<string, unknown>,
  path: string,
  manifestPath: string,
): WritingBlockTemplateScanError | null {
  const schema = WRITING_BLOCK_JSON_SCHEMAS[type] as unknown as TemplateSchema;
  const requiredFields = [
    'schema_version',
    ...(schema.required ?? []),
    ...(type === 'LUNA_TASK' ? ['execution_semantics'] : []),
  ];
  for (const field of requiredFields) {
    if (!(field in value) || value[field] === undefined) {
      return structureFailure(type, path, manifestPath, field, '缺失');
    }
  }
  for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
    if (value[field] !== undefined && !matchesTemplateSchema(value[field], fieldSchema)) {
      return structureFailure(
        type,
        path,
        manifestPath,
        field,
        `类型或结构错误，期望 ${expectedTemplateSchema(fieldSchema)}`,
      );
    }
  }
  return null;
}

function reconciliationVariantStructureError(
  variant: string,
  value: unknown,
  path: string,
  manifestPath: string,
): WritingBlockTemplateScanError | null {
  if (!isRecord(value)) {
    return structureFailure('GOVERNANCE_RECONCILIATION', path, manifestPath, `variants.${variant}`, '必须是 JSON 对象');
  }
  const schema = WRITING_BLOCK_JSON_SCHEMAS.GOVERNANCE_RECONCILIATION as unknown as TemplateSchema;
  for (const field of ['schema_version', 'status']) {
    if (!(field in value) || value[field] === undefined) {
      return structureFailure('GOVERNANCE_RECONCILIATION', path, manifestPath, `variants.${variant}.${field}`, '缺失');
    }
  }
  if (value.status !== variant) {
    return structureFailure(
      'GOVERNANCE_RECONCILIATION',
      path,
      manifestPath,
      `variants.${variant}.status`,
      `必须等于 ${variant}`,
    );
  }
  for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
    if (value[field] !== undefined && !matchesTemplateSchema(value[field], fieldSchema)) {
      return structureFailure(
        'GOVERNANCE_RECONCILIATION',
        path,
        manifestPath,
        `variants.${variant}.${field}`,
        `类型或结构错误，期望 ${expectedTemplateSchema(fieldSchema)}`,
      );
    }
  }
  if (variant === 'CHANGES_REQUIRED') {
    if (typeof value.baseline_commit !== 'string' || value.baseline_commit.trim() === '') {
      return structureFailure(
        'GOVERNANCE_RECONCILIATION',
        path,
        manifestPath,
        'variants.CHANGES_REQUIRED.baseline_commit',
        '必须是非空字符串',
      );
    }
    if (!Array.isArray(value.files) || value.files.length === 0) {
      return structureFailure(
        'GOVERNANCE_RECONCILIATION',
        path,
        manifestPath,
        'variants.CHANGES_REQUIRED.files',
        '必须是非空数组',
      );
    }
    const fileSchema = (schema.properties?.files?.items ?? {}) as TemplateSchema;
    for (const [index, file] of value.files.entries()) {
      if (!matchesTemplateSchema(file, fileSchema)) {
        return structureFailure(
          'GOVERNANCE_RECONCILIATION',
          path,
          manifestPath,
          `variants.CHANGES_REQUIRED.files[${index}]`,
          '必须是完整 JSON 对象，且字段类型符合协议',
        );
      }
      const fileRecord = file as Record<string, unknown>;
      for (const field of schema.properties?.files?.items?.required ?? []) {
        if (!(field in fileRecord) || fileRecord[field] === undefined) {
          return structureFailure(
            'GOVERNANCE_RECONCILIATION',
            path,
            manifestPath,
            `variants.CHANGES_REQUIRED.files[${index}].${field}`,
            '缺失',
          );
        }
      }
      for (const [field, fieldSchema] of Object.entries(schema.properties?.files?.items?.properties ?? {})) {
        if (fileRecord[field] !== undefined && !matchesTemplateSchema(fileRecord[field], fieldSchema)) {
          return structureFailure(
            'GOVERNANCE_RECONCILIATION',
            path,
            manifestPath,
            `variants.CHANGES_REQUIRED.files[${index}].${field}`,
            `类型或结构错误，期望 ${expectedTemplateSchema(fieldSchema)}`,
          );
        }
      }
    }
  } else {
    if (value.files !== undefined && (!Array.isArray(value.files) || value.files.length !== 0)) {
      return structureFailure(
        'GOVERNANCE_RECONCILIATION',
        path,
        manifestPath,
        `variants.${variant}.files`,
        '必须省略或保持为空数组',
      );
    }
    if (variant === 'BLOCKED' && (typeof value.reason !== 'string' || value.reason.trim() === '')) {
      return structureFailure(
        'GOVERNANCE_RECONCILIATION',
        path,
        manifestPath,
        'variants.BLOCKED.reason',
        '缺失或不是非空字符串',
      );
    }
  }
  return null;
}

function reconciliationTemplateStructureError(
  value: Record<string, unknown>,
  path: string,
  manifestPath: string,
): WritingBlockTemplateScanError | null {
  if (value.template_kind !== 'GOVERNANCE_RECONCILIATION') {
    return structureFailure(
      'GOVERNANCE_RECONCILIATION',
      path,
      manifestPath,
      'template_kind',
      '必须是 GOVERNANCE_RECONCILIATION',
    );
  }
  if (!Array.isArray(value.instructions) || value.instructions.some((item) => typeof item !== 'string')) {
    return structureFailure('GOVERNANCE_RECONCILIATION', path, manifestPath, 'instructions', '必须是字符串数组');
  }
  if (!isRecord(value.variants)) {
    return structureFailure('GOVERNANCE_RECONCILIATION', path, manifestPath, 'variants', '必须是 JSON 对象');
  }
  const variants = value.variants;
  for (const variant of ['PASS', 'CHANGES_REQUIRED', 'BLOCKED']) {
    if (!(variant in variants)) {
      return structureFailure('GOVERNANCE_RECONCILIATION', path, manifestPath, `variants.${variant}`, '缺失');
    }
    const error = reconciliationVariantStructureError(variant, variants[variant], path, manifestPath);
    if (error !== null) return error;
  }
  return null;
}

function manifestRegistrationError(
  projectRoot: string,
  type: WritingBlockType,
  manifest: GovernanceManifest | null,
  manifestPath: string,
): WritingBlockTemplateScanError | null {
  const path = WRITING_BLOCK_TEMPLATE_PATHS[type];
  const expectedId = `writing-block-template-${type.toLowerCase().replaceAll('_', '-')}`;
  const expectedPath = normalizedManifestPath(projectRoot, path) ?? path;
  const registrations =
    manifest?.documents.filter((candidate) => normalizedManifestPath(projectRoot, candidate.path) === expectedPath) ??
    [];
  if (registrations.length > 1) {
    return failure(
      'WRITING_BLOCK_TEMPLATE_DUPLICATE_REGISTRATION',
      `模板文件 ${path}（type=${type}）在 manifest ${manifestPath} 中有 ${registrations.length} 条规范化后相同 path 登记；固定模板 path 只能有一条匹配的 active writing-block-template 记录。`,
      path,
      manifestPath,
    );
  }
  const document = registrations[0];
  const matches =
    document !== undefined &&
    document.id === expectedId &&
    document.type === WRITING_BLOCK_TEMPLATE_DOCUMENT_TYPE &&
    document.status === 'active' &&
    document.version === WRITING_BLOCK_TEMPLATE_VERSION &&
    document.audience.length === WRITING_BLOCK_TEMPLATE_AUDIENCE.length &&
    document.audience.every((audience, index) => audience === WRITING_BLOCK_TEMPLATE_AUDIENCE[index]);
  if (matches) return null;
  return failure(
    'WRITING_BLOCK_TEMPLATE_NOT_REGISTERED',
    `模板 ${path} 未在 manifest ${manifestPath} 中以 path=${path}、type=${WRITING_BLOCK_TEMPLATE_DOCUMENT_TYPE}、audience=[Sol,Codex]、status=active 和 version=${WRITING_BLOCK_TEMPLATE_VERSION} 正确登记。`,
    path,
    manifestPath,
    document?.version,
  );
}

async function inspectTemplateDirectory(
  projectRoot: string,
  manifestPath: string,
): Promise<WritingBlockTemplateScanError | null> {
  const directoryPath = fixedPath(projectRoot, WRITING_BLOCK_TEMPLATE_DIRECTORY);
  try {
    await assertSafeProjectPath(projectRoot, directoryPath);
    const directoryStats = await lstat(directoryPath);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      return failure(
        'WRITING_BLOCK_TEMPLATE_PATH_UNSAFE',
        `Writing Block 模板目录 ${WRITING_BLOCK_TEMPLATE_DIRECTORY} 不是安全目录，已停止读取。`,
        WRITING_BLOCK_TEMPLATE_DIRECTORY,
        manifestPath,
      );
    }
    return null;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return failure(
        'WRITING_BLOCK_TEMPLATE_MISSING',
        `缺少 Writing Block 模板目录 ${WRITING_BLOCK_TEMPLATE_DIRECTORY}，已停止生成 Sol 提示词。`,
        WRITING_BLOCK_TEMPLATE_DIRECTORY,
        manifestPath,
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    return failure(
      error instanceof PathSafetyError && error.code === 'PATH_OUTSIDE_PROJECT'
        ? 'WRITING_BLOCK_TEMPLATE_PATH_OUTSIDE_PROJECT'
        : 'WRITING_BLOCK_TEMPLATE_PATH_UNSAFE',
      `Writing Block 模板目录 ${WRITING_BLOCK_TEMPLATE_DIRECTORY} 路径不安全，已停止读取：${detail}`,
      WRITING_BLOCK_TEMPLATE_DIRECTORY,
      manifestPath,
    );
  }
}

async function inspectTemplateFile(
  projectRoot: string,
  type: WritingBlockType,
  manifest: GovernanceManifest | null,
  manifestPath: string,
): Promise<{ file: WritingBlockTemplateScanFile; error: WritingBlockTemplateScanError | null }> {
  const path = WRITING_BLOCK_TEMPLATE_PATHS[type];
  const fileName = WRITING_BLOCK_TEMPLATE_FILENAMES[type];
  const file: WritingBlockTemplateScanFile = { type, fileName, path };
  let source: string;
  try {
    source = await readSafeTemplateFile(projectRoot, path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return {
        file,
        error: failure(
          'WRITING_BLOCK_TEMPLATE_MISSING',
          `缺少模板文件 ${path}，已停止生成 Sol 提示词。`,
          path,
          manifestPath,
        ),
      };
    }
    if (error instanceof InvalidUtf8Error) {
      return {
        file,
        error: failure(error.code, `${error.message}；必须返回 BLOCKED。`, path, manifestPath),
      };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      file,
      error: failure(
        error instanceof PathSafetyError && error.code === 'PATH_OUTSIDE_PROJECT'
          ? 'WRITING_BLOCK_TEMPLATE_PATH_OUTSIDE_PROJECT'
          : 'WRITING_BLOCK_TEMPLATE_PATH_UNSAFE',
        `模板文件 ${path} 路径不安全，已停止读取：${detail}`,
        path,
        manifestPath,
      ),
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      file,
      error: failure(
        'WRITING_BLOCK_TEMPLATE_INVALID_JSON',
        `模板文件 ${path} 不是合法 JSON：${detail}`,
        path,
        manifestPath,
      ),
    };
  }
  if (!isRecord(value)) {
    return {
      file,
      error: failure(
        'WRITING_BLOCK_TEMPLATE_NOT_OBJECT',
        `模板文件 ${path} 必须是 JSON 对象，不能是数组、字符串或 null。`,
        path,
        manifestPath,
      ),
    };
  }
  if (hasReservedClosingMarker(value)) {
    return {
      file,
      error: failure(
        'WRITING_BLOCK_TEMPLATE_RESERVED_MARKER',
        `模板文件 ${path} 包含保留结束标记 ${WRITING_BLOCK_CLOSE_MARKER}，已停止读取。`,
        path,
        manifestPath,
      ),
    };
  }
  const schemaVersion = value.schema_version;
  if (
    typeof schemaVersion !== 'number' ||
    !Number.isInteger(schemaVersion) ||
    !(SUPPORTED_WRITING_BLOCK_TEMPLATE_VERSIONS as readonly unknown[]).includes(schemaVersion)
  ) {
    return {
      file,
      error: failure(
        'WRITING_BLOCK_TEMPLATE_UNSUPPORTED_VERSION',
        `模板文件 ${path} 的 schema_version=${String(schemaVersion)} 不受支持；软件支持版本为 ${SUPPORTED_WRITING_BLOCK_TEMPLATE_VERSIONS.join(',')}。`,
        path,
        manifestPath,
        schemaVersion,
      ),
    };
  }
  file.schemaVersion = schemaVersion;

  const structureError =
    type === 'GOVERNANCE_RECONCILIATION'
      ? reconciliationTemplateStructureError(value, path, manifestPath)
      : standardTemplateStructureError(type, value, path, manifestPath);
  if (structureError !== null) return { file, error: structureError };

  const registrationError = manifestRegistrationError(projectRoot, type, manifest, manifestPath);
  return { file, error: registrationError };
}

function manifestVersionError(
  manifest: GovernanceManifest,
  manifestPath: string,
): WritingBlockTemplateScanError | null {
  if (manifest.template_version === SUPPORTED_MANIFEST_TEMPLATE_VERSION) return null;
  return failure(
    'WRITING_BLOCK_TEMPLATE_UNSUPPORTED_VERSION',
    `治理 manifest ${manifestPath} 的 template_version=${String(manifest.template_version)} 不受支持；软件要求版本为 ${SUPPORTED_MANIFEST_TEMPLATE_VERSION}。`,
    WRITING_BLOCK_TEMPLATE_DIRECTORY,
    manifestPath,
    manifest.template_version,
    SUPPORTED_MANIFEST_TEMPLATE_VERSION,
  );
}

export async function scanWritingBlockTemplates(
  projectRoot: string,
  manifest: GovernanceManifest | null,
  manifestPath = 'docs/governance/governance-manifest.yaml',
): Promise<WritingBlockTemplateScanResult> {
  if (manifest === null) {
    return errorResult(
      'missing',
      failure(
        'WRITING_BLOCK_TEMPLATE_MANIFEST_MISSING',
        `缺少治理 manifest ${manifestPath}，无法验证五个固定 Writing Block 模板的登记状态。`,
        WRITING_BLOCK_TEMPLATE_DIRECTORY,
        manifestPath,
      ),
    );
  }
  if (manifest !== null) {
    const versionError = manifestVersionError(manifest, manifestPath);
    if (versionError !== null) return errorResult('invalid', versionError);
  }
  const directoryError = await inspectTemplateDirectory(projectRoot, manifestPath);
  if (directoryError !== null) {
    return errorResult(
      directoryError.code === 'WRITING_BLOCK_TEMPLATE_MISSING' ? 'missing' : 'invalid',
      directoryError,
    );
  }

  if (manifest !== null) {
    for (const type of TEMPLATE_TYPES) {
      const path = WRITING_BLOCK_TEMPLATE_PATHS[type];
      const expectedPath = normalizedManifestPath(projectRoot, path) ?? path;
      const registrations = manifest.documents.filter(
        (document) => normalizedManifestPath(projectRoot, document.path) === expectedPath,
      );
      if (registrations.length > 1) {
        const duplicateError = failure(
          'WRITING_BLOCK_TEMPLATE_DUPLICATE_REGISTRATION',
          `模板文件 ${path}（type=${type}）在 manifest ${manifestPath} 中有 ${registrations.length} 条相同 path 登记；固定模板 path 只能有一条匹配的 active writing-block-template 记录。`,
          path,
          manifestPath,
        );
        return errorResult('invalid', duplicateError);
      }
    }
  }

  const files: WritingBlockTemplateScanFile[] = [];
  for (const type of TEMPLATE_TYPES) {
    const inspected = await inspectTemplateFile(projectRoot, type, manifest, manifestPath);
    files.push(inspected.file);
    if (inspected.error !== null) {
      const missing = inspected.error.code === 'WRITING_BLOCK_TEMPLATE_MISSING';
      return errorResult(missing ? 'missing' : 'invalid', inspected.error, files);
    }
  }
  return {
    status: 'valid',
    directory: WRITING_BLOCK_TEMPLATE_DIRECTORY,
    version: WRITING_BLOCK_TEMPLATE_VERSION,
    files,
  };
}

export async function assertWritingBlockTemplatesValid(
  projectRoot: string,
  manifest: GovernanceManifest | null,
  manifestPath = 'docs/governance/governance-manifest.yaml',
): Promise<WritingBlockTemplateScanResult> {
  const result = await scanWritingBlockTemplates(projectRoot, manifest, manifestPath);
  if (result.status !== 'valid') throw new WritingBlockTemplateValidationError(result);
  return result;
}
