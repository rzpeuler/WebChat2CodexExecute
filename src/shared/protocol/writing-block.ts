import { parse as parseYaml } from 'yaml';

export const WRITING_BLOCK_SCHEMA_VERSION = 1 as const;
export const USER_MESSAGE_OPEN_MARKER = '[USER_MESSAGE]';
export const USER_MESSAGE_CLOSE_MARKER = '[/USER_MESSAGE]';

export const WRITING_BLOCK_TYPES = [
  'LUNA_TASK',
  'GOVERNANCE_CHANGE',
  'GOVERNANCE_RECONCILIATION',
  'ARCHITECTURE_FREEZE',
  'BLOCKED',
] as const;
export type WritingBlockType = (typeof WRITING_BLOCK_TYPES)[number];

export function extractUserMessage(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith(USER_MESSAGE_OPEN_MARKER) || !trimmed.endsWith(USER_MESSAGE_CLOSE_MARKER)) return null;
  const message = trimmed.slice(USER_MESSAGE_OPEN_MARKER.length, -USER_MESSAGE_CLOSE_MARKER.length).trim();
  if (message === '' || message.includes(USER_MESSAGE_OPEN_MARKER) || message.includes(USER_MESSAGE_CLOSE_MARKER))
    return null;
  return message;
}

export const GOVERNANCE_RECONCILIATION_STATUSES = ['PASS', 'CHANGES_REQUIRED', 'BLOCKED'] as const;
export type GovernanceReconciliationStatus = (typeof GOVERNANCE_RECONCILIATION_STATUSES)[number];

export const GOVERNANCE_RECONCILIATION_ACTIONS = ['replace'] as const;
export type GovernanceReconciliationAction = (typeof GOVERNANCE_RECONCILIATION_ACTIONS)[number];

export const LUNA_TASK_REQUIRED_FIELDS = [
  'task_id',
  'title',
  'objective',
  'base_commit',
  'scope',
  'out_of_scope',
  'deliverables',
  'validation_commands',
  'governance_revision',
  'architecture_revision_set',
  'report_path',
  'remote_sync_policy',
] as const;

export const GOVERNANCE_CHANGE_REQUIRED_FIELDS = [
  'change_id',
  'operation',
  'document_id',
  'path',
  'reason',
  'risk_level',
  'affected_agents',
  'content',
] as const;

export const GOVERNANCE_RECONCILIATION_REQUIRED_FIELDS = ['schema_version', 'status'] as const;

export const GOVERNANCE_RECONCILIATION_FILE_REQUIRED_FIELDS = [
  'path',
  'action',
  'reason',
  'sha256_before',
  'content',
] as const;

export const ARCHITECTURE_FREEZE_REQUIRED_FIELDS = [
  'freeze_id',
  'version',
  'download_url',
  'sha256_if_known',
  'reason',
  'affected_scope',
  'luna_follow_up',
] as const;

export const BLOCKED_REQUIRED_FIELDS = ['code', 'reason'] as const;

export const DEFAULT_LUNA_IMPLEMENTATION_SEMANTICS =
  'Luna may decide implementation details inside the approved scope without asking Sol or the user; emit BLOCKED only for external account/API key/OTP/platform configuration, conflicts, unauthorized scope, or high-risk operations.' as const;

export interface LunaTaskFields {
  schema_version?: typeof WRITING_BLOCK_SCHEMA_VERSION;
  task_id: string;
  title: string;
  objective: string;
  base_commit: string;
  scope: string[];
  out_of_scope: string[];
  deliverables: string[];
  validation_commands: string[];
  governance_revision: string | number;
  architecture_revision_set: unknown[];
  report_path: string;
  remote_sync_policy: unknown;
  execution_semantics: typeof DEFAULT_LUNA_IMPLEMENTATION_SEMANTICS;
  [key: string]: unknown;
}

export interface GovernanceChangeFields {
  schema_version?: typeof WRITING_BLOCK_SCHEMA_VERSION;
  change_id: string;
  operation: string;
  document_id: string;
  path: string;
  reason: string;
  risk_level: string;
  affected_agents: string[];
  content: string;
  [key: string]: unknown;
}

export interface GovernanceReconciliationFile {
  path: string;
  action: GovernanceReconciliationAction;
  reason: string;
  sha256_before: string;
  content: string;
  [key: string]: unknown;
}

export interface GovernanceReconciliationFields {
  schema_version: typeof WRITING_BLOCK_SCHEMA_VERSION;
  status: GovernanceReconciliationStatus;
  baseline_commit?: string;
  files?: GovernanceReconciliationFile[];
  reason?: string;
  [key: string]: unknown;
}

export interface ArchitectureFreezeFields {
  schema_version?: typeof WRITING_BLOCK_SCHEMA_VERSION;
  freeze_id: string;
  version: string | number;
  download_url: string;
  sha256_if_known: string | null;
  reason: string;
  affected_scope: string[];
  luna_follow_up: string;
  [key: string]: unknown;
}

