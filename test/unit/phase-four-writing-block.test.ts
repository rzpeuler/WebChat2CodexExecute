import { describe, expect, it } from 'vitest';
import {
  ARCHITECTURE_FREEZE_REQUIRED_FIELDS,
  DEFAULT_LUNA_IMPLEMENTATION_SEMANTICS,
  parseWritingBlocks,
  WRITING_BLOCK_JSON_SCHEMAS,
  WritingBlockProtocolError,
} from '../../src/shared/protocol/writing-block.js';
import {
  WRITING_BLOCK_TEMPLATE_AUDIENCE,
  WRITING_BLOCK_TEMPLATE_DIRECTORY,
  WRITING_BLOCK_TEMPLATE_DOCUMENT_TYPE,
  WRITING_BLOCK_TEMPLATE_FILENAMES,
  WRITING_BLOCK_TEMPLATE_PATHS,
  WRITING_BLOCK_TEMPLATE_VERSION,
  WRITING_BLOCK_TEMPLATES,
  formatWritingBlock,
  stringifyWritingBlockTemplate,
} from '../../src/shared/protocol/writing-block-templates.js';

function block(type: string, fields: Record<string, unknown>): string {
  return `[WRITING_BLOCK type="${type}"]\n${JSON.stringify(fields)}\n[/WRITING_BLOCK]`;
}

const task = {
  task_id: 'task-1',
  title: 'Implement protocol',
  objective: 'Implement the approved bounded task.',
  base_commit: '0123456789012345678901234567890123456789',
  scope: ['src/shared/protocol'],
  out_of_scope: ['Edge', 'Codex'],
  deliverables: ['parser', 'tests'],
  validation_commands: ['npm test'],
  governance_revision: 4,
  architecture_revision_set: [],
  report_path: 'docs/task-reports/task-1.md',
  remote_sync_policy: { push: false },
};

