import { createHash } from 'node:crypto';
import { redactRemoteUrl } from '../project/config.js';
import type { ProjectConfig } from '../../shared/contracts/project-config.js';
import type {
  GovernanceManifest,
  GovernanceManifestDocument,
  GovernanceManifestIndex,
} from '../governance/manifest.js';
import { compareCodePoints } from '../../shared/sorting.js';
import { WRITING_BLOCK_SCHEMA_VERSION, type WritingBlockType } from '../../shared/protocol/writing-block.js';

export type { WritingBlockType } from '../../shared/protocol/writing-block.js';

export interface SolArchitectureRevision {
  id: string;
  version: string | number;
  status?: 'active' | 'candidate' | 'history';
}

export interface SolPromptInput {
  project: ProjectConfig;
  governance: GovernanceManifest | GovernanceManifestIndex;
  architectureRevisions?: SolArchitectureRevision[];
  currentPhase?: string;
  currentStatus?: string;
  recentLunaReportSummary?: string;
  recentGovernanceGaps?: string[];
  taskBook?: Record<string, unknown> | string;
}

export interface SolPromptCompilation {
  initializationPrompt: string;
  dynamicContext: string;
}

export interface GovernanceReconciliationPromptInput {
  project: ProjectConfig;
  baselineCommit: string;
}

const INITIALIZATION_TEMPLATE = `You are Sol, the product and architecture decision-maker for a local project orchestrator.

ROLE BOUNDARIES
- Sol owns product direction, top-level architecture, governance content, task decomposition, and acceptance criteria.
- Luna owns implementation details inside the approved task scope, including code structure, tests, and ordinary technical trade-offs.
- The orchestrator owns deterministic persistence, path and repository checks, versioning, commit/push gates, and state transitions.
- Luna must not change active governance or architecture rules, perform architecture freezes, or expand scope.

DEFAULT EXECUTION SEMANTICS
- Allow Luna to decide ordinary implementation details without asking Sol or the user for confirmation.
- Stop and emit BLOCKED for missing external setup, account or platform configuration, conflicting requirements, scope expansion, high-risk changes, or unsafe operations.
- A Sol round may contain zero or one LUNA_TASK, any number of GOVERNANCE_CHANGE blocks, and any number of ARCHITECTURE_FREEZE blocks.
- More than one LUNA_TASK is a protocol error; never queue or select one implicitly.
- ARCHITECTURE_FREEZE is completed by Sol and the orchestrator. Luna must not execute an architecture freeze.

WRITING BLOCK PROTOCOL
Every task book and every actionable instruction must be inside a closed block with this exact shape:
[WRITING_BLOCK type="LUNA_TASK"]
field: value
[/WRITING_BLOCK]
Allowed types: LUNA_TASK, GOVERNANCE_CHANGE, GOVERNANCE_RECONCILIATION, ARCHITECTURE_FREEZE, BLOCKED.
LUNA_TASK requires task_id, title, objective, base_commit, scope, out_of_scope, deliverables, validation_commands, governance_revision, architecture_revision_set, report_path, and remote_sync_policy.
GOVERNANCE_CHANGE requires change_id, operation, document_id, path, reason, risk_level, affected_agents, and content.
ARCHITECTURE_FREEZE requires freeze_id, version, download_url, sha256_if_known, reason, affected_scope, and luna_follow_up.
GOVERNANCE_RECONCILIATION is reserved for the explicit governance consistency check and requires a status of PASS, CHANGES_REQUIRED, or BLOCKED. CHANGES_REQUIRED must include the current baseline commit and complete replacement text for each selected external file.
Do not put a task book outside a WRITING_BLOCK. Keep unknown extension fields intact.

SAFETY AND GOVERNANCE
- The only authoritative governance entry point is docs/governance. Read governance rules from that directory and do not infer active governance from file names or other directories.
- External documents are checked only during an explicit GOVERNANCE_RECONCILIATION request.
- Distinguish active, candidate, and history documents. Candidate and history are context, not active authority.
- Normal governance updates may be applied by the orchestrator; high-risk updates remain candidates and block dependent work.
- Report assumptions, decisions, changes, tests, governance gaps, and blockers in the requested report path.
- The orchestrator performs the final commit and remote synchronization; never request a force operation.
- Do not include credentials or private authentication data in prompts, reports, logs, or notifications.

OUTPUT RULE
Return actionable work only through valid WRITING_BLOCK blocks. Include no more than one LUNA_TASK in a round. Multiple governance changes and architecture freezes are allowed and must remain separate blocks.

The following project snapshot is authoritative for this initialization:`;