export interface BlockedFields {
  schema_version?: typeof WRITING_BLOCK_SCHEMA_VERSION;
  code: string;
  reason: string;
  [key: string]: unknown;
}

export interface WritingBlockBase<T extends WritingBlockType, F extends Record<string, unknown>> {
  type: T;
  fields: F;
  extensions: Record<string, unknown>;
  rawBody: string;
}

export type LunaTaskBlock = WritingBlockBase<'LUNA_TASK', LunaTaskFields>;
export type GovernanceChangeBlock = WritingBlockBase<'GOVERNANCE_CHANGE', GovernanceChangeFields>;
export type GovernanceReconciliationBlock = WritingBlockBase<
  'GOVERNANCE_RECONCILIATION',
  GovernanceReconciliationFields
>;
export type ArchitectureFreezeBlock = WritingBlockBase<'ARCHITECTURE_FREEZE', ArchitectureFreezeFields>;
export type BlockedBlock = WritingBlockBase<'BLOCKED', BlockedFields>;
export type WritingBlock =
  LunaTaskBlock | GovernanceChangeBlock | GovernanceReconciliationBlock | ArchitectureFreezeBlock | BlockedBlock;

export interface ParsedWritingBlocks {
  blocks: WritingBlock[];
  lunaTask: LunaTaskBlock | null;
  governanceChanges: GovernanceChangeBlock[];
  governanceReconciliation: GovernanceReconciliationBlock | null;
  architectureFreezes: ArchitectureFreezeBlock[];
  blocked: BlockedBlock[];
}

export type WritingBlockProtocolErrorCode =
  | 'WRITING_BLOCK_INPUT_INVALID'
  | 'WRITING_BLOCK_OUT_OF_BLOCK_CONTENT'
  | 'WRITING_BLOCK_HEADER_INVALID'
  | 'WRITING_BLOCK_UNCLOSED'
  | 'WRITING_BLOCK_NESTED'
  | 'WRITING_BLOCK_UNKNOWN_TYPE'
  | 'WRITING_BLOCK_BODY_INVALID_JSON'
  | 'WRITING_BLOCK_BODY_INVALID_YAML'
  | 'WRITING_BLOCK_BODY_NOT_OBJECT'
  | 'WRITING_BLOCK_UNSUPPORTED_VERSION'
  | 'WRITING_BLOCK_MISSING_FIELD'
  | 'WRITING_BLOCK_INVALID_FIELD'
  | 'WRITING_BLOCK_RESERVED_MARKER'
  | 'WRITING_BLOCK_DUPLICATE_LUNA_TASK'
  | 'WRITING_BLOCK_DUPLICATE_GOVERNANCE_RECONCILIATION';

export class WritingBlockProtocolError extends Error {
  readonly code: WritingBlockProtocolErrorCode;
  readonly blockIndex: number | null;
  readonly blockType: WritingBlockType | null;
  readonly field: string | null;

  constructor(
    code: WritingBlockProtocolErrorCode,
    message: string,
    options: { blockIndex?: number; blockType?: WritingBlockType; field?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WritingBlockProtocolError';
    this.code = code;
    this.blockIndex = options.blockIndex ?? null;
    this.blockType = options.blockType ?? null;
    this.field = options.field ?? null;
  }
}

export const WRITING_BLOCK_JSON_SCHEMAS = {
  LUNA_TASK: {
    type: 'object',
    additionalProperties: true,
    required: [...LUNA_TASK_REQUIRED_FIELDS],
    properties: {
      schema_version: { type: 'integer', const: WRITING_BLOCK_SCHEMA_VERSION },
      task_id: { type: 'string' },
      title: { type: 'string' },
      objective: { type: 'string' },
      base_commit: { type: 'string' },
      scope: { type: 'array', items: { type: 'string' } },
      out_of_scope: { type: 'array', items: { type: 'string' } },
      deliverables: { type: 'array', items: { type: 'string' } },
      validation_commands: { type: 'array', items: { type: 'string' } },
      governance_revision: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      architecture_revision_set: { type: 'array', items: {} },
      report_path: { type: 'string' },
      remote_sync_policy: {
        oneOf: [{ type: 'object' }, { type: 'string' }, { type: 'boolean' }],
      },
      execution_semantics: { type: 'string', const: DEFAULT_LUNA_IMPLEMENTATION_SEMANTICS },
    },
  },
  GOVERNANCE_CHANGE: {
    type: 'object',
    additionalProperties: true,
    required: [...GOVERNANCE_CHANGE_REQUIRED_FIELDS],
    properties: {
      schema_version: { type: 'integer', const: WRITING_BLOCK_SCHEMA_VERSION },
      change_id: { type: 'string' },
      operation: { type: 'string' },
      document_id: { type: 'string' },
      path: { type: 'string' },
      reason: { type: 'string' },
      risk_level: { type: 'string' },
      affected_agents: { type: 'array', items: { type: 'string' } },
      content: { type: 'string' },
    },
  },
  GOVERNANCE_RECONCILIATION: {
    type: 'object',
    additionalProperties: true,
    required: [...GOVERNANCE_RECONCILIATION_REQUIRED_FIELDS],
    properties: {
      schema_version: { type: 'integer', const: WRITING_BLOCK_SCHEMA_VERSION },
      status: { type: 'string', enum: [...GOVERNANCE_RECONCILIATION_STATUSES] },
      baseline_commit: { type: 'string' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          required: [...GOVERNANCE_RECONCILIATION_FILE_REQUIRED_FIELDS],
          additionalProperties: true,
          properties: {
            path: { type: 'string' },
            action: { type: 'string', enum: [...GOVERNANCE_RECONCILIATION_ACTIONS] },
            reason: { type: 'string' },
            sha256_before: { type: 'string' },
            content: { type: 'string' },
          },
        },
      },
      reason: { type: 'string' },
    },
  },
  ARCHITECTURE_FREEZE: {
    type: 'object',
    additionalProperties: true,
    required: [...ARCHITECTURE_FREEZE_REQUIRED_FIELDS],
    properties: {
      schema_version: { type: 'integer', const: WRITING_BLOCK_SCHEMA_VERSION },
      freeze_id: { type: 'string' },
      version: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      download_url: { type: 'string' },
      sha256_if_known: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      reason: { type: 'string' },
      affected_scope: { type: 'array', items: { type: 'string' } },
      luna_follow_up: { type: 'string' },
    },
  },
  BLOCKED: {
    type: 'object',
    additionalProperties: true,
    required: [...BLOCKED_REQUIRED_FIELDS],
    properties: {
      schema_version: { type: 'integer', const: WRITING_BLOCK_SCHEMA_VERSION },
      code: { type: 'string' },
      reason: { type: 'string' },
    },
  },
} as const;

