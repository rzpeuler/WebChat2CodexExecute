import { parse as parseYaml } from 'yaml';

export const WRITING_BLOCK_SCHEMA_VERSION = 1 as const;

export const WRITING_BLOCK_TYPES = ['LUNA_TASK', 'GOVERNANCE_CHANGE', 'ARCHITECTURE_FREEZE', 'BLOCKED'] as const;
export type WritingBlockType = (typeof WRITING_BLOCK_TYPES)[number];

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
export type ArchitectureFreezeBlock = WritingBlockBase<'ARCHITECTURE_FREEZE', ArchitectureFreezeFields>;
export type BlockedBlock = WritingBlockBase<'BLOCKED', BlockedFields>;
export type WritingBlock = LunaTaskBlock | GovernanceChangeBlock | ArchitectureFreezeBlock | BlockedBlock;

export interface ParsedWritingBlocks {
  blocks: WritingBlock[];
  lunaTask: LunaTaskBlock | null;
  governanceChanges: GovernanceChangeBlock[];
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
  | 'WRITING_BLOCK_DUPLICATE_LUNA_TASK';

export class WritingBlockProtocolError extends Error {
  readonly code: WritingBlockProtocolErrorCode;
  readonly blockIndex: number | null;
  readonly field: string | null;

  constructor(
    code: WritingBlockProtocolErrorCode,
    message: string,
    options: { blockIndex?: number; field?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WritingBlockProtocolError';
    this.code = code;
    this.blockIndex = options.blockIndex ?? null;
    this.field = options.field ?? null;
  }
}

export const WRITING_BLOCK_JSON_SCHEMAS = {
  LUNA_TASK: {
    type: 'object',
    additionalProperties: true,
    required: [...LUNA_TASK_REQUIRED_FIELDS],
    properties: { schema_version: { const: WRITING_BLOCK_SCHEMA_VERSION } },
  },
  GOVERNANCE_CHANGE: {
    type: 'object',
    additionalProperties: true,
    required: [...GOVERNANCE_CHANGE_REQUIRED_FIELDS],
    properties: { schema_version: { const: WRITING_BLOCK_SCHEMA_VERSION } },
  },
  ARCHITECTURE_FREEZE: {
    type: 'object',
    additionalProperties: true,
    required: [...ARCHITECTURE_FREEZE_REQUIRED_FIELDS],
    properties: { schema_version: { const: WRITING_BLOCK_SCHEMA_VERSION } },
  },
  BLOCKED: {
    type: 'object',
    additionalProperties: true,
    required: [...BLOCKED_REQUIRED_FIELDS],
    properties: { schema_version: { const: WRITING_BLOCK_SCHEMA_VERSION } },
  },
} as const;

const OPEN_MARKER = '[WRITING_BLOCK';
const CLOSE_MARKER = '[/WRITING_BLOCK]';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertFieldPresent(fields: Record<string, unknown>, field: string, blockIndex: number): void {
  if (!(field in fields) || fields[field] === null || fields[field] === undefined) {
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

function assertVersion(fields: Record<string, unknown>, blockIndex: number): void {
  if (fields.schema_version !== undefined && fields.schema_version !== WRITING_BLOCK_SCHEMA_VERSION) {
    throw new WritingBlockProtocolError(
      'WRITING_BLOCK_UNSUPPORTED_VERSION',
      `Writing block ${blockIndex} has unsupported schema version: ${String(fields.schema_version)}`,
      { blockIndex, field: 'schema_version' },
    );
  }
}

function parseBody(body: string, blockIndex: number): Record<string, unknown> {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    throw new WritingBlockProtocolError(
      'WRITING_BLOCK_BODY_NOT_OBJECT',
      `Writing block ${blockIndex} has an empty body`,
      {
        blockIndex,
      },
    );
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isRecord(parsed)) {
        throw new WritingBlockProtocolError(
          'WRITING_BLOCK_BODY_NOT_OBJECT',
          `Writing block ${blockIndex} JSON body must be an object`,
          { blockIndex },
        );
      }
      return parsed;
    } catch (error) {
      if (error instanceof WritingBlockProtocolError) {
        throw error;
      }
      throw new WritingBlockProtocolError(
        'WRITING_BLOCK_BODY_INVALID_JSON',
        `Writing block ${blockIndex} has invalid JSON body`,
        { blockIndex, cause: error },
      );
    }
  }

