import { createHash } from 'node:crypto';
import { redactRemoteUrl } from '../project/config.js';
import type { ProjectConfig } from '../../shared/contracts/project-config.js';
import type {
  GovernanceManifest,
  GovernanceManifestDocument,
  GovernanceManifestIndex,
} from '../governance/manifest.js';

export type WritingBlockType = 'LUNA_TASK' | 'GOVERNANCE_CHANGE' | 'ARCHITECTURE_FREEZE' | 'BLOCKED';

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
  taskBook?: Record<string, unknown>;
}

export interface SolPromptCompilation {
  initializationPrompt: string;
  dynamicContext: string;
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
Allowed types: LUNA_TASK, GOVERNANCE_CHANGE, ARCHITECTURE_FREEZE, BLOCKED.
LUNA_TASK requires task_id, title, objective, base_commit, scope, out_of_scope, deliverables, validation_commands, governance_revision, architecture_revision_set, report_path, and remote_sync_policy.
GOVERNANCE_CHANGE requires change_id, operation, document_id, path, reason, risk_level, affected_agents, and content.
ARCHITECTURE_FREEZE requires freeze_id, version, download_url, sha256_if_known, reason, affected_scope, and luna_follow_up.
Do not put a task book outside a WRITING_BLOCK. Keep unknown extension fields intact.

SAFETY AND GOVERNANCE
- Use only the project path and registered in-project documents supplied below.
- Distinguish active, candidate, and history documents. Candidate and history are context, not active authority.
- Normal governance updates may be applied by the orchestrator; high-risk updates remain candidates and block dependent work.
- Report assumptions, decisions, changes, tests, governance gaps, and blockers in the requested report path.
- The orchestrator performs the final commit and remote synchronization; never request a force operation.
- Do not include credentials or private authentication data in prompts, reports, logs, or notifications.

OUTPUT RULE
Return actionable work only through valid WRITING_BLOCK blocks. Include no more than one LUNA_TASK in a round. Multiple governance changes and architecture freezes are allowed and must remain separate blocks.

The following project snapshot is authoritative for this initialization:`;

function sanitizeText(value: string): string {
  return value
    .replace(/([a-z][a-z\d+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:token|password|secret|cookie|key|auth)[^=]*=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:bearer|basic)\s+[a-z0-9+/=_-]+/gi, '[REDACTED-CREDENTIAL]')
    .replace(/\b(?:ghp|github_pat|xoxb|xoxp|sk)-[a-z0-9_-]+\b/gi, '[REDACTED-CREDENTIAL]')
    .replace(
      /\b(?:[a-z\d_-]*?(?:token|password|cookie|secret|api[_-]?key)[a-z\d_-]*)\s*[:=]\s*[^\s,;]+/gi,
      (match) => `${match.split(/\s*[:=]\s*/)[0]}: [REDACTED]`,
    );
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeText(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sanitizeValue(child)]),
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

function manifestIndex(governance: GovernanceManifest | GovernanceManifestIndex): GovernanceManifestIndex {
  if (Array.isArray((governance as GovernanceManifestIndex).all)) {
    return governance as GovernanceManifestIndex;
  }
  const all = documentsFrom(governance);
  return {
    all,
    active: all.filter((document) => document.status === 'active'),
    candidate: all.filter((document) => document.status === 'candidate'),
    history: all.filter((document) => document.status === 'history'),
    byId: new Map(all.map((document) => [document.id, document])),
  };
}

function formatDocuments(label: string, documents: GovernanceManifestDocument[]): string {
  const entries = documents.map((document) => ({
    id: document.id,
    path: document.path,
    audience: document.audience,
    version: document.version,
    status: document.status,
    ...(typeof document.type === 'string' ? { type: document.type } : {}),
  }));
  return `${label}: ${stableJson(entries)}`;
}

function formatArchitecture(revisions: SolArchitectureRevision[]): string {
  return `architecture_revisions: ${stableJson(revisions)}`;
}

export function compileWritingBlock(type: WritingBlockType, fields: Record<string, unknown>): string {
  const body = Object.entries(fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? sanitizeText(value) : stableJson(value)}`)
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
      formatDocuments('governance_active', index.active),
      formatDocuments('governance_candidate', index.candidate),
      formatDocuments('governance_history', index.history),
      formatArchitecture(architectureRevisions),
      `current_phase: ${sanitizeText(input.currentPhase ?? 'INITIALIZATION')}`,
      `current_status: ${sanitizeText(input.currentStatus ?? 'IDLE')}`,
      `recent_luna_report_summary: ${sanitizeText(input.recentLunaReportSummary ?? '[none]')}`,
      `recent_governance_gaps: ${stableJson(input.recentGovernanceGaps ?? [])}`,
      ...(input.taskBook === undefined ? [] : ['', compileWritingBlock('LUNA_TASK', input.taskBook)]),
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
}

export function compileSolInitializationPrompt(input: SolPromptInput): string {
  return new SolPromptCompiler().compileInitializationPrompt(input);
}

export function compileSolRoundContext(input: SolPromptInput): string {
  return new SolPromptCompiler().compileRoundContext(input);
}

export function hashSolPrompt(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}