const GOVERNANCE_RECONCILIATION_TEMPLATE = `You are Sol performing a governance consistency check for the project.

AUTHORITATIVE GOVERNANCE
- The only authoritative governance entry point is docs/governance.
- Inspect the project repository and determine which documents outside docs/governance could affect development behavior, Agent behavior, Git workflow, testing, security, or architecture constraints.
- Ordinary feature descriptions and business documentation that do not impose development constraints do not need changes.

REQUIRED OUTPUT
- Do not publish a Luna task.
- Do not output GOVERNANCE_CHANGE or ARCHITECTURE_FREEZE blocks.
- Do not modify the repository directly.
- If there are no conflicts, return exactly one GOVERNANCE_RECONCILIATION block with status PASS.
- If conflicts exist, return exactly one GOVERNANCE_RECONCILIATION block with status CHANGES_REQUIRED. For every file that needs an update, preserve all non-conflicting content and provide the complete replacement text, not a diff or excerpt. Include the current file SHA-256 and the current project commit.
- If the repository cannot be inspected or the conflict cannot be safely resolved, return exactly one GOVERNANCE_RECONCILIATION block with status BLOCKED and a reason.

Use only the closed WRITING_BLOCK protocol. The current project baseline is authoritative:`;

const SENSITIVE_KEY_PATTERN =
  /(?:cookie|password|token|secret|credentials?|private[_-]?key|authorization|access[_-]?key|api[_-]?key|auth)/i;

function sanitizeText(value: string): string {
  return value
    .replace(/([a-z][a-z\d+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1[REDACTED]@')
    .replace(
      /([?&](?:token|password|secret|cookie|key|auth|credentials?|private[_-]?key|authorization|access[_-]?key)[^=]*=)[^&\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(?:bearer|basic)\s+[a-z0-9+/=_-]+/gi, '[REDACTED-CREDENTIAL]')
    .replace(/\b(?:ghp|github_pat|xoxb|xoxp|sk)-[a-z0-9_-]+\b/gi, '[REDACTED-CREDENTIAL]')
    .replace(
      /\b(?:[a-z\d_-]*?(?:cookie|password|token|secret|credentials?|private[_-]?key|authorization|access[_-]?key|api[_-]?key|auth)[a-z\d_-]*)\s*[:=]\s*(?!\[REDACTED(?:-CREDENTIAL)?\])[^\s,;]+/gi,
      (match) => `${match.split(/\s*[:=]\s*/)[0]}: [REDACTED]`,
    )
    .replace(/"([^"\\]*(?:\\.[^"\\]*)*)"\s*:\s*("(?:\\.|[^"\\])*"|[^\s,}\]]+)/gi, (match, key: string) =>
      SENSITIVE_KEY_PATTERN.test(key) ? `"${key}": "[REDACTED]"` : match,
    );
}

const NOT_JSON_CONTAINER = Symbol('not-json-container');

function parseJsonContainerString(value: string): Record<string, unknown> | unknown[] | typeof NOT_JSON_CONTAINER {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) || Array.isArray(parsed) ? parsed : NOT_JSON_CONTAINER;
  } catch {
    return NOT_JSON_CONTAINER;
  }
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const parsed = parseJsonContainerString(value);
    return parsed === NOT_JSON_CONTAINER ? sanitizeText(value) : sanitizeValue(parsed);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([key, child]) => [key, SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizeValue(child)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sanitizeValue(value));
}

function documentsFrom(governance: GovernanceManifest | GovernanceManifestIndex): GovernanceManifestDocument[] {
  if (Array.isArray((governance as GovernanceManifestIndex).all)) {
    return (governance as GovernanceManifestIndex).all;
  }
  return (governance as GovernanceManifest).documents;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function governanceVersion(governance: GovernanceManifest | GovernanceManifestIndex): string | number {
  return 'version' in governance ? governance.version : 1;
}

function governanceExtensions(governance: GovernanceManifest | GovernanceManifestIndex): Record<string, unknown> {
  const extensions = (governance as GovernanceManifestIndex).extensions;
  if (isRecord(extensions)) {
    return extensions;
  }
  if ('version' in governance) {
    return Object.fromEntries(Object.entries(governance).filter(([key]) => key !== 'version' && key !== 'documents'));
  }
  return {};
}

function manifestIndex(governance: GovernanceManifest | GovernanceManifestIndex): GovernanceManifestIndex {
  if (Array.isArray((governance as GovernanceManifestIndex).all)) {
    return governance as GovernanceManifestIndex;
  }
  const all = documentsFrom(governance);
  return {
    version: governanceVersion(governance),
    extensions: governanceExtensions(governance),
    all,
    active: all.filter((document) => document.status === 'active'),
    candidate: all.filter((document) => document.status === 'candidate'),
    history: all.filter((document) => document.status === 'history'),
    byId: new Map(all.map((document) => [document.id, document])),
  };
}

function formatDocuments(label: string, documents: GovernanceManifestDocument[]): string {
  return `${label}: ${stableJson(documents)}`;
}

function formatArchitecture(revisions: SolArchitectureRevision[]): string {
  return `architecture_revisions: ${stableJson(revisions)}`;
}

function formatFieldValue(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = parseJsonContainerString(value);
    return parsed === NOT_JSON_CONTAINER ? sanitizeText(value) : stableJson(parsed);
  }
  return stableJson(value);
}

function taskBookFields(value: Record<string, unknown> | string): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  const parsed = parseJsonContainerString(value);
  return { task_book: parsed === NOT_JSON_CONTAINER ? value : parsed };
}

export function compileWritingBlock(type: WritingBlockType, fields: Record<string, unknown>): string {
  const body = Object.entries({ schema_version: WRITING_BLOCK_SCHEMA_VERSION, ...fields })
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([key, value]) => `${key}: ${formatFieldValue(value)}`)
    .join('\n');
  return `[WRITING_BLOCK type="${type}"]\n${body}\n[/WRITING_BLOCK]`;
}