const OPEN_MARKER = '[WRITING_BLOCK';
const CLOSE_MARKER = '[/WRITING_BLOCK]';
const ANGLE_OPEN_MARKER_PATTERN = /<WRITING_BLOCK\s+type="([^"]+)">/g;
const ANGLE_CLOSE_MARKER_PATTERN = /<\/WRITING_BLOCK>/g;

/** Normalize the XML-shaped wrapper observed in ChatGPT DOM output. */
export function normalizeWritingBlockMarkers(input: string): string {
  return input
    .replace(ANGLE_OPEN_MARKER_PATTERN, '[WRITING_BLOCK type="$1"]')
    .replace(ANGLE_CLOSE_MARKER_PATTERN, CLOSE_MARKER);
}

function decodeUnicodeEscapes(value: string): string {
  return value.replace(/\\u([0-9a-f]{4})/gi, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasReservedClosingMarker(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === 'string') return decodeUnicodeEscapes(value).includes(CLOSE_MARKER);
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasReservedClosingMarker(item, seen));
  return Object.entries(value).some(
    ([key, child]) => decodeUnicodeEscapes(key).includes(CLOSE_MARKER) || hasReservedClosingMarker(child, seen),
  );
}

function assertNoReservedClosingMarker(fields: Record<string, unknown>, blockIndex: number): void {
  if (hasReservedClosingMarker(fields)) {
    throw new WritingBlockProtocolError('WRITING_BLOCK_RESERVED_MARKER', `正文包含保留结束标记 ${CLOSE_MARKER}`, {
      blockIndex,
    });
  }
}

function jsonParsePosition(error: unknown): string {
  if (!(error instanceof Error)) return '';
  const position = /(?:position|column)\s+(\d+)/i.exec(error.message)?.[1];
  return position === undefined ? '' : `解析位置：${position}。`;
}

