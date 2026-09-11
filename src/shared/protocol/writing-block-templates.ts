import {
  DEFAULT_LUNA_IMPLEMENTATION_SEMANTICS,
  WRITING_BLOCK_SCHEMA_VERSION,
  type ArchitectureFreezeFields,
  type BlockedFields,
  type GovernanceChangeFields,
  type GovernanceReconciliationFields,
  type LunaTaskFields,
  type WritingBlockType,
} from './writing-block.js';

const WRITING_BLOCK_CLOSE_MARKER = '[/WRITING_BLOCK]';

function decodeUnicodeEscapes(value: string): string {
  return value.replace(/\\u([0-9a-f]{4})/gi, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): DeepReadonly<T> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return value as DeepReadonly<T>;
  }
  if (seen.has(value)) {
    return value as DeepReadonly<T>;
  }
  seen.add(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value) as DeepReadonly<T>;
}

export const WRITING_BLOCK_TEMPLATE_VERSION = WRITING_BLOCK_SCHEMA_VERSION;
export const SUPPORTED_WRITING_BLOCK_TEMPLATE_VERSIONS = [WRITING_BLOCK_TEMPLATE_VERSION] as const;
export const WRITING_BLOCK_TEMPLATE_DIRECTORY = 'docs/governance/templates/writing-blocks';
export const WRITING_BLOCK_TEMPLATE_DOCUMENT_TYPE = 'writing-block-template';
export const WRITING_BLOCK_TEMPLATE_AUDIENCE = deepFreeze(['Sol', 'Codex'] as const);

const writingBlockTemplateFilenames: { [T in WritingBlockType]: string } = {
  LUNA_TASK: 'luna-task.template.json',
  GOVERNANCE_CHANGE: 'governance-change.template.json',
  ARCHITECTURE_FREEZE: 'architecture-freeze.template.json',
  BLOCKED: 'blocked.template.json',
  GOVERNANCE_RECONCILIATION: 'governance-reconciliation.template.json',
};
export const WRITING_BLOCK_TEMPLATE_FILENAMES = deepFreeze(writingBlockTemplateFilenames);

const writingBlockTemplatePaths = Object.fromEntries(
  Object.entries(WRITING_BLOCK_TEMPLATE_FILENAMES).map(([type, filename]) => [
    type,
    `${WRITING_BLOCK_TEMPLATE_DIRECTORY}/${filename}`,
  ]),
) as { [T in WritingBlockType]: string };
export const WRITING_BLOCK_TEMPLATE_PATHS = deepFreeze(writingBlockTemplatePaths);

const multilineContentExample =
  '# Policy: safe JSON example\nRule: use \\"quoted\\" text and a Windows path C:\\\\temp\\\\file.txt.\nURL: https://example.com/docs?a=1&b=2\n';

const writingBlockTemplates = {
  LUNA_TASK: {
    schema_version: WRITING_BLOCK_TEMPLATE_VERSION,
    task_id: '<填写唯一任务 ID>',
    title: '<填写任务标题>',
    objective: '<填写任务目标>',
    base_commit: '<填写基线 commit>',
    scope: ['<填写允许修改的项目相对路径>'],
    out_of_scope: ['<填写明确排除的范围>'],
    deliverables: ['<填写交付物>'],
    validation_commands: ['<填写验证命令>'],
    governance_revision: '<填写治理版本>',
    architecture_revision_set: ['<填写架构版本或 revision>'],
    report_path: '<填写报告相对路径>',
    remote_sync_policy: { push: false },
    execution_semantics: DEFAULT_LUNA_IMPLEMENTATION_SEMANTICS,
  },
  GOVERNANCE_CHANGE: {
    schema_version: WRITING_BLOCK_TEMPLATE_VERSION,
    change_id: '<填写治理变更 ID>',
    operation: '<填写操作类型>',
    document_id: '<填写文档 ID>',
    path: '<填写 docs/governance 下的相对路径>',
    reason: '<填写变更原因>',
    risk_level: '<填写风险等级>',
    affected_agents: ['Sol', 'Codex'],
    content: multilineContentExample,
  },
  ARCHITECTURE_FREEZE: {
    schema_version: WRITING_BLOCK_TEMPLATE_VERSION,
    freeze_id: '<填写架构冻结 ID>',
    version: '<填写架构版本>',
    download_url: 'https://example.com/architecture/<填写文件名>',
    sha256_if_known: null,
    reason: '<填写冻结原因>',
    affected_scope: ['<填写受影响的项目相对路径>'],
    luna_follow_up: '<填写 Luna 后续动作>',
  },
  BLOCKED: {
    schema_version: WRITING_BLOCK_TEMPLATE_VERSION,
    code: '<填写阻塞错误码>',
    reason: '<填写需要用户或外部操作的原因>',
  },
  GOVERNANCE_RECONCILIATION: {
    template_kind: 'GOVERNANCE_RECONCILIATION',
    schema_version: WRITING_BLOCK_TEMPLATE_VERSION,
    instructions: [
      '复制且只填写下面一个 variants 状态对象作为 block body；不要合并不同状态的字段。',
      'PASS 和 BLOCKED 的 files 必须省略或保持为空数组；CHANGES_REQUIRED 必须填写 baseline_commit 和至少一个 files 项。',
    ],
    variants: {
      PASS: {
        schema_version: WRITING_BLOCK_TEMPLATE_VERSION,
        status: 'PASS',
        files: [],
      },
      CHANGES_REQUIRED: {
        schema_version: WRITING_BLOCK_TEMPLATE_VERSION,
        status: 'CHANGES_REQUIRED',
        baseline_commit: '<填写治理检查基线 commit>',
        files: [
          {
            path: 'docs/governance/<填写目标文件路径>',
            action: 'replace',
            reason: '<填写替换原因>',
            sha256_before: '<填写替换前文件的 64 位 SHA-256>',
            content: multilineContentExample,
          },
        ],
      },
      BLOCKED: {
        schema_version: WRITING_BLOCK_TEMPLATE_VERSION,
        status: 'BLOCKED',
        reason: '<填写需要用户或外部操作的阻塞原因>',
        files: [],
      },
    },
  },
} as const satisfies { [T in WritingBlockType]: Record<string, unknown> };