export class SolPromptCompiler {
  compile(input: SolPromptInput): SolPromptCompilation {
    const index = manifestIndex(input.governance);
    const remoteUrl = redactRemoteUrl(input.project.remoteUrl);
    const architectureRevisions = input.architectureRevisions ?? [];
    const dynamicContext = [
      'PROJECT SNAPSHOT',
      `project_id: ${sanitizeText(input.project.projectId)}`,
      `local_path: ${sanitizeText(input.project.localPath)}`,
      `remote_url: ${sanitizeText(remoteUrl ?? '[none]')}`,
      `target_branch: ${sanitizeText(input.project.targetBranch)}`,
      `report_directory: ${sanitizeText(input.project.reportDirectory)}`,
      `current_branch: ${sanitizeText(input.project.currentBranch)}`,
      `current_commit: ${sanitizeText(input.project.headCommit)}`,
      `governance_manifest: ${sanitizeText(input.project.governanceManifestPath)}`,
      `governance_version: ${sanitizeText(String(index.version))}`,
      `governance_extensions: ${stableJson(index.extensions)}`,
      formatDocuments('governance_active', index.active),
      formatDocuments('governance_candidate', index.candidate),
      formatDocuments('governance_history', index.history),
      formatArchitecture(architectureRevisions),
      `current_phase: ${sanitizeText(input.currentPhase ?? 'INITIALIZATION')}`,
      `current_status: ${sanitizeText(input.currentStatus ?? 'IDLE')}`,
      `recent_luna_report_summary: ${formatFieldValue(input.recentLunaReportSummary ?? '[none]')}`,
      `recent_governance_gaps: ${stableJson(input.recentGovernanceGaps ?? [])}`,
      ...(input.taskBook === undefined ? [] : ['', compileWritingBlock('LUNA_TASK', taskBookFields(input.taskBook))]),
    ].join('\n');
    const initializationPrompt = `${INITIALIZATION_TEMPLATE}\n\n${dynamicContext}`;
    return { initializationPrompt, dynamicContext };
  }

  compileInitializationPrompt(input: SolPromptInput): string {
    return this.compile(input).initializationPrompt;
  }

  compileRoundContext(input: SolPromptInput): string {
    return this.compile(input).dynamicContext;
  }

  compileGovernanceReconciliationPrompt(input: GovernanceReconciliationPromptInput): string {
    const remoteUrl = redactRemoteUrl(input.project.remoteUrl);
    return `${GOVERNANCE_RECONCILIATION_TEMPLATE}\n\nPROJECT\nproject_id: ${sanitizeText(input.project.projectId)}\nremote_url: ${sanitizeText(remoteUrl ?? '[none]')}\ntarget_branch: ${sanitizeText(input.project.targetBranch)}\ncurrent_branch: ${sanitizeText(input.project.currentBranch)}\ncurrent_commit: ${sanitizeText(input.baselineCommit)}\ngovernance_root: docs/governance\n`;
  }
}

export function compileSolInitializationPrompt(input: SolPromptInput): string {
  return new SolPromptCompiler().compileInitializationPrompt(input);
}

export function compileSolRoundContext(input: SolPromptInput): string {
  return new SolPromptCompiler().compileRoundContext(input);
}

export function compileSolGovernanceReconciliationPrompt(input: GovernanceReconciliationPromptInput): string {
  return new SolPromptCompiler().compileGovernanceReconciliationPrompt(input);
}

export function hashSolPrompt(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}
