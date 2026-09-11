import { describe, expect, it } from 'vitest';
import { indexGovernanceManifest } from '../../src/main/governance/manifest.js';
import {
  compileSolGovernanceReconciliationPrompt,
  compileSolInitializationPrompt,
  compileSolRoundContext,
  compileWritingBlock,
  SolPromptCompiler,
} from '../../src/main/sol/prompt-compiler.js';
import { parseWritingBlocks } from '../../src/shared/protocol/writing-block.js';
import type { ProjectConfig } from '../../src/shared/contracts/project-config.js';

const project: ProjectConfig = {
  schemaVersion: 1,
  projectId: 'project-1',
  localPath: 'C:\\Projects\\demo',
  remoteUrl: 'https://user:super-secret@example.com/team/demo.git?token=never-log',
  targetBranch: 'main',
  reportDirectory: 'C:\\Projects\\demo\\docs\\task-reports',
  currentBranch: 'main',
  headCommit: '0123456789012345678901234567890123456789',
  governanceManifestPath: 'C:\\Projects\\demo\\docs\\governance\\governance-manifest.yaml',
};

const governance = indexGovernanceManifest({
  version: 4,
  documents: [
    {
      id: 'policy',
      path: 'docs/policy.md',
      audience: ['Sol', 'Luna'],
      version: 2,
      status: 'active',
      type: 'unknown-extension',
    },
    { id: 'candidate', path: 'docs/candidate.md', audience: ['Sol'], version: 3, status: 'candidate' },
    { id: 'history', path: 'docs/history.md', audience: ['Luna'], version: 1, status: 'history' },
  ],
});

