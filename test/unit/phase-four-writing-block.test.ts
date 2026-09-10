import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LUNA_IMPLEMENTATION_SEMANTICS,
  parseWritingBlocks,
  WritingBlockProtocolError,
} from '../../src/shared/protocol/writing-block.js';

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
    ).toThrowError(expect.objectContaining({ code: 'WRITING_BLOCK_DUPLICATE_LUNA_TASK' }));
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
});