function isJsonObjectCandidate(value: string): boolean {
  return value.startsWith('{');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

type JsonSchemaProperty = {
  readonly type?: string;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly items?: JsonSchemaProperty;
  readonly oneOf?: readonly JsonSchemaProperty[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
  readonly additionalProperties?: boolean;
};

function matchesJsonSchemaProperty(value: unknown, schema: JsonSchemaProperty): boolean {
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum !== undefined && !schema.enum.includes(value)) return false;
  if (schema.oneOf !== undefined) return schema.oneOf.some((candidate) => matchesJsonSchemaProperty(value, candidate));
  if (schema.type === undefined) return true;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'array') {
    return (
      Array.isArray(value) &&
      (schema.items === undefined || value.every((item) => matchesJsonSchemaProperty(item, schema.items!)))
    );
  }
  if (schema.type === 'object') {
    if (!isRecord(value)) return false;
    if (schema.required?.some((field) => !(field in value) || value[field] === undefined)) return false;
    if (
      schema.properties !== undefined &&
      Object.entries(schema.properties).some(
        ([field, property]) => value[field] !== undefined && !matchesJsonSchemaProperty(value[field], property),
      )
    )
      return false;
    return true;
  }
  if (schema.type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (schema.type === 'string') return isNonEmptyString(value);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  return false;
}

function assertSchemaContract(type: WritingBlockType, fields: Record<string, unknown>, blockIndex: number): void {
  const schema = WRITING_BLOCK_JSON_SCHEMAS[type];
  for (const field of schema.required) assertFieldPresent(fields, field, blockIndex);
  for (const [field, property] of Object.entries(schema.properties) as Array<[string, JsonSchemaProperty]>) {
    if (fields[field] !== undefined && !matchesJsonSchemaProperty(fields[field], property)) {
      throw new WritingBlockProtocolError(
        'WRITING_BLOCK_INVALID_FIELD',
        `${field} does not match the writing block schema for ${type}`,
        { blockIndex, field },
      );
    }
  }
}

function assertFieldPresent(fields: Record<string, unknown>, field: string, blockIndex: number): void {
  if (!(field in fields) || fields[field] === undefined) {
    throw new WritingBlockProtocolError(
      'WRITING_BLOCK_MISSING_FIELD',
      `${field} is required for writing block ${blockIndex}`,
      { blockIndex, field },
    );
  }
}

function assertStringField(fields: Record<string, unknown>, field: string, blockIndex: number): string {
  assertFieldPresent(fields, field, blockIndex);
  if (!isNonEmptyString(fields[field])) {
    throw new WritingBlockProtocolError(
      'WRITING_BLOCK_INVALID_FIELD',
      `${field} must be a non-empty string for writing block ${blockIndex}`,
      { blockIndex, field },
    );
  }
  return fields[field];
}

function assertStringListField(fields: Record<string, unknown>, field: string, blockIndex: number): string[] {
  assertFieldPresent(fields, field, blockIndex);
  const value = fields[field];
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
    throw new WritingBlockProtocolError(
      'WRITING_BLOCK_INVALID_FIELD',
      `${field} must be a list of non-empty strings for writing block ${blockIndex}`,
      { blockIndex, field },
    );
  }
  return [...value];
}

function assertReconciliationPath(value: unknown, blockIndex: number, fileIndex: number): string {
  if (!isNonEmptyString(value)) {
    throw new WritingBlockProtocolError(
      'WRITING_BLOCK_INVALID_FIELD',
      `files[${fileIndex}].path must be a non-empty project-relative path`,
      { blockIndex, field: `files[${fileIndex}].path` },
    );
  }
  const path = value.trim();
  const segments = path.split('/');
  if (
    path !== value ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[a-zA-Z]:/.test(path) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new WritingBlockProtocolError(
      'WRITING_BLOCK_INVALID_FIELD',
      `files[${fileIndex}].path must be a normalized project-relative path`,
      { blockIndex, field: `files[${fileIndex}].path` },
    );
  }
  return path;
}

function normalizeReconciliationFiles(value: unknown, blockIndex: number): GovernanceReconciliationFile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new WritingBlockProtocolError(
      'WRITING_BLOCK_INVALID_FIELD',
      'files must be a non-empty list when status is CHANGES_REQUIRED',
      { blockIndex, field: 'files' },
    );
  }
  const seenPaths = new Set<string>();
  return value.map((item, fileIndex) => {
    if (!isRecord(item)) {
      throw new WritingBlockProtocolError('WRITING_BLOCK_INVALID_FIELD', `files[${fileIndex}] must be an object`, {
        blockIndex,
        field: `files[${fileIndex}]`,
      });
    }
    for (const field of GOVERNANCE_RECONCILIATION_FILE_REQUIRED_FIELDS) {
      if (!(field in item) || item[field] === undefined) {
        throw new WritingBlockProtocolError('WRITING_BLOCK_MISSING_FIELD', `files[${fileIndex}].${field} is required`, {
          blockIndex,
          field: `files[${fileIndex}].${field}`,
        });
      }
    }
    const path = assertReconciliationPath(item.path, blockIndex, fileIndex);
    const key = path.toLowerCase();
    if (seenPaths.has(key)) {
      throw new WritingBlockProtocolError('WRITING_BLOCK_INVALID_FIELD', `files contains a duplicate path: ${path}`, {
        blockIndex,
        field: `files[${fileIndex}].path`,
      });
    }
    seenPaths.add(key);
    if (!(GOVERNANCE_RECONCILIATION_ACTIONS as readonly unknown[]).includes(item.action)) {
      throw new WritingBlockProtocolError('WRITING_BLOCK_INVALID_FIELD', `files[${fileIndex}].action must be replace`, {
        blockIndex,
        field: `files[${fileIndex}].action`,
      });
    }
    if (!isNonEmptyString(item.reason)) {
      throw new WritingBlockProtocolError(
        'WRITING_BLOCK_INVALID_FIELD',
        `files[${fileIndex}].reason must be a non-empty string`,
        { blockIndex, field: `files[${fileIndex}].reason` },
      );
    }
    if (typeof item.sha256_before !== 'string' || !/^[a-fA-F0-9]{64}$/.test(item.sha256_before)) {
      throw new WritingBlockProtocolError(
        'WRITING_BLOCK_INVALID_FIELD',
        `files[${fileIndex}].sha256_before must be a 64-character SHA-256 digest`,
        { blockIndex, field: `files[${fileIndex}].sha256_before` },
      );
    }
    if (!isNonEmptyString(item.content)) {
      throw new WritingBlockProtocolError(
        'WRITING_BLOCK_INVALID_FIELD',
        `files[${fileIndex}].content must contain the complete non-empty file text`,
        { blockIndex, field: `files[${fileIndex}].content` },
      );
    }
    return {
      ...item,
      path,
      action: item.action as GovernanceReconciliationAction,
      reason: item.reason,
      sha256_before: item.sha256_before.toLowerCase(),
      content: item.content,
    };
  });
}

