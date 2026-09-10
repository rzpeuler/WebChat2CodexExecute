import { describe, expect, it } from 'vitest';
import { indexGovernanceManifest } from '../../src/main/governance/manifest.js';
import { compileSolInitializationPrompt, SolPromptCompiler } from '../../src/main/sol/prompt-compiler.js';
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
    expect(first.initializationPrompt).toContain('current_commit: 0123456789012345678901234567890123456789');
    expect(first.initializationPrompt).toContain('governance_active');
    expect(first.initializationPrompt).toContain('governance_candidate');
    expect(first.initializationPrompt).toContain('governance_history');
    expect(first.initializationPrompt).toContain('architecture_revisions');
    expect(first.initializationPrompt).toContain('[WRITING_BLOCK type="LUNA_TASK"]');
    expect(first.initializationPrompt).toContain('ARCHITECTURE_FREEZE');
    expect(first.initializationPrompt).toContain('Luna must not execute an architecture freeze');
    expect(first.dynamicContext).toContain('[WRITING_BLOCK type="LUNA_TASK"]');
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

    expect(prompt).not.toContain('super-secret');
    expect(prompt).not.toContain('never-log');
    expect(prompt).not.toContain('hidden-value');
    expect(prompt).not.toContain('ghp_very-secret-value');
    expect(prompt).toContain('[REDACTED]');
    expect(prompt).toContain('[WRITING_BLOCK type="LUNA_TASK"]');
    expect(prompt).toContain('More than one LUNA_TASK is a protocol error');
    expect(prompt).toContain('Multiple governance changes and architecture freezes are allowed');
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
    const prompt = compileSolInitializationPrompt({
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
    const prompt = compileSolInitializationPrompt({
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
    expect(prompt).toContain('"apiKey":"[REDACTED]"');
    expect(prompt).toContain('"password":"[REDACTED]"');

    const malformedPrompt = compileSolInitializationPrompt({
      project,
      governance,
      recentLunaReportSummary: '{"authorization":"malformed-secret","safe": }',
    });
    expect(malformedPrompt).not.toContain('malformed-secret');
    expect(malformedPrompt).toContain('"authorization": "[REDACTED]"');
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
    const first = compileSolInitializationPrompt(input);
    const second = compileSolInitializationPrompt(input);

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
    expect(first).toContain('"credentials":"[REDACTED]"');
    expect(first).toContain('"password":"[REDACTED]"');
    expect(first).toContain('"nested":[{"authorization":"[REDACTED]","privateKey":"[REDACTED]"}]');
    expect(first).toContain('"accessKey":"[REDACTED]"');
  });
});