export const WRITING_BLOCK_TEMPLATES = deepFreeze(writingBlockTemplates);

export type WritingBlockTemplateMap = typeof WRITING_BLOCK_TEMPLATES;
export type WritingBlockTemplate<T extends WritingBlockType = WritingBlockType> = WritingBlockTemplateMap[T];
export type WritingBlockFieldsByType = {
  LUNA_TASK: LunaTaskFields;
  GOVERNANCE_CHANGE: GovernanceChangeFields;
  ARCHITECTURE_FREEZE: ArchitectureFreezeFields;
  BLOCKED: BlockedFields;
  GOVERNANCE_RECONCILIATION: GovernanceReconciliationFields;
};

function assertWritingBlockType(type: unknown): asserts type is WritingBlockType {
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(WRITING_BLOCK_TEMPLATE_FILENAMES, type)) {
    throw new Error(`Unknown Writing Block template type: ${String(type)}`);
  }
}

function assertNoClosingMarker(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value === 'string') {
    if (decodeUnicodeEscapes(value).includes(WRITING_BLOCK_CLOSE_MARKER)) {
      throw new Error(`Writing Block fields contain the reserved marker ${WRITING_BLOCK_CLOSE_MARKER}`);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (decodeUnicodeEscapes(key).includes(WRITING_BLOCK_CLOSE_MARKER)) {
      throw new Error(`Writing Block fields contain the reserved marker ${WRITING_BLOCK_CLOSE_MARKER}`);
    }
    assertNoClosingMarker(nested, seen);
  }
}

export function assertWritingBlockFieldsSafe(value: unknown): void {
  assertNoClosingMarker(value);
}

function stringifyJson(value: unknown, context: string): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized === undefined) {
      throw new Error('JSON.stringify returned undefined');
    }
    if (serialized.includes(WRITING_BLOCK_CLOSE_MARKER)) {
      throw new Error(`serialized JSON contains the reserved marker ${WRITING_BLOCK_CLOSE_MARKER}`);
    }
    return serialized;
  } catch (error) {
    if (error instanceof Error && error.message.includes(WRITING_BLOCK_CLOSE_MARKER)) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to serialize ${context} as JSON: ${detail}`, { cause: error });
  }
}

export function stringifyWritingBlockTemplate(type: WritingBlockType): string {
  assertWritingBlockType(type);
  assertNoClosingMarker(WRITING_BLOCK_TEMPLATES[type]);
  return stringifyJson(WRITING_BLOCK_TEMPLATES[type], `${type} template`);
}

export function formatWritingBlock<T extends WritingBlockType>(type: T, fields: WritingBlockFieldsByType[T]): string {
  assertWritingBlockType(type);
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error(`Writing Block fields for ${type} must be a non-null JSON object`);
  }
  assertWritingBlockFieldsSafe(fields);
  const serialized = stringifyJson(fields, `${type} fields`);
  return `[WRITING_BLOCK type="${type}"]\n${serialized}\n${WRITING_BLOCK_CLOSE_MARKER}`;
}