function assertVersion(fields: Record<string, unknown>, blockIndex: number): void {
  if (fields.schema_version !== undefined && fields.schema_version !== WRITING_BLOCK_SCHEMA_VERSION) {
    throw new WritingBlockProtocolError(
      'WRITING_BLOCK_UNSUPPORTED_VERSION',
      `Writing block ${blockIndex} has unsupported schema version: ${String(fields.schema_version)}`,
      { blockIndex, field: 'schema_version' },
    );
  }
}

function escapeRawJsonStringControls(input: string): string {
  let inString = false;
  let escaped = false;
  let changed = false;
  let output = '';
  for (const character of input) {
    if (!inString) {
      output += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      output += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      output += character;
      inString = false;
      continue;
    }
    if (character === '\n') {
      output += '\\n';
      changed = true;
    } else if (character === '\r') {
      output += '\\r';
      changed = true;
    } else if (character === '\t') {
      output += '\\t';
      changed = true;
    } else {
      output += character;
    }
  }
  return changed ? output : input;
}

function parseBody(body: string, blockIndex: number, blockType: WritingBlockType): Record<string, unknown> {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    throw new WritingBlockProtocolError('WRITING_BLOCK_BODY_NOT_OBJECT', '正文为空', {
      blockIndex,
    });
  }

  if (isJsonObjectCandidate(trimmed)) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isRecord(parsed)) {
        throw new WritingBlockProtocolError('WRITING_BLOCK_BODY_NOT_OBJECT', 'JSON 正文必须是对象', { blockIndex });
      }
      assertNoReservedClosingMarker(parsed, blockIndex);
      return parsed;
    } catch (error) {
      if (error instanceof WritingBlockProtocolError) {
        throw error;
      }
      const repaired = escapeRawJsonStringControls(trimmed);
      if (repaired !== trimmed) {
        try {
          const parsed: unknown = JSON.parse(repaired);
          if (isRecord(parsed)) {
            assertNoReservedClosingMarker(parsed, blockIndex);
            return parsed;
          }
        } catch {
          // Fall through to the original strict JSON diagnostic.
        }
      }
      throw new WritingBlockProtocolError(
        'WRITING_BLOCK_BODY_INVALID_JSON',
        `JSON 正文无效。请检查引号、反斜杠、注释、尾逗号和对象括号。${jsonParsePosition(error)}`,
        { blockIndex, blockType, cause: error },
      );
    }
  }

  try {
    const parsed: unknown = parseYaml(trimmed);
    if (!isRecord(parsed)) {
      throw new WritingBlockProtocolError('WRITING_BLOCK_BODY_NOT_OBJECT', 'YAML 正文必须是对象', { blockIndex });
    }
    assertNoReservedClosingMarker(parsed, blockIndex);
    return parsed;
  } catch (error) {
    if (error instanceof WritingBlockProtocolError) {
      throw error;
    }
    throw new WritingBlockProtocolError('WRITING_BLOCK_BODY_INVALID_YAML', 'YAML 正文无效，请检查缩进、冒号和引号。', {
      blockIndex,
      cause: error,
    });
  }
}

function parseHeader(source: string, start: number, blockIndex: number): { type: WritingBlockType; end: number } {
  const end = source.indexOf(']', start);
  const recognizedType = /^\[WRITING_BLOCK type="([^"]+)"/.exec(
    source.slice(start, end < 0 ? undefined : end + 1),
  )?.[1];
  const blockType = (WRITING_BLOCK_TYPES as readonly string[]).includes(recognizedType ?? '')
    ? (recognizedType as WritingBlockType)
    : undefined;
  if (end < 0) {
    throw new WritingBlockProtocolError(
      'WRITING_BLOCK_HEADER_INVALID',
      `第 ${blockIndex} 个 Writing Block 的头部无效。请使用 [WRITING_BLOCK type="..."]。`,
      {
        blockIndex,
        ...(blockType === undefined ? {} : { blockType }),
      },
    );
  }
  const header = source.slice(start, end + 1);
  const match = /^\[WRITING_BLOCK type="([^"]+)"\]$/.exec(header);
  if (match === null) {
    throw new WritingBlockProtocolError(
      'WRITING_BLOCK_HEADER_INVALID',
      `第 ${blockIndex} 个 Writing Block 的头部无效。请使用 [WRITING_BLOCK type="..."]。`,
      {
        blockIndex,
        ...(blockType === undefined ? {} : { blockType }),
      },
    );
  }
  const candidate = match[1] ?? '';
  if (!(WRITING_BLOCK_TYPES as readonly string[]).includes(candidate)) {
    throw new WritingBlockProtocolError(
      'WRITING_BLOCK_UNKNOWN_TYPE',
      `第 ${blockIndex} 个 Writing Block 使用未知类型 ${candidate}。请使用受支持的块类型。`,
      { blockIndex },
    );
  }
  return { type: candidate as WritingBlockType, end: end + 1 };
}