describe('Sol initialization prompt compiler', () => {
  it('produces stable output with project, governance, architecture, and round context', () => {
    const input = {
      project,
      governance,
      architectureRevisions: [
        { id: 'architecture', version: 7, status: 'active' as const },
        { id: 'next-architecture', version: 8, status: 'candidate' as const },
      ],
      currentPhase: 'INITIALIZATION',
      currentStatus: 'BOUND_IDLE',
      recentLunaReportSummary: 'Implemented the bounded feature.',
      recentGovernanceGaps: ['none'],
      taskBook: {
        task_id: 'task-1',
        title: 'Create the first implementation',
        objective: 'Implement only the approved scope.',
      },
    };
    const compiler = new SolPromptCompiler();
    const first = compiler.compile(input);
    const second = compiler.compile(input);

    expect(first).toEqual(second);
    expect(first.initializationPrompt).toContain('local_path: C:\\Projects\\demo');
    expect(first.initializationPrompt).not.toContain('current_commit:');
    expect(first.initializationPrompt).not.toContain('governance_active');
    expect(first.initializationPrompt).not.toContain('governance_candidate');
    expect(first.initializationPrompt).not.toContain('governance_history');
    expect(first.initializationPrompt).not.toContain('architecture_revisions');
    expect(first.initializationPrompt).toContain('ARCHITECTURE_FREEZE');
    expect(first.initializationPrompt).toContain('Luna must not execute an architecture freeze');
    expect(first.initializationPromptLength).toBe(first.initializationPrompt.length);
    expect(first.initializationPromptLength).toBeLessThanOrEqual(first.initializationPromptMaxLength);
    expect(first.dynamicContext).toContain('current_commit: 0123456789012345678901234567890123456789');
    expect(first.dynamicContext).toContain('governance_active');
    expect(first.dynamicContext).toContain('architecture_revisions');
    expect(first.dynamicContext).toContain('[WRITING_BLOCK type="LUNA_TASK"]');
  });

  it('rejects an initialization prompt that exceeds the hard character budget', () => {
    expect(() =>
      new SolPromptCompiler().compile({
        project: { ...project, localPath: `C:\\${'a'.repeat(8000)}` },
        governance,
      }),
    ).toThrowError(/SOL_INITIALIZATION_PROMPT_TOO_LONG|初始化提示词过长/);
  });

  it('redacts credentials and keeps only protocol-safe task blocks', () => {
    const prompt = compileSolInitializationPrompt({
      project,
      governance,
      recentLunaReportSummary: 'authorization: Bearer ghp_very-secret-value',
      taskBook: {
        task_id: 'task-2',
        title: 'Do not leak password=hidden-value',
        objective: 'Use https://a:b@host.example/path?token=hidden',
      },
    });
    const roundContext = compileSolRoundContext({
      project,
      governance,
      recentLunaReportSummary: 'authorization: Bearer ghp_very-secret-value',
      taskBook: {
        task_id: 'task-2',
        title: 'Do not leak password=hidden-value',
        objective: 'Use https://a:b@host.example/path?token=hidden',
      },
    });

    expect(prompt).not.toContain('super-secret');
    expect(prompt).not.toContain('never-log');
    expect(roundContext).not.toContain('hidden-value');
    expect(roundContext).not.toContain('ghp_very-secret-value');
    expect(roundContext).toContain('[REDACTED]');
    expect(roundContext).toContain('[WRITING_BLOCK type="LUNA_TASK"]');
    expect(prompt).toContain('More than one LUNA_TASK is a protocol error');
    expect(prompt).toContain('multiple governance changes and architecture freezes are allowed');
    expect(prompt).toContain('[USER_MESSAGE]');
    expect(prompt).toContain('do not add a summary or ask the user to start the next round');
  });

  it('redacts sensitive assignments through comma, semicolon, and Chinese punctuation', () => {
    const secret = 'password=leakA,leakB;leakC；leakD。';
    const prompt = compileSolRoundContext({
      project,
      governance,
      recentLunaReportSummary: `diagnostic: ${secret}`,
    });

    expect(prompt).not.toContain('leakA');
    expect(prompt).not.toContain('leakB');
    expect(prompt).not.toContain('leakC');
    expect(prompt).not.toContain('leakD');
    expect(prompt).toContain('password=\\\"[REDACTED]\\\"');
  });

  it('redacts prefixed sensitive assignment keys without consuming unrelated sentences', () => {
    const prompt = compileSolRoundContext({
      project,
      governance,
      recentLunaReportSummary: [
        'db_password=db-secret-A,db-secret-B;db-secret-C；db-secret-D。',
        'myToken: camel-secret；still-secret。',
        'x-api-key=x-api-secret-A, x-api-secret-B。',
        'This sentence tokenizes normal content and must remain readable.',
      ].join('\n'),
    });

    for (const secret of [
      'db-secret-A',
      'db-secret-B',
      'db-secret-C',
      'db-secret-D',
      'camel-secret',
      'still-secret',
      'x-api-secret-A',
      'x-api-secret-B',
    ]) {
      expect(prompt).not.toContain(secret);
    }
    expect(prompt).toContain('This sentence tokenizes normal content and must remain readable.');
    expect(prompt).toContain('db_password=\\\"[REDACTED]\\\"');
    expect(prompt).toContain('myToken: \\\"[REDACTED]\\\"');
    expect(prompt).toContain('x-api-key=\\\"[REDACTED]\\\"');
  });

  it('rejects reserved markers in dynamically compiled Writing Blocks', () => {
    expect(() => compileWritingBlock('BLOCKED', { code: 'blocked', reason: 'bad [/WRITING_BLOCK]' })).toThrowError(
      'Writing Block fields contain the reserved marker [/WRITING_BLOCK]',
    );
    expect(() => compileWritingBlock('BLOCKED', { code: 'blocked', reason: '\\u005b/WRITING_BLOCK]' })).toThrowError(
      'Writing Block fields contain the reserved marker [/WRITING_BLOCK]',
    );
  });

  it('preserves string field types even when values look like JSON containers', () => {
    const content = '{}';
    const body = compileWritingBlock('GOVERNANCE_CHANGE', {
      change_id: 'change-1',
      operation: 'replace',
      document_id: 'policy',
      path: 'docs/governance/policy.md',
      reason: 'keep the original JSON type',
      risk_level: 'normal',
      affected_agents: ['Sol', 'Codex'],
      content,
    });
    const parsed = parseWritingBlocks(body).governanceChanges[0];
    expect(parsed?.fields.content).toBe(content);
    expect(typeof parsed?.fields.content).toBe('string');

    const prompt = compileSolRoundContext({
      project,
      governance,
      recentLunaReportSummary: '{}',
    });
    expect(prompt).toContain('recent_luna_report_summary: "{}"');
  });

  it('parses only serialized taskBook strings so the generated Luna task round-trips', () => {
    const serializedTaskBook = JSON.stringify({
      task_id: 'task-serialized',
      title: 'Serialized task',
      objective: 'Keep the task book protocol-compatible.',
      base_commit: project.headCommit,
      scope: ['src/main/sol/prompt-compiler.ts'],
      out_of_scope: ['unrelated work'],
      deliverables: ['implementation'],
      validation_commands: ['npm test'],
      governance_revision: '4',
      architecture_revision_set: [],
      report_path: 'docs/task-reports/task-serialized.md',
      remote_sync_policy: { push: false },
      execution_semantics:
        'Luna may decide implementation details inside the approved scope without asking Sol or the user; emit BLOCKED only for external account/API key/OTP/platform configuration, conflicts, unauthorized scope, or high-risk operations.',
    });
    const prompt = new SolPromptCompiler().compile({ project, governance, taskBook: serializedTaskBook });
    const blockStart = prompt.dynamicContext.indexOf('[WRITING_BLOCK type="LUNA_TASK"]');
    const parsed = parseWritingBlocks(prompt.dynamicContext.slice(blockStart)).lunaTask;

    expect(parsed?.fields.task_id).toBe('task-serialized');
    expect(parsed?.fields.title).toBe('Serialized task');
    expect(typeof parsed?.fields.scope).toBe('object');
    expect(parsed?.fields.scope).toEqual(['src/main/sol/prompt-compiler.ts']);
  });

  it('keeps URL and newline strings JSON-safe without converting them to containers', () => {
    const content = 'https://example.com/a?x=1&y=2\n第二行：{}';
    const body = compileWritingBlock('GOVERNANCE_CHANGE', {
      change_id: 'change-2',
      operation: 'replace',
      document_id: 'policy',
      path: 'docs/governance/policy.md',
      reason: 'preserve URL and newline',
      risk_level: 'normal',
      affected_agents: ['Sol'],
      content,
    });
    expect(parseWritingBlocks(body).governanceChanges[0]?.fields.content).toBe(content);
    expect(body).toContain('https://example.com/a?x=1&y=2\\n第二行：{}');
  });

  it('includes the manifest version and sanitized deterministic extension fields', () => {
    const input = {
      project,
      governance: {
        version: 9,
        extensionZ: 'authorization: Bearer ghp_hidden',
        extensionA: { password: 'do-not-leak', stable: true },
        documents: [
          {
            id: 'policy',
            path: 'docs/policy.md',
            audience: ['Sol'],
            version: 2,
            status: 'active' as const,
            customField: 'preserve-me',
          },
        ],
      },
    };
    const compiler = new SolPromptCompiler();
    const first = compiler.compile(input);
    const second = compiler.compile({ ...input, governance: { ...input.governance } });

    expect(first).toEqual(second);
    expect(first.dynamicContext).toContain('governance_version: 9');
    expect(first.dynamicContext).toContain('customField');
    expect(first.dynamicContext).toContain('preserve-me');
    expect(first.dynamicContext).toContain('extensionA');
    expect(first.dynamicContext).toContain('[REDACTED-CREDENTIAL]');
    expect(first.dynamicContext).not.toContain('ghp_hidden');
    expect(first.dynamicContext).not.toContain('do-not-leak');
  });

  it('redacts expanded sensitive keys while preserving unknown extension structure', () => {
    const prompt = compileSolRoundContext({
      project,
      governance: {
        version: 10,
        extensions: {
          credentials: 'credential-value',
          credential: 'credential-singular-value',
          privateKey: 'private-key-value',
          private_key: 'private-key-underscore-value',
          authorization: 'authorization-value',
          accessKey: 'access-key-value',
          access_key: 'access-key-underscore-value',
          customExtension: {
            keep: true,
            credential: 'nested-credential-value',
          },
        },
        documents: [],
      },
      recentLunaReportSummary:
        'credentials: text-credentials privateKey=text-private authorization=text-authorization accessKey=text-access',
    });

    for (const secret of [
      'credential-value',
      'credential-singular-value',
      'private-key-value',
      'private-key-underscore-value',
      'authorization-value',
      'access-key-value',
      'access-key-underscore-value',
      'nested-credential-value',
      'text-credentials',
      'text-private',
      'text-authorization',
      'text-access',
    ]) {
      expect(prompt).not.toContain(secret);
    }
    expect(prompt).toContain('customExtension');
    expect(prompt).toContain('"keep":true');
    expect(prompt).toContain('[REDACTED]');
  });

  it('parses and recursively redacts nested JSON strings, including malformed JSON-like text', () => {
    const prompt = compileSolRoundContext({
      project,
      governance,
      recentLunaReportSummary: JSON.stringify({
        summary: 'safe',
        nested: { apiKey: 'nested-api-secret', values: [{ privateKey: 'nested-private-secret' }] },
      }),
      taskBook: JSON.stringify({
        task_id: 'task-json',
        details: { password: 'nested-password-secret', cookie: 'nested-cookie-secret' },
      }),
    });

    for (const secret of [
      'nested-api-secret',
      'nested-private-secret',
      'nested-password-secret',
      'nested-cookie-secret',
    ]) {
      expect(prompt).not.toContain(secret);
    }
    expect(prompt).toContain('apiKey');
    expect(prompt).toContain('password');
    expect(prompt).toContain('[REDACTED]');

    const malformedPrompt = compileSolRoundContext({
      project,
      governance,
      recentLunaReportSummary: '{"authorization":"malformed-secret","safe": }',
    });
    expect(malformedPrompt).not.toContain('malformed-secret');
    expect(malformedPrompt).toContain('authorization');
    expect(malformedPrompt).toContain('[REDACTED]');
  });

  it('parses JSON arrays and redacts nested sensitive objects deterministically', () => {
    const recentLunaReportSummary = JSON.stringify([
      {
        safe: 'preserve-me',
        credentials: 'array-credentials-secret',
        password: 'array-password-secret',
        nested: [{ privateKey: 'array-private-key-secret', authorization: 'array-authorization-secret' }],
      },
      { accessKey: 'array-access-key-secret' },
    ]);
    const input = { project, governance, recentLunaReportSummary };
    const first = compileSolRoundContext(input);
    const second = compileSolRoundContext(input);

    expect(first).toEqual(second);
    for (const secret of [
      'array-password-secret',
      'array-credentials-secret',
      'array-private-key-secret',
      'array-authorization-secret',
      'array-access-key-secret',
    ]) {
      expect(first).not.toContain(secret);
    }
    for (const key of ['credentials', 'password', 'authorization', 'privateKey', 'accessKey']) {
      expect(first).toContain(key);
    }
    expect(first).toContain('[REDACTED]');
  });

  it('compiles a separate reconciliation prompt without the removed screening sentence', () => {
    const prompt = compileSolGovernanceReconciliationPrompt({ project, baselineCommit: project.headCommit });
    expect(prompt).toContain('docs/governance');
    expect(prompt).toContain('determine which documents outside docs/governance');
    expect(prompt).toContain('GOVERNANCE_RECONCILIATION');
    expect(prompt).not.toContain('软件不会替你筛选候选文件');
    expect(prompt).not.toContain('你必须自行判断哪些文件值得检查');
    expect(prompt).toContain('JSON.parse');
    expect(prompt).toContain('return BLOCKED');
    expect(prompt).not.toContain('super-secret');
  });

  it('requires canonical-text-v1 hashes from the actual complete file content', () => {
    const prompt = compileSolGovernanceReconciliationPrompt({ project, baselineCommit: project.headCommit });

    expect(prompt).toContain('canonical-text-v1');
    expect(prompt).toContain('UTF-8');
    expect(prompt).toContain('remove all leading BOMs');
    expect(prompt).toContain('convert CRLF and CR to LF');
    expect(prompt).toContain('do not trim');
    expect(prompt).toContain('actual complete file content');
    expect(prompt).toContain('Never guess');
    expect(prompt).toContain('return BLOCKED instead of CHANGES_REQUIRED');
  });
});