  try {
    const parsed: unknown = parseYaml(trimmed);
    if (!isRecord(parsed)) {
      throw new WritingBlockProtocolError(
        'WRITING_BLOCK_BODY_NOT_OBJECT',
        `Writing block ${blockIndex} YAML body must be an object`,
        { blockIndex },
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof WritingBlockProtocolError) {
      throw error;
    }
    throw new WritingBlockProtocolError(
      'WRITING_BLOCK_BODY_INVALID_YAML',
      `Writing block ${blockIndex} has invalid YAML body`,
      { blockIndex, cause: error },
    );
  }
}

function parseHeader(source: string, start: number, blockIndex: number): { type: WritingBlockType; end: number } {
  const end = source.indexOf(']', start);
  if (end < 0) {
    throw new WritingBlockProtocolError(
      'WRITING_BLOCK_HEADER_INVALID',
      `Writing block ${blockIndex} has an invalid header`,
      {
        blockIndex,
      },
    );
  }
  const header = source.slice(start, end + 1);
  const match = /^\[WRITING_BLOCK type="([^"]+)"\]$/.exec(header);
  if (match === null) {
    throw new WritingBlockProtocolError(
      'WRITING_BLOCK_HEADER_INVALID',
      `Writing block ${blockIndex} has an invalid header`,
      {
        blockIndex,
      },
    );
  }
  const candidate = match[1] ?? '';
  if (!(WRITING_BLOCK_TYPES as readonly string[]).includes(candidate)) {
    throw new WritingBlockProtocolError('WRITING_BLOCK_UNKNOWN_TYPE', `Unknown writing block type: ${candidate}`, {
      blockIndex,
    });
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
        : type === 'ARCHITECTURE_FREEZE'
          ? ARCHITECTURE_FREEZE_REQUIRED_FIELDS
          : BLOCKED_REQUIRED_FIELDS;
  for (const field of requiredFields) knownFields.add(field);
  if (type === 'LUNA_TASK') knownFields.add('execution_semantics');
  const extensions = Object.fromEntries(Object.entries(normalized).filter(([key]) => !knownFields.has(key)));
  normalized.schema_version = fields.schema_version ?? WRITING_BLOCK_SCHEMA_VERSION;
  return { type, fields: normalized as never, extensions, rawBody } as WritingBlock;
}

export function parseWritingBlocks(input: unknown): ParsedWritingBlocks {
  if (typeof input !== 'string') {
    throw new WritingBlockProtocolError('WRITING_BLOCK_INPUT_INVALID', 'Writing block input must be a string');
  }
  const blocks: WritingBlock[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const nextOpen = input.indexOf(OPEN_MARKER, cursor);
    const nextClose = input.indexOf(CLOSE_MARKER, cursor);
    if (nextClose >= 0 && (nextOpen < 0 || nextClose < nextOpen)) {
      throw new WritingBlockProtocolError('WRITING_BLOCK_OUT_OF_BLOCK_CONTENT', 'Closing marker found outside a block');
    }
    if (nextOpen < 0) {
      if (input.slice(cursor).trim() !== '') {
        throw new WritingBlockProtocolError(
          'WRITING_BLOCK_OUT_OF_BLOCK_CONTENT',
          'Non-whitespace content is outside a writing block',
        );
      }
      break;
    }
    if (input.slice(cursor, nextOpen).trim() !== '') {
      throw new WritingBlockProtocolError(
        'WRITING_BLOCK_OUT_OF_BLOCK_CONTENT',
        'Non-whitespace content is outside a writing block',
      );
    }
    const blockIndex = blocks.length;
    const header = parseHeader(input, nextOpen, blockIndex);
    const bodyEnd = input.indexOf(CLOSE_MARKER, header.end);
    if (bodyEnd < 0) {
      throw new WritingBlockProtocolError('WRITING_BLOCK_UNCLOSED', `Writing block ${blockIndex} is not closed`, {
        blockIndex,
      });
    }
    const body = input.slice(header.end, bodyEnd);
    if (body.includes(OPEN_MARKER)) {
      throw new WritingBlockProtocolError(
        'WRITING_BLOCK_NESTED',
        `Writing block ${blockIndex} contains a nested block`,
        {
          blockIndex,
        },
      );
    }
    const fields = parseBody(body, blockIndex);
    const block = buildBlock(header.type, fields, body, blockIndex);
    if (block.type === 'LUNA_TASK' && blocks.some((item) => item.type === 'LUNA_TASK')) {
      throw new WritingBlockProtocolError(
        'WRITING_BLOCK_DUPLICATE_LUNA_TASK',
        'A round may contain at most one LUNA_TASK',
        {
          blockIndex,
        },
      );
    }
    blocks.push(block);
    cursor = bodyEnd + CLOSE_MARKER.length;
  }
  return {
    blocks,
    lunaTask: blocks.find((block): block is LunaTaskBlock => block.type === 'LUNA_TASK') ?? null,
    governanceChanges: blocks.filter((block): block is GovernanceChangeBlock => block.type === 'GOVERNANCE_CHANGE'),
    architectureFreezes: blocks.filter(
      (block): block is ArchitectureFreezeBlock => block.type === 'ARCHITECTURE_FREEZE',
    ),
    blocked: blocks.filter((block): block is BlockedBlock => block.type === 'BLOCKED'),
  };
}

export function parseWritingBlock(input: unknown): WritingBlock {
  const parsed = parseWritingBlocks(input);
  if (parsed.blocks.length !== 1) {
    throw new WritingBlockProtocolError('WRITING_BLOCK_INPUT_INVALID', 'Expected exactly one writing block');
  }
  return parsed.blocks[0]!;
}