function buildBlock(
  type: WritingBlockType,
  fields: Record<string, unknown>,
  rawBody: string,
  blockIndex: number,
): WritingBlock {
  assertVersion(fields, blockIndex);
  assertSchemaContract(type, fields, blockIndex);
  let normalized: Record<string, unknown>;
  switch (type) {
    case 'LUNA_TASK': {
      const normalizedTask: Record<string, unknown> = { ...fields };
      for (const field of LUNA_TASK_REQUIRED_FIELDS) {
        assertFieldPresent(fields, field, blockIndex);
      }
      normalizedTask.task_id = assertStringField(fields, 'task_id', blockIndex);
      normalizedTask.title = assertStringField(fields, 'title', blockIndex);
      normalizedTask.objective = assertStringField(fields, 'objective', blockIndex);
      normalizedTask.base_commit = assertStringField(fields, 'base_commit', blockIndex);
      normalizedTask.scope = assertStringListField(fields, 'scope', blockIndex);
      normalizedTask.out_of_scope = assertStringListField(fields, 'out_of_scope', blockIndex);
      normalizedTask.deliverables = assertStringListField(fields, 'deliverables', blockIndex);
      normalizedTask.validation_commands = assertStringListField(fields, 'validation_commands', blockIndex);
      normalizedTask.report_path = assertStringField(fields, 'report_path', blockIndex);
      normalizedTask.remote_sync_policy = fields.remote_sync_policy;
      if (
        (typeof fields.governance_revision !== 'string' && typeof fields.governance_revision !== 'number') ||
        (typeof fields.governance_revision === 'string' && fields.governance_revision.trim() === '')
      ) {
        throw new WritingBlockProtocolError(
          'WRITING_BLOCK_INVALID_FIELD',
          'governance_revision must be a non-empty string or finite number',
          { blockIndex, field: 'governance_revision' },
        );
      }
      if (!Array.isArray(fields.architecture_revision_set)) {
        throw new WritingBlockProtocolError('WRITING_BLOCK_INVALID_FIELD', 'architecture_revision_set must be a list', {
          blockIndex,
          field: 'architecture_revision_set',
        });
      }
      if (
        !isRecord(fields.remote_sync_policy) &&
        !isNonEmptyString(fields.remote_sync_policy) &&
        typeof fields.remote_sync_policy !== 'boolean'
      ) {
        throw new WritingBlockProtocolError(
          'WRITING_BLOCK_INVALID_FIELD',
          'remote_sync_policy must be an object, string, or boolean',
          { blockIndex, field: 'remote_sync_policy' },
        );
      }
      normalizedTask.execution_semantics = DEFAULT_LUNA_IMPLEMENTATION_SEMANTICS;
      normalized = normalizedTask;
      break;
    }
    case 'GOVERNANCE_CHANGE': {
      const normalizedChange: Record<string, unknown> = { ...fields };
      normalizedChange.change_id = assertStringField(fields, 'change_id', blockIndex);
      normalizedChange.operation = assertStringField(fields, 'operation', blockIndex);
      normalizedChange.document_id = assertStringField(fields, 'document_id', blockIndex);
      normalizedChange.path = assertStringField(fields, 'path', blockIndex);
      normalizedChange.reason = assertStringField(fields, 'reason', blockIndex);
      normalizedChange.risk_level = assertStringField(fields, 'risk_level', blockIndex);
      normalizedChange.affected_agents = assertStringListField(fields, 'affected_agents', blockIndex);
      normalizedChange.content = assertStringField(fields, 'content', blockIndex);
      normalized = normalizedChange;
      break;
    }
    case 'GOVERNANCE_RECONCILIATION': {
      const normalizedReconciliation: Record<string, unknown> = { ...fields };
      assertFieldPresent(fields, 'schema_version', blockIndex);
      const status = assertStringField(fields, 'status', blockIndex);
      if (!(GOVERNANCE_RECONCILIATION_STATUSES as readonly string[]).includes(status)) {
        throw new WritingBlockProtocolError(
          'WRITING_BLOCK_INVALID_FIELD',
          `status must be one of ${GOVERNANCE_RECONCILIATION_STATUSES.join(', ')}`,
          { blockIndex, field: 'status' },
        );
      }
      normalizedReconciliation.status = status;
      const files = fields.files;
      if (status === 'CHANGES_REQUIRED') {
        normalizedReconciliation.baseline_commit = assertStringField(fields, 'baseline_commit', blockIndex);
        normalizedReconciliation.files = normalizeReconciliationFiles(files, blockIndex);
      } else {
        if (files !== undefined && (!Array.isArray(files) || files.length > 0)) {
          throw new WritingBlockProtocolError(
            'WRITING_BLOCK_INVALID_FIELD',
            `files must be omitted or empty when status is ${status}`,
            { blockIndex, field: 'files' },
          );
        }
        if (files !== undefined) normalizedReconciliation.files = [];
        if (fields.baseline_commit !== undefined)
          normalizedReconciliation.baseline_commit = assertStringField(fields, 'baseline_commit', blockIndex);
      }
      if (status === 'BLOCKED') {
        normalizedReconciliation.reason = assertStringField(fields, 'reason', blockIndex);
      } else if (fields.reason !== undefined) {
        normalizedReconciliation.reason = assertStringField(fields, 'reason', blockIndex);
      }
      normalized = normalizedReconciliation;
      break;
    }
    case 'ARCHITECTURE_FREEZE': {
      const normalizedFreeze: Record<string, unknown> = { ...fields };
      normalizedFreeze.freeze_id = assertStringField(fields, 'freeze_id', blockIndex);
      normalizedFreeze.download_url = assertStringField(fields, 'download_url', blockIndex);
      normalizedFreeze.reason = assertStringField(fields, 'reason', blockIndex);
      normalizedFreeze.luna_follow_up = assertStringField(fields, 'luna_follow_up', blockIndex);
      normalizedFreeze.affected_scope = assertStringListField(fields, 'affected_scope', blockIndex);
      if (
        (typeof fields.version !== 'string' && typeof fields.version !== 'number') ||
        (typeof fields.version === 'number' && !Number.isFinite(fields.version)) ||
        (typeof fields.version === 'string' && fields.version.trim() === '')
      ) {
        throw new WritingBlockProtocolError('WRITING_BLOCK_INVALID_FIELD', 'Architecture version is invalid', {
          blockIndex,
          field: 'version',
        });
      }
      if (
        fields.sha256_if_known !== null &&
        fields.sha256_if_known !== undefined &&
        !isNonEmptyString(fields.sha256_if_known)
      ) {
        throw new WritingBlockProtocolError(
          'WRITING_BLOCK_INVALID_FIELD',
          'sha256_if_known must be null or a non-empty string',
          { blockIndex, field: 'sha256_if_known' },
        );
      }
      normalizedFreeze.sha256_if_known = fields.sha256_if_known ?? null;
      normalized = normalizedFreeze;
      break;
    }
    case 'BLOCKED': {
      const normalizedBlocked: Record<string, unknown> = { ...fields };
      normalizedBlocked.code = assertStringField(fields, 'code', blockIndex);
      normalizedBlocked.reason = assertStringField(fields, 'reason', blockIndex);
      normalized = normalizedBlocked;
      break;
    }
  }
  const knownFields = new Set<string>(['schema_version']);
  const requiredFields =
    type === 'LUNA_TASK'
      ? LUNA_TASK_REQUIRED_FIELDS
      : type === 'GOVERNANCE_CHANGE'
        ? GOVERNANCE_CHANGE_REQUIRED_FIELDS
        : type === 'GOVERNANCE_RECONCILIATION'
          ? GOVERNANCE_RECONCILIATION_REQUIRED_FIELDS
          : type === 'ARCHITECTURE_FREEZE'
            ? ARCHITECTURE_FREEZE_REQUIRED_FIELDS
            : BLOCKED_REQUIRED_FIELDS;
  for (const field of requiredFields) knownFields.add(field);
  if (type === 'LUNA_TASK') knownFields.add('execution_semantics');
  if (type === 'GOVERNANCE_RECONCILIATION') {
    knownFields.add('baseline_commit');
    knownFields.add('files');
    knownFields.add('reason');
  }
  const extensions = Object.fromEntries(Object.entries(normalized).filter(([key]) => !knownFields.has(key)));
  normalized.schema_version = fields.schema_version ?? WRITING_BLOCK_SCHEMA_VERSION;
  return { type, fields: normalized as never, extensions, rawBody } as WritingBlock;
}