describe('Writing Block protocol', () => {
  it('exports five JSON-safe reusable templates and shared governance metadata', () => {
    expect(WRITING_BLOCK_TEMPLATE_VERSION).toBe(1);
    expect(WRITING_BLOCK_TEMPLATE_DIRECTORY).toBe('docs/governance/templates/writing-blocks');
    expect(WRITING_BLOCK_TEMPLATE_DOCUMENT_TYPE).toBe('writing-block-template');
    expect(WRITING_BLOCK_TEMPLATE_AUDIENCE).toEqual(['Sol', 'Codex']);
    expect(Object.isFrozen(WRITING_BLOCK_TEMPLATE_AUDIENCE)).toBe(true);
    expect(Object.isFrozen(WRITING_BLOCK_TEMPLATE_FILENAMES)).toBe(true);
    expect(Object.isFrozen(WRITING_BLOCK_TEMPLATE_PATHS)).toBe(true);
    expect(Object.isFrozen(WRITING_BLOCK_TEMPLATES)).toBe(true);
    expect(Object.isFrozen(WRITING_BLOCK_TEMPLATES.LUNA_TASK.scope)).toBe(true);
    expect(Object.isFrozen(WRITING_BLOCK_TEMPLATES.LUNA_TASK.remote_sync_policy)).toBe(true);
    expect(Object.isFrozen(WRITING_BLOCK_TEMPLATES.GOVERNANCE_RECONCILIATION.instructions)).toBe(true);
    expect(Object.isFrozen(WRITING_BLOCK_TEMPLATES.GOVERNANCE_RECONCILIATION.variants)).toBe(true);
    expect(Object.isFrozen(WRITING_BLOCK_TEMPLATES.GOVERNANCE_RECONCILIATION.variants.PASS.files)).toBe(true);
    expect(Object.isFrozen(WRITING_BLOCK_TEMPLATES.GOVERNANCE_RECONCILIATION.variants.CHANGES_REQUIRED.files)).toBe(
      true,
    );
    expect(Object.isFrozen(WRITING_BLOCK_TEMPLATES.GOVERNANCE_RECONCILIATION.variants.CHANGES_REQUIRED.files[0])).toBe(
      true,
    );
    const originalPath = WRITING_BLOCK_TEMPLATE_PATHS.LUNA_TASK;
    const originalScope = WRITING_BLOCK_TEMPLATES.LUNA_TASK.scope[0];
    expect(() => {
      (WRITING_BLOCK_TEMPLATE_PATHS as Record<string, string>).LUNA_TASK = 'changed';
    }).toThrow();
    expect(() => {
      (WRITING_BLOCK_TEMPLATES.LUNA_TASK.scope as string[])[0] = 'changed';
    }).toThrow();
    expect(WRITING_BLOCK_TEMPLATE_PATHS.LUNA_TASK).toBe(originalPath);
    expect(WRITING_BLOCK_TEMPLATES.LUNA_TASK.scope[0]).toBe(originalScope);
    expect(Object.keys(WRITING_BLOCK_TEMPLATES)).toEqual([
      'LUNA_TASK',
      'GOVERNANCE_CHANGE',
      'ARCHITECTURE_FREEZE',
      'BLOCKED',
      'GOVERNANCE_RECONCILIATION',
    ]);
    for (const type of Object.keys(WRITING_BLOCK_TEMPLATES) as Array<keyof typeof WRITING_BLOCK_TEMPLATES>) {
      const serialized = stringifyWritingBlockTemplate(type);
      expect(JSON.parse(serialized)).toEqual(WRITING_BLOCK_TEMPLATES[type]);
      expect(serialized).not.toContain('[/WRITING_BLOCK]');
      expect(() => parseWritingBlocks(serialized)).toThrowError(
        expect.objectContaining({ code: 'WRITING_BLOCK_OUT_OF_BLOCK_CONTENT' }),
      );
      expect(WRITING_BLOCK_TEMPLATE_FILENAMES[type]).toMatch(/\.template\.json$/);
      expect(WRITING_BLOCK_TEMPLATE_PATHS[type]).toBe(
        `${WRITING_BLOCK_TEMPLATE_DIRECTORY}/${WRITING_BLOCK_TEMPLATE_FILENAMES[type]}`,
      );
    }
  });

  it('parses fixtures made by replacing all template placeholders with actual values', () => {
    const fixtures = [
      formatWritingBlock('LUNA_TASK', {
        ...WRITING_BLOCK_TEMPLATES.LUNA_TASK,
        task_id: 'task-json-1',
        title: 'JSON task',
        objective: 'Validate JSON templates',
        base_commit: '0123456789012345678901234567890123456789',
        scope: ['src/shared/protocol/writing-block.ts'],
        out_of_scope: ['renderer'],
        deliverables: ['template definitions'],
        validation_commands: ['npm test -- --run'],
        governance_revision: 4,
        architecture_revision_set: [],
        report_path: 'docs/reports/task-json-1.md',
        remote_sync_policy: { push: false },
      }),
      formatWritingBlock('GOVERNANCE_CHANGE', {
        ...WRITING_BLOCK_TEMPLATES.GOVERNANCE_CHANGE,
        change_id: 'change-json-1',
        operation: 'add_document',
        document_id: 'policy-json',
        path: 'docs/governance/policy-json.md',
        reason: 'Cover "quotes", backslashes \\ and URLs: https://example.com/a:b.',
        risk_level: 'normal',
        affected_agents: [],
        content:
          '# 治理决策：JSON-safe #1\n保留 "quoted" text、反斜杠 \\\\ 和 Windows 路径 C:\\\\Users\\\\测试\\\\file.txt。\nURL: https://example.com/docs?a=1&b=2\nUnicode: 中文 / 日本語 / 🚀\n',
      }),
      formatWritingBlock('ARCHITECTURE_FREEZE', {
        ...WRITING_BLOCK_TEMPLATES.ARCHITECTURE_FREEZE,
        freeze_id: 'freeze-json-1',
        version: 2,
        download_url: 'https://example.com/architecture/freeze:v2.json',
        reason: 'Freeze the tested interface.',
        affected_scope: ['src/shared/protocol'],
        luna_follow_up: 'Use the frozen interface.',
      }),
      formatWritingBlock('BLOCKED', {
        ...WRITING_BLOCK_TEMPLATES.BLOCKED,
        code: 'NEEDS_USER_ACTION',
        reason: 'An external API key is required.',
      }),
      formatWritingBlock('GOVERNANCE_RECONCILIATION', {
        schema_version: WRITING_BLOCK_TEMPLATE_VERSION,
        status: 'CHANGES_REQUIRED',
        baseline_commit: '0123456789012345678901234567890123456789',
        files: [
          {
            path: 'docs/governance/policy-json.md',
            action: 'replace',
            reason: 'Align the policy.',
            sha256_before: 'a'.repeat(64),
            content:
              '规则："quoted" 路径 C:\\\\Users\\\\测试\\\\file.txt\nURL: https://example.com/a:b#fragment\nUnicode: 中文 🚀\n',
          },
        ],
      }),
    ];

    const parsed = parseWritingBlocks(fixtures.join('\n\n'));
    expect(parsed.blocks).toHaveLength(5);
    expect(parsed.blocks.map((item) => item.type)).toEqual([
      'LUNA_TASK',
      'GOVERNANCE_CHANGE',
      'ARCHITECTURE_FREEZE',
      'BLOCKED',
      'GOVERNANCE_RECONCILIATION',
    ]);
    expect(parsed.lunaTask?.fields).toMatchObject({
      task_id: 'task-json-1',
      title: 'JSON task',
      scope: ['src/shared/protocol/writing-block.ts'],
      architecture_revision_set: [],
    });
    expect(parsed.governanceChanges[0]?.fields).toMatchObject({
      change_id: 'change-json-1',
      reason: 'Cover "quotes", backslashes \\ and URLs: https://example.com/a:b.',
      content:
        '# 治理决策：JSON-safe #1\n保留 "quoted" text、反斜杠 \\\\ 和 Windows 路径 C:\\\\Users\\\\测试\\\\file.txt。\nURL: https://example.com/docs?a=1&b=2\nUnicode: 中文 / 日本語 / 🚀\n',
    });
    expect(parsed.architectureFreezes[0]?.fields).toMatchObject({
      freeze_id: 'freeze-json-1',
      download_url: 'https://example.com/architecture/freeze:v2.json',
      sha256_if_known: null,
    });
    expect(parsed.blocked[0]?.fields).toMatchObject({
      code: 'NEEDS_USER_ACTION',
      reason: 'An external API key is required.',
    });
    expect(parsed.governanceReconciliation?.fields).toMatchObject({
      status: 'CHANGES_REQUIRED',
      baseline_commit: '0123456789012345678901234567890123456789',
      files: [
        {
          path: 'docs/governance/policy-json.md',
          sha256_before: 'a'.repeat(64),
          content:
            '规则："quoted" 路径 C:\\\\Users\\\\测试\\\\file.txt\nURL: https://example.com/a:b#fragment\nUnicode: 中文 🚀\n',
        },
      ],
    });
  });

  it('accepts boundary JSON fixtures for all five block types', () => {
    const fixtures = [
      formatWritingBlock('LUNA_TASK', {
        ...WRITING_BLOCK_TEMPLATES.LUNA_TASK,
        task_id: 'task-boundary',
        title: '边界任务',
        objective: '验证空数组和 Unicode。',
        base_commit: '0123456789012345678901234567890123456789',
        scope: [],
        out_of_scope: [],
        deliverables: [],
        validation_commands: [],
        governance_revision: '4',
        architecture_revision_set: [],
        report_path: 'docs/reports/task-boundary.md',
        remote_sync_policy: { push: false, remote: null },
      }),
      formatWritingBlock('GOVERNANCE_CHANGE', {
        ...WRITING_BLOCK_TEMPLATES.GOVERNANCE_CHANGE,
        change_id: 'change-boundary',
        operation: 'replace_document',
        document_id: 'policy-boundary',
        path: 'docs/governance/policy-boundary.md',
        reason: '冒号：井号 #、Unicode 中文 🚀、URL https://example.com/a:b。',
        risk_level: 'low',
        affected_agents: [],
        content: '第一行\n第二行："引号" 和反斜杠 \\\\。\n',
      }),
      formatWritingBlock('ARCHITECTURE_FREEZE', {
        ...WRITING_BLOCK_TEMPLATES.ARCHITECTURE_FREEZE,
        freeze_id: 'freeze-boundary',
        version: 'v2:测试',
        download_url: 'https://example.com/freeze?v=2#architecture',
        sha256_if_known: null,
        reason: '没有已知摘要。',
        affected_scope: [],
        luna_follow_up: '不要把架构冻结交给 Luna。',
      }),
      formatWritingBlock('BLOCKED', {
        ...WRITING_BLOCK_TEMPLATES.BLOCKED,
        code: 'NEEDS_USER_ACTION',
        reason: '需要用户处理：登录、API Key 或 OTP。',
      }),
      formatWritingBlock('GOVERNANCE_RECONCILIATION', {
        schema_version: WRITING_BLOCK_TEMPLATE_VERSION,
        status: 'PASS',
        files: [],
      }),
    ];

    const parsed = parseWritingBlocks(fixtures.join('\n'));
    expect(parsed.blocks.map((item) => item.type)).toEqual([
      'LUNA_TASK',
      'GOVERNANCE_CHANGE',
      'ARCHITECTURE_FREEZE',
      'BLOCKED',
      'GOVERNANCE_RECONCILIATION',
    ]);
    expect(parsed.lunaTask?.fields.scope).toEqual([]);
    expect(parsed.governanceChanges[0]?.fields.affected_agents).toEqual([]);
    expect(parsed.architectureFreezes[0]?.fields.sha256_if_known).toBeNull();
    expect(parsed.governanceReconciliation?.fields.files).toEqual([]);
  });

  it('reports block index, type, and field with actionable diagnostics', () => {
    const first = formatWritingBlock('BLOCKED', { code: 'BLOCKED', reason: 'first' });
    const second = block('GOVERNANCE_CHANGE', {
      change_id: 'change-1',
      operation: 'replace_document',
      document_id: 'policy',
      path: 'docs/governance/policy.md',
      reason: 'reason',
      risk_level: 'low',
      affected_agents: [],
    });

    try {
      parseWritingBlocks(`${first}\n${second}`);
      throw new Error('expected protocol error');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'WRITING_BLOCK_MISSING_FIELD',
        blockIndex: 1,
        blockType: 'GOVERNANCE_CHANGE',
        field: 'content',
      });
      expect(error).toBeInstanceOf(WritingBlockProtocolError);
      expect((error as Error).message).toContain('第 1 个 Writing Block');
      expect((error as Error).message).toContain('类型 GOVERNANCE_CHANGE');
      expect((error as Error).message).toContain('字段 content');
    }
  });

  it.each([
    [
      'trailing comma',
      '[WRITING_BLOCK type="BLOCKED"]\n{"schema_version":1,"code":"BLOCKED","reason":"bad",}\n[/WRITING_BLOCK]',
      'WRITING_BLOCK_BODY_INVALID_JSON',
    ],
    [
      'comment inside JSON object',
      '[WRITING_BLOCK type="BLOCKED"]\n{\n// comment\n"schema_version":1,"code":"BLOCKED","reason":"bad"}\n[/WRITING_BLOCK]',
      'WRITING_BLOCK_BODY_INVALID_JSON',
    ],
    [
      'truncated JSON',
      '[WRITING_BLOCK type="GOVERNANCE_CHANGE"]\n{"schema_version":1,"change_id":"x"\n[/WRITING_BLOCK]',
      'WRITING_BLOCK_BODY_INVALID_JSON',
    ],
    [
      'unclosed block',
      '[WRITING_BLOCK type="BLOCKED"]\n{"schema_version":1,"code":"BLOCKED","reason":"bad"}',
      'WRITING_BLOCK_UNCLOSED',
    ],
    [
      'out-of-block text',
      '说明文字\n' + formatWritingBlock('BLOCKED', { code: 'BLOCKED', reason: 'bad' }),
      'WRITING_BLOCK_OUT_OF_BLOCK_CONTENT',
    ],
    [
      'nested block',
      '[WRITING_BLOCK type="BLOCKED"]\n' +
        formatWritingBlock('BLOCKED', { code: 'BLOCKED', reason: 'nested' }) +
        '\n[/WRITING_BLOCK]',
      'WRITING_BLOCK_NESTED',
    ],
  ])('fails closed for JSON boundary fixture: %s', (_name, source, code) => {
    expect(() => parseWritingBlocks(source)).toThrowError(expect.objectContaining({ code, blockIndex: 0 }));
  });

  it('documents and parses each governance reconciliation status as its own valid shape', () => {
    const template = WRITING_BLOCK_TEMPLATES.GOVERNANCE_RECONCILIATION;
    expect(template.template_kind).toBe('GOVERNANCE_RECONCILIATION');
    expect(template.instructions.join(' ')).toContain('不要合并不同状态的字段');
    expect(template.variants.PASS).toEqual({
      schema_version: WRITING_BLOCK_TEMPLATE_VERSION,
      status: 'PASS',
      files: [],
    });
    expect(template.variants.CHANGES_REQUIRED.status).toBe('CHANGES_REQUIRED');
    expect(template.variants.CHANGES_REQUIRED.baseline_commit).toContain('<填写');
    expect(template.variants.CHANGES_REQUIRED.files).toHaveLength(1);
    expect(template.variants.BLOCKED).toEqual({
      schema_version: WRITING_BLOCK_TEMPLATE_VERSION,
      status: 'BLOCKED',
      reason: '<填写需要用户或外部操作的阻塞原因>',
      files: [],
    });

    for (const variant of Object.values(template.variants)) {
      expect(JSON.parse(JSON.stringify(variant))).toEqual(variant);
      expect(JSON.stringify(variant)).not.toContain('[/WRITING_BLOCK]');
    }

    const pass = parseWritingBlocks(
      formatWritingBlock('GOVERNANCE_RECONCILIATION', {
        schema_version: 1,
        status: 'PASS',
        files: [],
      }),
    );
    expect(pass.blocks).toHaveLength(1);
    expect(pass.blocks[0]?.type).toBe('GOVERNANCE_RECONCILIATION');
    expect(pass.blocks[0]?.fields).toMatchObject({ status: 'PASS', files: [] });

    const blocked = parseWritingBlocks(
      formatWritingBlock('GOVERNANCE_RECONCILIATION', {
        schema_version: 1,
        status: 'BLOCKED',
        reason: 'The external governance source is unavailable.',
      }),
    );
    expect(blocked.blocks).toHaveLength(1);
    expect(blocked.blocks[0]?.type).toBe('GOVERNANCE_RECONCILIATION');
    expect(blocked.blocks[0]?.fields).toMatchObject({
      status: 'BLOCKED',
      reason: 'The external governance source is unavailable.',
    });

    const changesRequired = parseWritingBlocks(
      formatWritingBlock('GOVERNANCE_RECONCILIATION', {
        schema_version: 1,
        status: 'CHANGES_REQUIRED',
        baseline_commit: '0123456789012345678901234567890123456789',
        files: [
          {
            path: 'docs/governance/policy.md',
            action: 'replace',
            reason: 'Align the policy.',
            sha256_before: 'b'.repeat(64),
            content: '# Policy\n',
          },
        ],
      }),
    );
    expect(changesRequired.blocks[0]?.type).toBe('GOVERNANCE_RECONCILIATION');
    expect(changesRequired.blocks[0]?.fields).toMatchObject({
      status: 'CHANGES_REQUIRED',
      baseline_commit: '0123456789012345678901234567890123456789',
      files: [{ path: 'docs/governance/policy.md', action: 'replace', content: '# Policy\n' }],
    });
  });

  it('rejects an invalid type, reserved closing markers, and unserializable fields clearly', () => {
    expect(() => formatWritingBlock('NOT_A_TYPE' as never, {} as never)).toThrowError(
      'Unknown Writing Block template type: NOT_A_TYPE',
    );
    expect(() =>
      formatWritingBlock('BLOCKED', {
        code: 'x',
        reason: 'bad [/WRITING_BLOCK] marker',
      }),
    ).toThrowError('Writing Block fields contain the reserved marker [/WRITING_BLOCK]');
    const circular: Record<string, unknown> = {};
    circular.code = 'x';
    circular.reason = 'circular';
    circular.self = circular;
    expect(() => formatWritingBlock('BLOCKED', circular as never)).toThrowError(
      /Unable to serialize BLOCKED fields as JSON/,
    );
    expect(() => formatWritingBlock('BLOCKED', { code: BigInt(1), reason: 'unsupported' } as never)).toThrowError(
      /Unable to serialize BLOCKED fields as JSON.*BigInt/,
    );
  });

  it('rejects Unicode-decoded closing markers in JSON values and keys', () => {
    const header = '[WRITING_BLOCK type="BLOCKED"]';
    const footer = '[/WRITING_BLOCK]';
    const valueBody = '{"schema_version":1,"code":"blocked","reason":"bad \\u005b/WRITING_BLOCK]"}';
    const keyBody = '{"schema_version":1,"code":"blocked","reason":"ok","\\u005b/WRITING_BLOCK]":"bad"}';

    expect(() => parseWritingBlocks(`${header}\n${valueBody}\n${footer}`)).toThrowError(
      expect.objectContaining({ code: 'WRITING_BLOCK_RESERVED_MARKER', blockIndex: 0 }),
    );
    expect(() => parseWritingBlocks(`${header}\n${keyBody}\n${footer}`)).toThrowError(
      expect.objectContaining({ code: 'WRITING_BLOCK_RESERVED_MARKER', blockIndex: 0 }),
    );

    const doubleEscapedBody = '{"schema_version":1,"code":"blocked","reason":"bad \\\\u005b/WRITING_BLOCK]"}';
    expect(() => parseWritingBlocks(`${header}\n${doubleEscapedBody}\n${footer}`)).toThrowError(
      expect.objectContaining({ code: 'WRITING_BLOCK_RESERVED_MARKER', blockIndex: 0 }),
    );
  });

  it('associates formatWritingBlock fields with the selected block type at compile time', () => {
    formatWritingBlock('BLOCKED', { code: 'NEEDS_USER_ACTION', reason: 'An external action is required.' });
    // @ts-expect-error BLOCKED.code must be a string for the selected type.
    formatWritingBlock('BLOCKED', { code: 123, reason: 'An external action is required.' });
  });

  it('parses one task, multiple governance changes/freezes, JSON and YAML bodies, and keeps extensions', () => {
    const source = [
      block('LUNA_TASK', { ...task, extension_flag: 'keep-me' }),
      `[WRITING_BLOCK type="GOVERNANCE_CHANGE"]\nversion: 1\nchange_id: change-1\noperation: add_document\ndocument_id: policy\npath: docs/governance/policy.md\nreason: add policy\nrisk_level: normal\naffected_agents: [Sol, Luna]\ncontent: |\n  # Policy\n  Keep this rule.\nfuture_field: true\n[/WRITING_BLOCK]`,
      block('GOVERNANCE_CHANGE', {
        change_id: 'change-2',
        operation: 'record_decision',
        document_id: 'decision',
        path: 'docs/governance/decisions/decision.md',
        reason: 'record decision',
        risk_level: 'normal',
        affected_agents: ['Sol'],
        content: '# Decision',
      }),
      block('ARCHITECTURE_FREEZE', {
        freeze_id: 'freeze-1',
        version: 7,
        download_url: 'https://architecture.example/freeze.md',
        sha256_if_known: null,
        reason: 'freeze architecture',
        affected_scope: ['src'],
        luna_follow_up: 'Use the frozen interface.',
      }),
      block('ARCHITECTURE_FREEZE', {
        freeze_id: 'freeze-2',
        version: '7.1',
        download_url: 'https://architecture.example/freeze-2.md',
        sha256_if_known: null,
        reason: 'freeze more architecture',
        affected_scope: ['test'],
        luna_follow_up: 'Read the document.',
      }),
    ].join('\n\n');

    const parsed = parseWritingBlocks(source);
    expect(parsed.blocks).toHaveLength(5);
    expect(parsed.lunaTask?.fields.execution_semantics).toBe(DEFAULT_LUNA_IMPLEMENTATION_SEMANTICS);
    expect(parsed.lunaTask?.extensions).toEqual({ extension_flag: 'keep-me' });
    expect(parsed.governanceChanges).toHaveLength(2);
    expect(parsed.governanceChanges[0]?.extensions).toEqual({ version: 1, future_field: true });
    expect(parsed.architectureFreezes).toHaveLength(2);
  });

  it.each([
    ['half-open block', '[WRITING_BLOCK type="LUNA_TASK"]\n{"task_id":"x"}', 'WRITING_BLOCK_UNCLOSED'],
    ['unknown type', '[WRITING_BLOCK type="UNKNOWN"]\n{}\n[/WRITING_BLOCK]', 'WRITING_BLOCK_UNKNOWN_TYPE'],
    ['invalid header', "[WRITING_BLOCK type='LUNA_TASK']\n{}\n[/WRITING_BLOCK]", 'WRITING_BLOCK_HEADER_INVALID'],
    ['out-of-block task book', '{"task_id":"outside"}', 'WRITING_BLOCK_OUT_OF_BLOCK_CONTENT'],
    ['missing field', block('LUNA_TASK', { ...task, title: undefined }), 'WRITING_BLOCK_MISSING_FIELD'],
    ['bad body', '[WRITING_BLOCK type="LUNA_TASK"]\n{bad\n[/WRITING_BLOCK]', 'WRITING_BLOCK_BODY_INVALID_JSON'],
  ])('fails closed for %s', (_name, source, code) => {
    expect(() => parseWritingBlocks(source)).toThrowError(expect.objectContaining({ code }));
  });

  it('rejects a second Luna task but allows multiple governance/freeze blocks', () => {
    expect(() =>
      parseWritingBlocks(`${block('LUNA_TASK', task)}\n${block('LUNA_TASK', { ...task, task_id: 'task-2' })}`),
    ).toThrowError(
      expect.objectContaining({ code: 'WRITING_BLOCK_DUPLICATE_LUNA_TASK', blockIndex: 1, blockType: 'LUNA_TASK' }),
    );
  });

  it('rejects unsupported schema versions and malformed required shapes', () => {
    expect(() => parseWritingBlocks(block('LUNA_TASK', { ...task, schema_version: 2 }))).toThrowError(
      expect.objectContaining({ code: 'WRITING_BLOCK_UNSUPPORTED_VERSION' }),
    );
    expect(() => parseWritingBlocks(block('LUNA_TASK', { ...task, validation_commands: 'npm test' }))).toThrowError(
      expect.objectContaining({ code: 'WRITING_BLOCK_INVALID_FIELD' }),
    );
    expect(() => parseWritingBlocks(block('LUNA_TASK', { ...task, remote_sync_policy: null }))).toThrowError(
      WritingBlockProtocolError,
    );
  });

  it('requires sha256_if_known to be present while allowing an explicit null', () => {
    const missing = {
      freeze_id: 'freeze-1',
      version: 1,
      download_url: 'https://architecture.example/freeze.md',
      reason: 'freeze architecture',
      affected_scope: ['src'],
      luna_follow_up: 'Use the frozen document.',
    };
    expect(() => parseWritingBlocks(block('ARCHITECTURE_FREEZE', missing))).toThrowError(
      expect.objectContaining({ code: 'WRITING_BLOCK_MISSING_FIELD', field: 'sha256_if_known' }),
    );
    expect(
      parseWritingBlocks(block('ARCHITECTURE_FREEZE', { ...missing, sha256_if_known: null })).architectureFreezes[0]
        ?.fields,
    ).toMatchObject({ sha256_if_known: null });
  });

  it('exports complete known-field schemas and validates their declared shapes', () => {
    expect(WRITING_BLOCK_JSON_SCHEMAS.ARCHITECTURE_FREEZE).toMatchObject({
      type: 'object',
      additionalProperties: true,
      required: [...ARCHITECTURE_FREEZE_REQUIRED_FIELDS],
    });
    expect(WRITING_BLOCK_JSON_SCHEMAS.ARCHITECTURE_FREEZE.properties.sha256_if_known).toEqual({
      oneOf: [{ type: 'string' }, { type: 'null' }],
    });
    expect(WRITING_BLOCK_JSON_SCHEMAS.GOVERNANCE_CHANGE.properties.affected_agents).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
    expect(WRITING_BLOCK_JSON_SCHEMAS.LUNA_TASK.properties.architecture_revision_set).toEqual({
      type: 'array',
      items: {},
    });
    expect(() =>
      parseWritingBlocks(
        block('GOVERNANCE_CHANGE', {
          change_id: 'change-1',
          operation: 'add_document',
          document_id: 'policy',
          path: 'docs/governance/policy.md',
          reason: 'add policy',
          risk_level: 'normal',
          affected_agents: 'Sol',
          content: '# Policy',
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'WRITING_BLOCK_INVALID_FIELD', field: 'affected_agents' }));
  });
});