export function parseWritingBlocks(input: unknown): ParsedWritingBlocks {
  if (typeof input !== 'string') {
    throw new WritingBlockProtocolError('WRITING_BLOCK_INPUT_INVALID', 'Writing block input must be a string');
  }
  const inputText = normalizeWritingBlockMarkers(input);
  const blocks: WritingBlock[] = [];
  let cursor = 0;
  while (cursor < inputText.length) {
    const nextOpen = inputText.indexOf(OPEN_MARKER, cursor);
    const nextClose = inputText.indexOf(CLOSE_MARKER, cursor);
    if (nextClose >= 0 && (nextOpen < 0 || nextClose < nextOpen)) {
      throw new WritingBlockProtocolError(
        'WRITING_BLOCK_OUT_OF_BLOCK_CONTENT',
        `第 ${blocks.length} 个 Writing Block 之外发现结束标记。请只输出完整的 Writing Block。`,
        { blockIndex: blocks.length },
      );
    }
    if (nextOpen < 0) {
      if (inputText.slice(cursor).trim() !== '') {
        throw new WritingBlockProtocolError(
          'WRITING_BLOCK_OUT_OF_BLOCK_CONTENT',
          `第 ${blocks.length} 个 Writing Block 之外存在非空白文本。请删除块外说明文字。`,
          { blockIndex: blocks.length },
        );
      }
      break;
    }
    if (inputText.slice(cursor, nextOpen).trim() !== '') {
      throw new WritingBlockProtocolError(
        'WRITING_BLOCK_OUT_OF_BLOCK_CONTENT',
        `第 ${blocks.length} 个 Writing Block 之外存在非空白文本。请删除块外说明文字。`,
        { blockIndex: blocks.length },
      );
    }
    const blockIndex = blocks.length;
    const header = parseHeader(inputText, nextOpen, blockIndex);
    const bodyEnd = inputText.indexOf(CLOSE_MARKER, header.end);
    if (bodyEnd < 0) {
      throw new WritingBlockProtocolError(
        'WRITING_BLOCK_UNCLOSED',
        `第 ${blockIndex} 个 Writing Block（类型 ${header.type}）未闭合。请补齐 ${CLOSE_MARKER}。`,
        { blockIndex, blockType: header.type },
      );
    }
    const body = inputText.slice(header.end, bodyEnd);
    if (body.includes(OPEN_MARKER)) {
      throw new WritingBlockProtocolError(
        'WRITING_BLOCK_NESTED',
        `第 ${blockIndex} 个 Writing Block（类型 ${header.type}）包含嵌套块。请拆分为同级块。`,
        {
          blockIndex,
          blockType: header.type,
        },
      );
    }
    let fields: Record<string, unknown>;
    let block: WritingBlock;
    try {
      fields = parseBody(body, blockIndex, header.type);
      block = buildBlock(header.type, fields, body, blockIndex);
    } catch (error) {
      if (error instanceof WritingBlockProtocolError) {
        const field = error.field === null ? '' : `字段 ${error.field} `;
        throw new WritingBlockProtocolError(
          error.code,
          `第 ${blockIndex} 个 Writing Block（类型 ${header.type}）${field}校验失败：${error.message}`,
          { blockIndex, blockType: header.type, ...(error.field === null ? {} : { field: error.field }), cause: error },
        );
      }
      throw error;
    }
    if (block.type === 'LUNA_TASK' && blocks.some((item) => item.type === 'LUNA_TASK')) {
      throw new WritingBlockProtocolError(
        'WRITING_BLOCK_DUPLICATE_LUNA_TASK',
        `第 ${blockIndex} 个 Writing Block（类型 LUNA_TASK）违反规则：一回合最多一个 LUNA_TASK。`,
        {
          blockIndex,
          blockType: block.type,
        },
      );
    }
    if (
      block.type === 'GOVERNANCE_RECONCILIATION' &&
      blocks.some((item) => item.type === 'GOVERNANCE_RECONCILIATION')
    ) {
      throw new WritingBlockProtocolError(
        'WRITING_BLOCK_DUPLICATE_GOVERNANCE_RECONCILIATION',
        `第 ${blockIndex} 个 Writing Block（类型 GOVERNANCE_RECONCILIATION）违反规则：一回合最多一个该类型块。`,
        { blockIndex, blockType: block.type },
      );
    }
    blocks.push(block);
    cursor = bodyEnd + CLOSE_MARKER.length;
  }
  return {
    blocks,
    lunaTask: blocks.find((block): block is LunaTaskBlock => block.type === 'LUNA_TASK') ?? null,
    governanceChanges: blocks.filter((block): block is GovernanceChangeBlock => block.type === 'GOVERNANCE_CHANGE'),
    governanceReconciliation:
      blocks.find((block): block is GovernanceReconciliationBlock => block.type === 'GOVERNANCE_RECONCILIATION') ??
      null,
    architectureFreezes: blocks.filter(
      (block): block is ArchitectureFreezeBlock => block.type === 'ARCHITECTURE_FREEZE',
    ),
    blocked: blocks.filter((block): block is BlockedBlock => block.type === 'BLOCKED'),
  };
}

export function parseWritingBlock(input: unknown): WritingBlock {
  const parsed = parseWritingBlocks(input);
  if (parsed.blocks.length !== 1) {
    const offending = parsed.blocks[1];
    throw new WritingBlockProtocolError(
      'WRITING_BLOCK_INPUT_INVALID',
      `需要且只能有一个 Writing Block，实际得到 ${parsed.blocks.length} 个。`,
      offending === undefined ? {} : { blockIndex: 1, blockType: offending.type },
    );
  }
  return parsed.blocks[0]!;
}
