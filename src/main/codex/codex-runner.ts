import { appendFile, access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { LunaTaskBlock, LunaTestStatus } from '../../shared/protocol/writing-block.js';
import { assertSafeProjectPath, realProjectRoot } from '../security/path-safety.js';
import { AtomicJsonFileStore } from '../state/persistence.js';
import { redactRemoteUrl } from '../project/config.js';
import {
  CodexRunnerError,
  type CodexCapabilities,
  type CodexExecFile,
  type CodexExecFileResult,
  type CodexExecutionConfig,
  type CodexOutput,
  type CodexProcess,
  type CodexProcessRunner,
  type CodexRepositorySnapshot,
  type CodexReasoningEffort,
  type CodexRunnerOptions,
  type CodexRunResult,
  type CodexSessionHandle,
  type CodexSessionRecord,
  type CodexSessionResult,
  type CodexSessionState,
  type CodexSnapshots,
  type CodexTaskHandle,
  type CodexTaskInput,
  type ScopeReviewResult,
  type GitStateCheckResult,
  type LunaProtocolResult,
  type LunaTestResult,
  type SessionHandoff,
} from './types.js';

const defaultExecFileCallback = promisify(execFileCallback);
const DEFAULT_MODEL = 'gpt-5.6-luna';
const DEFAULT_REASONING_EFFORT: CodexReasoningEffort = 'medium';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_STREAM_LOG_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const PROTECTED_PATHS = ['docs/superpowers', 'docs/superpowers/'];
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function codexExecutableCandidates(
  env: NodeJS.ProcessEnv = process.env,
  versionDirectories: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== 'win32') return [];
  const candidates: string[] = [];
  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData) {
    const binDirectory = join(localAppData, 'OpenAI', 'Codex', 'bin');
    for (const versionDirectory of versionDirectories) {
      candidates.push(join(binDirectory, versionDirectory, 'codex.exe'));
    }
    candidates.push(join(binDirectory, 'codex.exe'));
  }
  const userProfile = env.USERPROFILE?.trim();
  if (userProfile) candidates.push(join(userProfile, '.local', 'bin', 'codex.exe'));
  const appData = env.APPDATA?.trim();
  if (appData) candidates.push(join(appData, 'npm', 'codex.exe'));
  return [...new Set(candidates)];
}

function redact(value: string): string {
  return value
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi, 'https://[REDACTED]@')
    .replace(/([?&](?:token|password|secret|key|auth)[^=]*=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(
      /(["']?(?:token|password|secret|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^"',}\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(?:token|password|secret|api[_-]?key)\s*=\s*[^\s]+/gi, (match) => `${match.split('=')[0]}=[REDACTED]`)
    .replace(/(bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .trim()
    .slice(0, 3000);
}

function isSecretKey(key: string): boolean {
  return /(?:token|password|secret|api[_-]?key|authorization|credential)/i.test(key);
}

function redactUnknown(value: unknown, key = '', depth = 0): unknown {
  if (depth > 8) return '[REDACTED_DEPTH]';
  if (isSecretKey(key)) return '[REDACTED]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, '', depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, redactUnknown(child, childKey, depth + 1)]),
    );
  }
  return value;
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    if (typeof record[name] === 'string' && record[name].trim() !== '') return record[name].trim();
  }
  return null;
}

function statusValue(value: unknown): LunaProtocolResult['status'] | null {
  return value === 'COMPLETED' || value === 'BLOCKED_EXTERNAL_SETUP' || value === 'FAILED' ? value : null;
}

interface ParsedTests {
  tests: LunaTestResult[] | null;
  diagnostic: string | null;
}

function parseTests(value: unknown): ParsedTests {
  if (!Array.isArray(value) || value.length === 0)
    return { tests: null, diagnostic: 'tests must be a non-empty array of result objects' };
  const tests: LunaTestResult[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item))
      return { tests: null, diagnostic: `tests[${index}] must be an object, not a string or other scalar` };
    const unknownKeys = Object.keys(item).filter((key) => key !== 'command' && key !== 'status');
    if (unknownKeys.length > 0)
      return { tests: null, diagnostic: `tests[${index}] contains unsupported fields: ${unknownKeys.join(', ')}` };
    if (item.status !== 'PASSED' && item.status !== 'FAILED' && item.status !== 'NOT_RUN')
      return {
        tests: null,
        diagnostic: `tests[${index}].status must be one of PASSED, FAILED, NOT_RUN`,
      };
    if (item.command !== undefined && (typeof item.command !== 'string' || item.command.trim() === ''))
      return { tests: null, diagnostic: `tests[${index}].command must be a non-empty string when present` };
    tests.push({
      ...(item.command === undefined ? {} : { command: item.command }),
      status: item.status,
    });
  }
  return { tests, diagnostic: null };
}

function aggregateTestsStatus(tests: LunaTestResult[]): LunaTestStatus {
  if (tests.some((test) => test.status === 'FAILED')) return 'FAILED';
  if (tests.length === 0 || tests.some((test) => test.status === 'NOT_RUN')) return 'NOT_RUN';
  return 'PASSED';
}

function testsStatusValue(value: unknown): LunaTestStatus | null {
  return value === 'PASSED' || value === 'FAILED' || value === 'NOT_RUN' ? value : null;
}

interface ProtocolParseOutcome {
  result: LunaProtocolResult | null;
  diagnostic: string | null;
}

function protocolFromRecord(value: unknown): ProtocolParseOutcome {
  if (!isRecord(value) || value.identifier !== 'LUNA_RESULT') return { result: null, diagnostic: null };
  const status = statusValue(value.status);
  const reportPath = stringField(value, 'report_path');
  const summary = stringField(value, 'summary');
  const parsedTests = parseTests(value.tests);
  const testsStatus = value.tests_status === undefined ? null : testsStatusValue(value.tests_status);
  if (status === null)
    return { result: null, diagnostic: 'status must be one of COMPLETED, BLOCKED_EXTERNAL_SETUP, FAILED' };
  if (reportPath === null) return { result: null, diagnostic: 'report_path must be a non-empty string' };
  if (summary === null) return { result: null, diagnostic: 'summary must be a non-empty string' };
  if (parsedTests.tests === null) return { result: null, diagnostic: parsedTests.diagnostic };
  if (value.tests_status !== undefined && testsStatus === null)
    return { result: null, diagnostic: 'tests_status must be one of PASSED, FAILED, NOT_RUN' };
  if (value.assumptions !== undefined && !Array.isArray(value.assumptions))
    return { result: null, diagnostic: 'assumptions must be an array when present' };
  if (value.changes !== undefined && !Array.isArray(value.changes))
    return { result: null, diagnostic: 'changes must be an array when present' };
  if (value.governance_gaps !== undefined && !Array.isArray(value.governance_gaps))
    return { result: null, diagnostic: 'governance_gaps must be an array when present' };
  const derivedTestsStatus = aggregateTestsStatus(parsedTests.tests);
  if (testsStatus !== null && testsStatus !== derivedTestsStatus)
    return {
      result: null,
      diagnostic: `tests_status=${testsStatus} does not match the tests[] aggregate ${derivedTestsStatus}`,
    };
  return {
    result: {
      identifier: 'LUNA_RESULT',
      status,
      summary,
      reportPath,
      tests: parsedTests.tests,
      testsStatus: testsStatus ?? derivedTestsStatus,
      ...(Array.isArray(value.assumptions) ? { assumptions: value.assumptions } : {}),
      ...(Array.isArray(value.changes) ? { changes: value.changes } : {}),
      ...(Array.isArray(value.governance_gaps) ? { governanceGaps: value.governance_gaps } : {}),
    },
    diagnostic: null,
  };
}

function parseJsonLines(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) events.push(redactUnknown(parsed) as Record<string, unknown>);
    } catch {
      // Non-JSON diagnostics remain in the bounded stream summary only.
    }
  }
  return events;
}

function findProtocol(
  stdout: string,
  lastMessage: string,
  events: Record<string, unknown>[],
): { result: LunaProtocolResult | null; diagnostic: string | null } {
  const eventOutcomes = events.map(protocolFromRecord);
  const eventCandidates = eventOutcomes
    .map((outcome) => outcome.result)
    .filter((value): value is LunaProtocolResult => value !== null);
  const invalidEventDiagnostic = eventOutcomes.find((outcome) => outcome.diagnostic !== null)?.diagnostic ?? null;
  const hasFreeFormTextMarker = stdout.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('{') && /\bLUNA_RESULT\b/.test(trimmed);
  });
  const candidates = [...eventCandidates];
  let lastCandidate: LunaProtocolResult | null = null;
  let lastDiagnostic: string | null = null;
  try {
    const parsed: unknown = JSON.parse(lastMessage);
    const outcome = protocolFromRecord(parsed);
    lastDiagnostic = outcome.diagnostic;
    if (outcome.result !== null) {
      lastCandidate = outcome.result;
      candidates.push(outcome.result);
    }
  } catch {
    // Free-form marker text is deliberately rejected.
  }
  if (hasFreeFormTextMarker && eventCandidates.length === 0 && lastCandidate !== null)
    return { result: null, diagnostic: 'LUNA_RESULT was emitted in text output instead of a single JSON result' };
  if (candidates.length === 1) return { result: candidates[0]!, diagnostic: null };
  if (candidates.length > 1) return { result: null, diagnostic: 'LUNA_RESULT is duplicated' };
  return { result: null, diagnostic: lastDiagnostic ?? invalidEventDiagnostic ?? 'LUNA_RESULT is missing or invalid' };
}

async function defaultExecFile(
  file: string,
  args: readonly string[],
  options: { cwd?: string; shell: false; windowsHide: boolean },
): Promise<CodexExecFileResult> {
  const result = await defaultExecFileCallback(file, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    shell: false,
    windowsHide: options.windowsHide,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

function defaultProcessRunner(
  file: string,
  args: readonly string[],
  options: { cwd: string; shell: false; windowsHide: boolean },
): CodexProcess {
  const child: ChildProcess = spawn(file, [...args], {
    cwd: options.cwd,
    shell: false,
    windowsHide: options.windowsHide,
    // Recent `codex exec` versions keep reading stdin when it remains open,
    // even when a prompt argument is already present. The orchestrator sends
    // the prompt as an argument, so stdin must be closed to avoid a hung Luna
    // process.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const wait = new Promise<number>((resolveWait, rejectWait) => {
    child.once('error', rejectWait);
    child.once('close', (code) => resolveWait(code ?? 1));
  });
  return {
    stdout: child.stdout === null ? '' : child.stdout,
    stderr: child.stderr === null ? '' : child.stderr,
    wait: () => wait,
    kill: () => child.kill(),
  };
}

function isSafeRelativePath(value: string): boolean {
  const normalized = normalizePath(value);
  return normalized !== '' && !isAbsolute(normalized) && normalized !== '..' && !normalized.startsWith('../');
}

function isProtectedPath(value: string): boolean {
  const normalized = normalizePath(value);
  return PROTECTED_PATHS.some((prefix) => normalized === prefix.replace(/\/$/, '') || normalized.startsWith(prefix));
}

function promptForTask(task: LunaTaskBlock, snapshots: CodexSnapshots): string {
  return JSON.stringify(
    {
      protocol: 'LUNA_TASK_EXECUTION',
      task: task.fields,
      governance_snapshot: snapshots.governance,
      architecture_snapshot: snapshots.architecture,
      instructions: {
        authorization:
          'The user and ORCHESTRATOR have already approved this task and the ordinary implementation decisions required to complete it. Do not ask the user or ORCHESTRATOR to approve an implementation plan, design refinement, brainstorming step, test strategy, or other routine decision. Treat any such approval as granted and continue execution immediately. If a planning skill or workflow asks for confirmation, do not pause for that confirmation; make a reasonable in-scope decision and keep working.',
        implementation:
          'Decide ordinary implementation details without asking for ordinary confirmation. Treat scope entries ending in /** as recursive directories; use exact relative paths for individual files. A legacy trailing slash may appear in an existing task and has the same recursive-directory meaning. For both IMPLEMENTATION and TEST tasks, scope is the planned audit set rather than an absolute file allowlist: reasonable project-internal non-protected files may be changed when required to complete the task, but report every such path in the report and result for the ORCHESTRATOR scope-review. Never touch protected, credential, governance, architecture, .git, project-outside, or task out_of_scope paths.',
        blocking:
          'Emit BLOCKED_EXTERNAL_SETUP for external credentials, project-outside paths, protected or high-risk operations, or a real task out_of_scope conflict. Do not block merely because either task kind needs a reasonable adjacent non-protected project-internal file; scope drift is reviewed by ORCHESTRATOR after execution.',
        result:
          'Write the required report and emit exactly one JSON object with identifier LUNA_RESULT, status, summary, report_path, tests_status, and tests. identifier is fixed to LUNA_RESULT. status must be exactly one of COMPLETED, BLOCKED_EXTERNAL_SETUP, or FAILED. tests_status must be exactly one of PASSED, FAILED, or NOT_RUN. tests must be a non-empty JSON array of objects; every object must contain status with exactly one of PASSED, FAILED, or NOT_RUN, may contain only command as an optional non-empty string, and must not contain any other field. Never emit tests as strings, prose, Markdown, or an empty array. tests_status must match the aggregate of tests[].status: any FAILED means FAILED; otherwise any NOT_RUN means NOT_RUN; otherwise PASSED. If the approved implementation or test work is complete and the required report is written, use COMPLETED even when tests_status is FAILED or NOT_RUN; tests are evidence for Sol/CTO acceptance and do not gate code synchronization. For an IMPLEMENTATION task, use FAILED when implementation evidence is present in the required report but the report records a real implementation or acceptance blocker; the orchestrator will sync the validated report and code for Sol/CTO review. Use FAILED for TEST only when the test task itself could not produce a valid completed result. Never use FAILED solely because a test failed. report_path must equal the task report_path.',
        test_scope:
          'When task_kind is TEST, preserve the test objective and do not intentionally expand it, but reasonable project-internal non-protected support files may be changed when required. Report every such path for ORCHESTRATOR scope-review. A failed test is evidence for Sol; do not convert it to BLOCKED or ask for approval merely because the assertion failed.',
        git: 'The orchestrator owns commit, push, amend, rebase, and force-push. Do not run any of these Git synchronization operations. Leave implementation and report changes in the worktree for the orchestrator to validate, commit, and push.',
      },
    },
    null,
    2,
  );
}

function scopePathFingerprint(paths: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([...new Set(paths.map(normalizePath))].sort()))
    .digest('hex');
}

function promptForScopeReview(
  task: LunaTaskBlock,
  snapshots: CodexSnapshots,
  driftPaths: readonly string[],
  fingerprint: string,
): string {
  return JSON.stringify(
    {
      protocol: 'LUNA_SCOPE_REVIEW',
      task: task.fields,
      governance_snapshot: snapshots.governance,
      architecture_snapshot: snapshots.architecture,
      drift_paths: [...driftPaths].map(normalizePath).sort(),
      worktree_path_fingerprint: fingerprint,
      instructions: {
        role: 'Review the completed Luna task and decide whether the exact drift paths are reasonable derived support changes for the approved objective.',
        read_only:
          'This is a read-only review. Do not edit files, create files, delete files, run formatters that modify files, commit, push, amend, rebase, or force-push.',
        decision:
          'Approve only when every listed drift path is project-internal, non-protected, directly supports the approved objective, and has LOW risk. Reject when any path is unrelated, explicitly out_of_scope, protected, high-risk, or materially expands the objective.',
        output:
          'Return exactly one JSON object with identifier SCOPE_REVIEW_RESULT, task_id, decision, reviewed_paths, approved_drift_paths, scope_relation, functional_impact, risk, tests_status, worktree_path_fingerprint, reason, and review_id. Do not return Markdown, code fences, or extra protocol objects.',
      },
    },
    null,
    2,
  );
}

function parseScopeReview(lastMessage: string, taskId: string, driftPaths: readonly string[]): ScopeReviewResult {
  let value: unknown;
  try {
    value = JSON.parse(lastMessage);
  } catch (error) {
    throw new CodexRunnerError('PROCESS_OUTPUT_FAILED', 'Scope review did not return valid JSON', {}, { cause: error });
  }
  if (!isRecord(value) || value.identifier !== 'SCOPE_REVIEW_RESULT')
    throw new CodexRunnerError('PROCESS_OUTPUT_FAILED', 'Scope review identifier is missing or invalid');
  const decision = value.decision === 'APPROVE' || value.decision === 'REJECT' ? value.decision : null;
  const reviewedPaths = Array.isArray(value.reviewed_paths)
    ? value.reviewed_paths.filter((path): path is string => typeof path === 'string').map(normalizePath)
    : null;
  const approvedDriftPaths = Array.isArray(value.approved_drift_paths)
    ? value.approved_drift_paths.filter((path): path is string => typeof path === 'string').map(normalizePath)
    : null;
  const scopeRelation =
    value.scope_relation === 'DERIVED_SUPPORT' ||
    value.scope_relation === 'WITHIN_OBJECTIVE' ||
    value.scope_relation === 'OUTSIDE_OBJECTIVE' ||
    value.scope_relation === 'UNKNOWN'
      ? value.scope_relation
      : null;
  const functionalImpact =
    value.functional_impact === 'NONE' ||
    value.functional_impact === 'WITHIN_OBJECTIVE' ||
    value.functional_impact === 'MATERIAL' ||
    value.functional_impact === 'UNKNOWN'
      ? value.functional_impact
      : null;
  const risk = value.risk === 'LOW' || value.risk === 'MEDIUM' || value.risk === 'HIGH' || value.risk === 'UNKNOWN' ? value.risk : null;
  const testsStatus = testsStatusValue(value.tests_status);
  const reviewId = stringField(value, 'review_id');
  const reason = stringField(value, 'reason');
  const returnedTaskId = stringField(value, 'task_id');
  const fingerprint = stringField(value, 'worktree_path_fingerprint');
  if (
    returnedTaskId !== taskId ||
    decision === null ||
    reviewedPaths === null ||
    approvedDriftPaths === null ||
    scopeRelation === null ||
    functionalImpact === null ||
    risk === null ||
    testsStatus === null ||
    reviewId === null ||
    reason === null ||
    fingerprint === null
  )
    throw new CodexRunnerError('PROCESS_OUTPUT_FAILED', 'Scope review returned an incomplete result');
  const expectedPaths = [...driftPaths].map(normalizePath).sort();
  const approvedPaths = [...approvedDriftPaths].sort();
  if (decision === 'APPROVE' && (approvedPaths.length !== expectedPaths.length || approvedPaths.some((path, index) => path !== expectedPaths[index])))
    throw new CodexRunnerError('PROCESS_OUTPUT_FAILED', 'Scope review approval does not cover the exact drift paths');
  return {
    identifier: 'SCOPE_REVIEW_RESULT',
    taskId: returnedTaskId,
    decision,
    reviewedPaths: [...new Set(reviewedPaths)].sort(),
    approvedDriftPaths: [...new Set(approvedDriftPaths)].sort(),
    scopeRelation,
    functionalImpact,
    risk,
    testsStatus,
    worktreePathFingerprint: fingerprint,
    reason,
    reviewId,
  };
}

function promptForHandoff(handoff: SessionHandoff, snapshots: CodexSnapshots): string {
  return JSON.stringify(
    {
      protocol: 'SESSION_HANDOFF',
      handoff,
      governance_snapshot: snapshots.governance,
      architecture_snapshot: snapshots.architecture,
    },
    null,
    2,
  );
}

function validateSessionState(value: unknown): CodexSessionState {
  if (!isRecord(value) || !Array.isArray(value.chain)) throw new Error('Invalid Codex session state');
  if (value.activeSessionId !== null && typeof value.activeSessionId !== 'string')
    throw new Error('Invalid active Codex session id');
  if (!['STARTUP', 'CREATE_STARTED', 'CREATE_COMPLETED', 'TERMINAL'].includes(String(value.lastEvent)))
    throw new Error('Invalid Codex session event');
  if (typeof value.updatedAt !== 'string' || value.updatedAt.trim() === '')
    throw new Error('Invalid session timestamp');
  return {
    chain: value.chain as CodexSessionRecord[],
    activeSessionId: value.activeSessionId,
    lastEvent: value.lastEvent as CodexSessionState['lastEvent'],
    updatedAt: value.updatedAt,
  };
}

function normalizeSnapshot(value: CodexRepositorySnapshot): {
  repositoryRoot: string | null;
  baseCommit: string | null;
  branch: string | null;
  remote: string | null;
  cleanWorktree: boolean | null;
  worktree: string[];
} {
  const record = value as Record<string, unknown>;
  const worktree = Array.isArray(value.worktree) ? value.worktree.map((path) => normalizePath(path)) : [];
  return {
    repositoryRoot: stringField(record, 'repositoryRoot')?.trim() ?? null,
    baseCommit: stringField(record, 'baseCommit', 'base_commit', 'head'),
    branch: stringField(record, 'branch'),
    remote: stringField(record, 'remote', 'remoteUrl', 'remote_url'),
    cleanWorktree:
      typeof value.cleanWorktree === 'boolean'
        ? value.cleanWorktree
        : typeof value.clean_worktree === 'boolean'
          ? value.clean_worktree
          : Array.isArray(value.worktree)
            ? worktree.length === 0
            : null,
    worktree,
  };
}

function snapshotRemote(value: string | null): string | null {
  return value === null ? null : redactRemoteUrl(value);
}

function defaultDataDirectory(): string {
  const base =
    process.platform === 'win32' ? (process.env.LOCALAPPDATA ?? process.env.APPDATA) : process.env.XDG_STATE_HOME;
  return resolve(base === undefined ? join(tmpdir(), 'web-chat2codex') : join(base, 'web-chat2codex'));
}

function snapshotMismatch(
  expected: ReturnType<typeof normalizeSnapshot>,
  actual: ReturnType<typeof normalizeSnapshot>,
): string | null {
  if (expected.repositoryRoot !== null && resolve(expected.repositoryRoot) !== resolve(actual.repositoryRoot ?? ''))
    return 'Repository root differs from the input snapshot';
  if (expected.baseCommit === null || actual.baseCommit !== expected.baseCommit)
    return 'Repository base commit differs from the input snapshot';
  if (expected.branch === null || actual.branch !== expected.branch)
    return 'Repository branch differs from the input snapshot';
  if (expected.remote === null || snapshotRemote(actual.remote) !== snapshotRemote(expected.remote))
    return 'Repository remote differs from the input snapshot';
  if (expected.cleanWorktree !== true || actual.cleanWorktree !== true) return 'Repository worktree is not clean';
  return null;
}

interface OutputCapture {
  value: string;
  error: unknown | null;
  truncated: boolean;
}

async function captureOutput(
  output: CodexOutput,
  logPath: string,
  sessionId: string,
  stream: 'stdout' | 'stderr',
  maxLogBytes: number,
): Promise<OutputCapture> {
  let value = '';
  let capturedBytes = 0;
  let logBytes = 0;
  let truncated = false;
  let error: unknown | null = null;
  const consume = async (chunk: string): Promise<void> => {
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    if (capturedBytes < MAX_CAPTURE_BYTES) {
      const remaining = MAX_CAPTURE_BYTES - capturedBytes;
      value += chunkBytes <= remaining ? chunk : Buffer.from(chunk, 'utf8').subarray(0, remaining).toString('utf8');
      capturedBytes += Math.min(chunkBytes, remaining);
      if (chunkBytes > remaining) truncated = true;
    } else truncated = true;
    if (logBytes >= maxLogBytes) {
      truncated = true;
      return;
    }
    const record = `${JSON.stringify({ timestamp: new Date().toISOString(), sessionId, stream, chunk: redact(chunk) })}\n`;
    const recordBytes = Buffer.byteLength(record, 'utf8');
    if (logBytes + recordBytes > maxLogBytes) {
      truncated = true;
      return;
    }
    try {
      await appendFile(logPath, record, { encoding: 'utf8' });
      logBytes += recordBytes;
    } catch (appendError) {
      error ??= appendError;
    }
  };
  try {
    if (typeof output === 'string') await consume(output);
    else
      for await (const chunk of output)
        await consume(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  } catch (streamError) {
    error = streamError;
  }
  return { value, error, truncated };
}

export class CodexRunner {
  private readonly execFile: CodexExecFile;
  private readonly processRunner: CodexProcessRunner;
  private readonly repositoryValidator: ((repositoryPath: string) => Promise<boolean>) | undefined;
  private readonly gitStateCheck:
    ((repositoryPath: string, task: LunaTaskBlock) => Promise<GitStateCheckResult>) | undefined;
  private readonly persistSessionChain: ((chain: CodexSessionRecord[]) => Promise<void>) | undefined;
  private readonly sessionStore:
    AtomicJsonFileStore<CodexSessionState> | NonNullable<CodexRunnerOptions['sessionStore']>;
  private readonly captureRepositorySnapshot:
    ((repositoryPath: string) => Promise<CodexRepositorySnapshot>) | undefined;
  private readonly logger: (event: string, details: Record<string, unknown>) => void;
  private readonly defaultModel: string;
  private readonly defaultReasoningEffort: CodexReasoningEffort;
  private readonly defaultTimeoutMs: number;
  private readonly streamLogDirectory: string;
  private readonly maxStreamLogBytes: number;
  private readonly sessionChain: CodexSessionRecord[] = [];
  private activeSession: { sessionId: string; process: CodexProcess | null } | null = null;
  private sessionStateLoaded = false;
  private sessionStateLoad: Promise<void> | null = null;

  constructor(options: CodexRunnerOptions = {}) {
    this.execFile = options.execFile ?? defaultExecFile;
    this.processRunner = options.processRunner ?? defaultProcessRunner;
    this.repositoryValidator = options.repositoryValidator;
    this.gitStateCheck = options.gitStateCheck;
    this.persistSessionChain = options.persistSessionChain;
    this.captureRepositorySnapshot = options.captureRepositorySnapshot;
    this.logger = options.logger ?? (() => undefined);
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL;
    this.defaultReasoningEffort = options.defaultReasoningEffort ?? DEFAULT_REASONING_EFFORT;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const dataDirectory = defaultDataDirectory();
    this.streamLogDirectory = resolve(options.streamLogDirectory ?? join(dataDirectory, 'streams'));
    this.maxStreamLogBytes = Math.max(1, options.maxStreamLogBytes ?? DEFAULT_STREAM_LOG_BYTES);
    this.sessionStore =
      options.sessionStore ??
      new AtomicJsonFileStore<CodexSessionState>(
        resolve(options.sessionStorePath ?? join(dataDirectory, 'session-chain.json')),
        { validate: validateSessionState },
      );
  }

  getSessionChain(): CodexSessionRecord[] {
    return this.sessionChain.map((record) => ({
      ...record,
      handoff: {
        ...record.handoff,
        completedTasks: [...record.handoff.completedTasks],
        unresolvedIssues: [...record.handoff.unresolvedIssues],
      },
    }));
  }

  async checkCapabilities(input: {
    repositoryPath: string;
    model?: string;
    executablePath?: string;
  }): Promise<CodexCapabilities> {
    const repositoryPath = await this.assertTargetRepository(input.repositoryPath);
    const executablePath = await this.resolveExecutable(input.executablePath);
    const version = await this.probe(executablePath, ['--version'], 'CLI_VERSION_UNAVAILABLE');
    if (version.stdout.trim() === '')
      throw new CodexRunnerError('CLI_VERSION_UNAVAILABLE', 'Codex CLI returned an empty version');
    const authProbe = await this.probe(executablePath, ['login', 'status'], 'CLI_AUTH_UNAVAILABLE');
    if (!this.isAuthenticated(authProbe))
      throw new CodexRunnerError('CLI_AUTH_UNAVAILABLE', 'Codex CLI did not report an authenticated status', {
        stdout: redact(authProbe.stdout),
        stderr: redact(authProbe.stderr),
      });
    const model = input.model?.trim() || this.defaultModel;
    if (!MODEL_ID_PATTERN.test(model))
      throw new CodexRunnerError('CLI_MODEL_UNAVAILABLE', 'Codex model id is invalid', { model });
    // Recent Codex CLI versions no longer expose `models --json`. Validate the
    // exact non-interactive execution entrypoint instead. The `--help` probe
    // does not start a model run or consume a task, while a real entitlement
    // failure is still reported by the subsequent `codex exec` process.
    await this.probe(
      executablePath,
      ['exec', '--model', model, '--config', `model_reasoning_effort=${this.defaultReasoningEffort}`, '--help'],
      'CLI_MODEL_UNAVAILABLE',
    );
    const execution: CodexExecutionConfig = {
      model,
      reasoningEffort: this.defaultReasoningEffort,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    };
    const capabilities: CodexCapabilities = {
      executablePath,
      version: redact(version.stdout),
      authenticated: true,
      authStatus: 'AUTHENTICATED',
      model,
      modelAvailable: true,
      targetRepository: repositoryPath,
      execution,
    };
    this.logger('codex-capabilities', {
      ...capabilities,
      executablePath: '<configured>',
      targetRepository: '<project>',
    });
    return capabilities;
  }

  async startTask(input: CodexTaskInput): Promise<CodexTaskHandle> {
    const sessionId = randomUUID();
    let reserved = false;
    let outputDirectory: string | undefined;
    try {
      this.assertParsedTask(input.task);
      await this.beginSession(sessionId);
      reserved = true;
      const expected = await this.verifyTaskBaseline(input);
      const capabilities = await this.checkCapabilities({
        repositoryPath: input.repositoryPath,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.executablePath === undefined ? {} : { executablePath: input.executablePath }),
      });
      outputDirectory = await mkdtemp(join(tmpdir(), 'web-chat2codex-luna-'));
      await mkdir(this.streamLogDirectory, { recursive: true });
      const lastMessagePath = join(outputDirectory, 'last-message.txt');
      const stdoutLogPath = join(this.streamLogDirectory, `${sessionId}.stdout.jsonl`);
      const stderrLogPath = join(this.streamLogDirectory, `${sessionId}.stderr.jsonl`);
      const args = this.execArgs(capabilities.execution, lastMessagePath, promptForTask(input.task, input.snapshots));
      let process: CodexProcess;
      try {
        process = await this.processRunner(capabilities.executablePath, args, {
          cwd: capabilities.targetRepository,
          shell: false,
          windowsHide: true,
        });
      } catch (error) {
        throw new CodexRunnerError('PROCESS_SPAWN_FAILED', 'Codex process could not be started', {}, { cause: error });
      }
      this.activeSession = { sessionId, process };
      try {
        await this.persistSessionState('CREATE_COMPLETED', sessionId);
      } catch (error) {
        try {
          process.kill?.();
        } catch (killError) {
          this.logger('codex-process-kill-failed', { error: redact(String(killError)) });
        }
        throw new CodexRunnerError(
          'SESSION_PERSISTENCE_UNAVAILABLE',
          'Could not persist Codex session startup',
          {},
          { cause: error },
        );
      }
      const result = this.finishTask(process, {
        sessionId,
        task: input.task,
        repositoryPath: capabilities.targetRepository,
        expectedSnapshot: expected,
        lastMessagePath,
        outputDirectory,
        execution: capabilities.execution,
        timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
        stdoutLogPath,
        stderrLogPath,
      });
      return { sessionId, status: 'RUNNING', result };
    } catch (error) {
      if (outputDirectory !== undefined)
        await rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (reserved) await this.endSession(sessionId);
      return { sessionId, status: 'FAILED', result: Promise.resolve(this.taskFailureResult(input, sessionId, error)) };
    }
  }

  async runTask(input: CodexTaskInput): Promise<CodexRunResult> {
    const handle = await this.startTask(input);
    return handle.result;
  }

  async runScopeReview(input: {
    task: LunaTaskBlock;
    snapshots: CodexSnapshots;
    repositoryPath: string;
    baselineSnapshot?: CodexRepositorySnapshot;
    driftPaths: string[];
    model?: string;
    executablePath?: string;
    timeoutMs?: number;
  }): Promise<ScopeReviewResult> {
    const sessionId = randomUUID();
    let reserved = false;
    let outputDirectory: string | undefined;
    try {
      await this.beginSession(sessionId);
      reserved = true;
      const expected = normalizeSnapshot(input.baselineSnapshot ?? input.snapshots.git ?? {});
      const before = normalizeSnapshot(await this.captureSnapshot(input.repositoryPath));
      if (
        (expected.repositoryRoot !== null && resolve(expected.repositoryRoot) !== resolve(before.repositoryRoot ?? '')) ||
        expected.baseCommit !== before.baseCommit ||
        expected.branch !== before.branch ||
        snapshotRemote(expected.remote) !== snapshotRemote(before.remote)
      )
        throw new CodexRunnerError('BASELINE_CHANGED', 'Scope review baseline changed before review');
      const beforePaths = [...before.worktree].sort();
      const expectedDriftPaths = [...new Set(input.driftPaths.map(normalizePath))].sort();
      if (!expectedDriftPaths.every((path) => beforePaths.includes(path)))
        throw new CodexRunnerError('BASELINE_CHANGED', 'Scope review drift paths are not present in the current worktree');
      const capabilities = await this.checkCapabilities({
        repositoryPath: input.repositoryPath,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.executablePath === undefined ? {} : { executablePath: input.executablePath }),
      });
      outputDirectory = await mkdtemp(join(tmpdir(), 'web-chat2codex-scope-review-'));
      await mkdir(this.streamLogDirectory, { recursive: true });
      const lastMessagePath = join(outputDirectory, 'last-message.txt');
      const stdoutLogPath = join(this.streamLogDirectory, `${sessionId}.stdout.jsonl`);
      const stderrLogPath = join(this.streamLogDirectory, `${sessionId}.stderr.jsonl`);
      const fingerprint = scopePathFingerprint(expectedDriftPaths);
      const execution = { ...capabilities.execution, sandbox: 'read-only' };
      const args = this.execArgs(execution, lastMessagePath, promptForScopeReview(input.task, input.snapshots, expectedDriftPaths, fingerprint));
      let process: CodexProcess;
      try {
        process = await this.processRunner(capabilities.executablePath, args, {
          cwd: capabilities.targetRepository,
          shell: false,
          windowsHide: true,
        });
      } catch (error) {
        throw new CodexRunnerError('PROCESS_SPAWN_FAILED', 'Scope review Codex process could not be started', {}, { cause: error });
      }
      this.activeSession = { sessionId, process };
      await this.persistSessionState('CREATE_COMPLETED', sessionId);
      const sessionResult = await this.finishSession(
        process,
        sessionId,
        lastMessagePath,
        input.timeoutMs ?? this.defaultTimeoutMs,
        stdoutLogPath,
        stderrLogPath,
      );
      if (sessionResult.status !== 'COMPLETED' || sessionResult.exitCode !== 0)
        throw new CodexRunnerError('PROCESS_OUTPUT_FAILED', 'Scope review process did not complete successfully');
      const lastMessage = await readFile(lastMessagePath, 'utf8');
      const review = parseScopeReview(lastMessage, input.task.fields.task_id, expectedDriftPaths);
      const after = normalizeSnapshot(await this.captureSnapshot(input.repositoryPath));
      if (
        after.baseCommit !== before.baseCommit ||
        after.branch !== before.branch ||
        snapshotRemote(after.remote) !== snapshotRemote(before.remote) ||
        JSON.stringify([...after.worktree].sort()) !== JSON.stringify(beforePaths)
      )
        throw new CodexRunnerError('BASELINE_CHANGED', 'Scope review changed the repository worktree');
      if (review.worktreePathFingerprint !== fingerprint)
        throw new CodexRunnerError('PROCESS_OUTPUT_FAILED', 'Scope review fingerprint does not match the reviewed drift paths');
      return review;
    } finally {
      if (outputDirectory !== undefined) await rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (reserved) await this.endSession(sessionId);
    }
  }

  async rotateSession(input: {
    repositoryPath: string;
    snapshots: CodexSnapshots;
    handoff: SessionHandoff;
    previousSessionId?: string;
    model?: string;
    executablePath?: string;
    timeoutMs?: number;
  }): Promise<CodexSessionHandle> {
    const sessionId = randomUUID();
    let reserved = false;
    let outputDirectory: string | undefined;
    try {
      await this.beginSession(sessionId);
      reserved = true;
      const capabilities = await this.checkCapabilities({
        repositoryPath: input.repositoryPath,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.executablePath === undefined ? {} : { executablePath: input.executablePath }),
      });
      outputDirectory = await mkdtemp(join(tmpdir(), 'web-chat2codex-handoff-'));
      await mkdir(this.streamLogDirectory, { recursive: true });
      const lastMessagePath = join(outputDirectory, 'last-message.txt');
      const stdoutLogPath = join(this.streamLogDirectory, `${sessionId}.stdout.jsonl`);
      const stderrLogPath = join(this.streamLogDirectory, `${sessionId}.stderr.jsonl`);
      const record: CodexSessionRecord = {
        sessionId,
        parentSessionId: input.previousSessionId ?? null,
        handoff: {
          ...input.handoff,
          completedTasks: [...input.handoff.completedTasks],
          unresolvedIssues: [...input.handoff.unresolvedIssues],
        },
        createdAt: new Date().toISOString(),
      };
      this.sessionChain.push(record);
      await this.persistSessionState('CREATE_STARTED', sessionId);
      let process: CodexProcess;
      try {
        process = await this.processRunner(
          capabilities.executablePath,
          this.execArgs(capabilities.execution, lastMessagePath, promptForHandoff(input.handoff, input.snapshots)),
          { cwd: capabilities.targetRepository, shell: false, windowsHide: true },
        );
      } catch (error) {
        throw new CodexRunnerError(
          'PROCESS_SPAWN_FAILED',
          'Codex handoff process could not be started',
          {},
          { cause: error },
        );
      }
      this.activeSession = { sessionId, process };
      try {
        await this.persistSessionState('CREATE_COMPLETED', sessionId);
      } catch (error) {
        try {
          process.kill?.();
        } catch (killError) {
          this.logger('codex-process-kill-failed', { error: redact(String(killError)) });
        }
        throw new CodexRunnerError(
          'SESSION_PERSISTENCE_UNAVAILABLE',
          'Could not persist Codex handoff startup',
          {},
          { cause: error },
        );
      }
      const result = this.finishSession(
        process,
        sessionId,
        lastMessagePath,
        input.timeoutMs ?? this.defaultTimeoutMs,
        stdoutLogPath,
        stderrLogPath,
      )
        .catch((error) => this.sessionFailureResult(sessionId, error, stdoutLogPath, stderrLogPath))
        .finally(async () => {
          await rm(outputDirectory!, { recursive: true, force: true }).catch(() => undefined);
          await this.endSession(sessionId);
        });
      return { sessionId, status: 'RUNNING', result };
    } catch (error) {
      if (outputDirectory !== undefined)
        await rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (reserved) await this.endSession(sessionId);
      return { sessionId, status: 'FAILED', result: Promise.resolve(this.sessionFailureResult(sessionId, error)) };
    }
  }

  private async beginSession(sessionId: string): Promise<void> {
    await this.ensureSessionState();
    if (this.activeSession !== null)
      throw new CodexRunnerError('SESSION_ACTIVE', 'A Codex session is already running', {
        activeSessionId: this.activeSession.sessionId,
      });
    this.activeSession = { sessionId, process: null };
    try {
      await this.persistSessionState('CREATE_STARTED', sessionId);
    } catch (error) {
      this.activeSession = null;
      throw new CodexRunnerError(
        'SESSION_PERSISTENCE_UNAVAILABLE',
        'Could not persist Codex session creation',
        {},
        { cause: error },
      );
    }
  }

  private async endSession(sessionId: string): Promise<void> {
    if (this.activeSession?.sessionId === sessionId) this.activeSession = null;
    try {
      await this.persistSessionState('TERMINAL', null);
    } catch (error) {
      this.logger('codex-session-persistence-failed', { error: redact(String(error)) });
    }
  }

  private async ensureSessionState(): Promise<void> {
    if (this.sessionStateLoaded) return;
    if (this.sessionStateLoad !== null) return this.sessionStateLoad;
    this.sessionStateLoad = (async () => {
      try {
        const stored = await this.sessionStore.load();
        if (stored !== null) this.sessionChain.push(...stored.chain);
        this.activeSession = null;
        await this.persistSessionState('STARTUP', null);
        this.sessionStateLoaded = true;
      } catch (error) {
        throw new CodexRunnerError(
          'SESSION_PERSISTENCE_UNAVAILABLE',
          'Could not load Codex session state',
          {},
          { cause: error },
        );
      } finally {
        this.sessionStateLoad = null;
      }
    })();
    return this.sessionStateLoad;
  }

  private async persistSessionState(
    lastEvent: CodexSessionState['lastEvent'],
    activeSessionId: string | null,
  ): Promise<void> {
    const state: CodexSessionState = {
      chain: this.getSessionChain(),
      activeSessionId,
      lastEvent,
      updatedAt: new Date().toISOString(),
    };
    await this.sessionStore.save(state);
    await this.persistSessionChain?.(this.getSessionChain());
    this.logger('codex-session-state', { lastEvent, activeSessionId: activeSessionId ?? '<none>' });
  }

  private taskFailureResult(input: CodexTaskInput, sessionId: string, error: unknown): CodexRunResult {
    const task = isRecord(input) && isRecord(input.task) ? input.task : null;
    const fields: Record<string, unknown> = task !== null && isRecord(task.fields) ? task.fields : {};
    const code = error instanceof CodexRunnerError ? error.code : 'RUNNER_FAILED';
    return {
      status: code === 'BASELINE_CHANGED' ? 'BASELINE_CHANGED' : 'FAILED',
      sessionId,
      taskId: typeof fields.task_id === 'string' ? fields.task_id : '<unknown>',
      exitCode: null,
      reportPath: typeof fields.report_path === 'string' ? fields.report_path : '',
      stdoutSummary: '',
      stderrSummary: '',
      events: [],
      config: {
        model: typeof input.model === 'string' && input.model.trim() !== '' ? input.model : this.defaultModel,
        reasoningEffort: this.defaultReasoningEffort,
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
      },
      diagnostics: [redact(error instanceof Error ? error.message : String(error))],
      error: { code, message: redact(error instanceof Error ? error.message : String(error)) },
    };
  }

  private sessionFailureResult(
    sessionId: string,
    error: unknown,
    stdoutLogPath?: string,
    stderrLogPath?: string,
  ): CodexSessionResult {
    const code = error instanceof CodexRunnerError ? error.code : 'RUNNER_FAILED';
    return {
      sessionId,
      status: 'FAILED',
      exitCode: null,
      stdoutSummary: '',
      stderrSummary: '',
      events: [],
      diagnostics: [redact(error instanceof Error ? error.message : String(error))],
      ...(stdoutLogPath === undefined ? {} : { stdoutLogPath }),
      ...(stderrLogPath === undefined ? {} : { stderrLogPath }),
      error: { code, message: redact(error instanceof Error ? error.message : String(error)) },
    };
  }

  private async finishTask(
    process: CodexProcess,
    input: {
      sessionId: string;
      task: LunaTaskBlock;
      repositoryPath: string;
      expectedSnapshot: ReturnType<typeof normalizeSnapshot>;
      lastMessagePath: string;
      outputDirectory: string;
      execution: CodexExecutionConfig;
      timeoutMs: number;
      stdoutLogPath: string;
      stderrLogPath: string;
    },
  ): Promise<CodexRunResult> {
    try {
      const sessionResult = await this.finishSession(
        process,
        input.sessionId,
        input.lastMessagePath,
        input.timeoutMs,
        input.stdoutLogPath,
        input.stderrLogPath,
      );
      let lastMessage = '';
      try {
        lastMessage = await readFile(input.lastMessagePath, 'utf8');
      } catch (error) {
        this.logger('codex-last-message-missing', { path: '<temporary>', error: redact(String(error)) });
      }
      const protocol = findProtocol(sessionResult.stdoutSummary, lastMessage, sessionResult.events);
      const protocolResult = protocol.result;
      const base: CodexRunResult = {
        status: 'INVALID_RESULT',
        sessionId: input.sessionId,
        taskId: input.task.fields.task_id,
        exitCode: sessionResult.exitCode,
        ...(protocolResult === null ? {} : { protocolResult }),
        reportPath: input.task.fields.report_path,
        stdoutSummary: sessionResult.stdoutSummary,
        stderrSummary: sessionResult.stderrSummary,
        events: sessionResult.events,
        config: input.execution,
        diagnostics: [...sessionResult.diagnostics],
        stdoutLogPath: input.stdoutLogPath,
        stderrLogPath: input.stderrLogPath,
      };
      if (sessionResult.status === 'TIMEOUT')
        return { ...base, status: 'TIMEOUT', diagnostics: [...base.diagnostics, 'Codex process exceeded the timeout'] };
      if (sessionResult.status === 'FAILED' || sessionResult.exitCode !== 0)
        return {
          ...base,
          status: 'FAILED',
          diagnostics: [...base.diagnostics, 'Codex process or output stream failed'],
          ...(sessionResult.error === undefined ? {} : { error: sessionResult.error }),
        };
      if (protocolResult === null)
        return {
          ...base,
          diagnostics: [...base.diagnostics, protocol.diagnostic ?? 'LUNA_RESULT is missing, duplicated, or invalid'],
        };
      if (protocolResult.status === 'BLOCKED_EXTERNAL_SETUP')
        return {
          ...base,
          status: 'FAILED',
          diagnostics: [...base.diagnostics, 'Luna reported an external setup block'],
        };
      if (protocolResult.status === 'FAILED' && input.task.fields.task_kind !== 'IMPLEMENTATION')
        return {
          ...base,
          status: 'FAILED',
          diagnostics: [...base.diagnostics, 'Luna reported a failed result for a non-implementation task'],
        };
      if (normalizePath(protocolResult.reportPath) !== normalizePath(input.task.fields.report_path))
        return { ...base, diagnostics: [...base.diagnostics, 'Luna report path does not match the task report path'] };
      const reportStatus = await this.checkReport(input.repositoryPath, input.task.fields.report_path);
      if (!reportStatus.exists)
        return { ...base, status: 'REPORT_MISSING', diagnostics: [...base.diagnostics, reportStatus.reason] };
      const gitStatus = await this.checkGitState(input.repositoryPath, input.task);
      if (!gitStatus.valid)
        return {
          ...base,
          status: 'INVALID_RESULT',
          diagnostics: [...base.diagnostics, gitStatus.reason ?? 'Git state is invalid'],
        };
      const changedPaths = gitStatus.changedPaths ?? [];
      if (!changedPaths.includes(normalizePath(input.task.fields.report_path)))
        return {
          ...base,
          status: 'INVALID_RESULT',
          diagnostics: [...base.diagnostics, 'Report is not present in this run worktree diff'],
        };
      const finalSnapshot = normalizeSnapshot(await this.captureSnapshot(input.repositoryPath));
      if (
        finalSnapshot.baseCommit !== input.expectedSnapshot.baseCommit ||
        finalSnapshot.branch !== input.expectedSnapshot.branch ||
        snapshotRemote(finalSnapshot.remote) !== snapshotRemote(input.expectedSnapshot.remote)
      )
        return {
          ...base,
          status: 'BASELINE_CHANGED',
          diagnostics: [...base.diagnostics, 'Repository baseline changed during the run'],
        };
      return { ...base, status: protocolResult.status === 'FAILED' ? 'FAILED' : 'COMPLETED' };
    } catch (error) {
      return {
        ...this.taskFailureResult(input as unknown as CodexTaskInput, input.sessionId, error),
        taskId: input.task.fields.task_id,
        reportPath: input.task.fields.report_path,
        config: input.execution,
        stdoutLogPath: input.stdoutLogPath,
        stderrLogPath: input.stderrLogPath,
      };
    } finally {
      await rm(input.outputDirectory, { recursive: true, force: true }).catch(() => undefined);
      await this.endSession(input.sessionId);
    }
  }

  private async finishSession(
    process: CodexProcess,
    sessionId: string,
    lastMessagePath: string,
    timeoutMs: number,
    stdoutLogPath: string,
    stderrLogPath: string,
  ): Promise<CodexSessionResult> {
    const stdoutPromise = captureOutput(process.stdout, stdoutLogPath, sessionId, 'stdout', this.maxStreamLogBytes);
    const stderrPromise = captureOutput(process.stderr, stderrLogPath, sessionId, 'stderr', this.maxStreamLogBytes);
    const waitPromise = Promise.resolve()
      .then(() => process.wait())
      .then(
        (exitCode) => ({ exitCode, error: null as unknown | null }),
        (error: unknown) => ({ exitCode: null, error }),
      );
    const execution = Promise.all([waitPromise, stdoutPromise, stderrPromise]);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolveTimeout) => {
      timeoutHandle = setTimeout(() => resolveTimeout(null), timeoutMs);
    });
    const completed = await Promise.race([execution, timeout]);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (completed === null) {
      const diagnostics = [`Timed out after ${timeoutMs}ms; last message path: ${lastMessagePath}`];
      try {
        process.kill?.();
      } catch (error) {
        diagnostics.push(`Process kill failed: ${redact(String(error))}`);
      }
      const [stdout, stderr] = await Promise.all([
        Promise.race([stdoutPromise, Promise.resolve(null)]),
        Promise.race([stderrPromise, Promise.resolve(null)]),
      ]);
      return {
        sessionId,
        status: 'TIMEOUT',
        exitCode: null,
        stdoutSummary: redact(stdout?.value ?? ''),
        stderrSummary: redact(stderr?.value ?? ''),
        events: parseJsonLines(stdout?.value ?? ''),
        diagnostics,
        stdoutLogPath,
        stderrLogPath,
      };
    }
    const [waitResult, stdout, stderr] = completed;
    const diagnostics: string[] = [];
    if (stdout.error !== null) diagnostics.push(`stdout stream failed: ${redact(String(stdout.error))}`);
    if (stderr.error !== null) diagnostics.push(`stderr stream failed: ${redact(String(stderr.error))}`);
    if (stdout.truncated || stderr.truncated)
      diagnostics.push('Process output exceeded the configured capture or log limit');
    if (waitResult.error !== null) diagnostics.push(`process wait failed: ${redact(String(waitResult.error))}`);
    const status: CodexSessionResult['status'] =
      waitResult.error !== null || stdout.error !== null || stderr.error !== null ? 'FAILED' : 'COMPLETED';
    return {
      sessionId,
      status,
      exitCode: waitResult.error === null ? waitResult.exitCode : null,
      stdoutSummary: redact(stdout.value),
      stderrSummary: redact(stderr.value),
      events: parseJsonLines(stdout.value),
      diagnostics,
      stdoutLogPath,
      stderrLogPath,
      ...(waitResult.error === null
        ? {}
        : { error: { code: 'PROCESS_WAIT_FAILED', message: redact(String(waitResult.error)) } }),
    };
  }

  private execArgs(execution: CodexExecutionConfig, outputPath: string, prompt: string): string[] {
    return [
      '--ask-for-approval',
      execution.approvalPolicy,
      'exec',
      '--model',
      execution.model,
      '--config',
      `model_reasoning_effort=${execution.reasoningEffort}`,
      '--sandbox',
      execution.sandbox,
      '--json',
      '--output-last-message',
      outputPath,
      prompt,
    ];
  }

  private async resolveExecutable(configuredPath?: string): Promise<string> {
    if (configuredPath?.trim()) {
      try {
        const executable = resolve(configuredPath);
        const stats = await stat(executable);
        if (!stats.isFile()) throw new Error('not a file');
        return executable;
      } catch (error) {
        throw new CodexRunnerError(
          'CLI_NOT_FOUND',
          'Configured Codex executable is not available',
          {},
          { cause: error },
        );
      }
    }
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    const checkedPaths: string[] = [];
    let lookupError: unknown;
    try {
      const result = await this.execFile(locator, ['codex'], { shell: false, windowsHide: true });
      const pathResults = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => line.replace(/^"(.*)"$/, '$1'));
      checkedPaths.push(...pathResults);
      for (const executable of pathResults) {
        // Windows `where codex` commonly returns npm's extensionless POSIX
        // launcher and `.cmd` shim before the native executable. Neither can
        // be passed to execFile with shell:false; select only native .exe
        // entries and let the known-installation fallback handle the rest.
        if (process.platform === 'win32' && extname(executable).toLowerCase() !== '.exe') continue;
        try {
          if ((await stat(executable)).isFile()) return executable;
        } catch {
          // Continue to the known installation locations below.
        }
      }
      lookupError = new Error(pathResults.length === 0 ? 'no executable path' : 'PATH entries are not files');
    } catch (error) {
      lookupError = error;
    }

    if (process.platform === 'win32') {
      const binDirectory = process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
        : null;
      let versionDirectories: string[] = [];
      if (binDirectory !== null) {
        try {
          versionDirectories = (await readdir(binDirectory, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort()
            .reverse();
        } catch {
          // The fallback list below still covers the other common locations.
        }
      }
      const knownCandidates = codexExecutableCandidates(process.env, versionDirectories);
      checkedPaths.push(...knownCandidates);
      for (const executable of knownCandidates) {
        try {
          if ((await stat(executable)).isFile()) return executable;
        } catch {
          // Try the next known location.
        }
      }
    }

    throw new CodexRunnerError(
      'CLI_NOT_FOUND',
      'Codex executable could not be located. PATH and known Windows installation locations were checked.',
      { checkedPaths: [...new Set(checkedPaths)].slice(0, 20) },
      { cause: lookupError },
    );
  }

  private async assertTargetRepository(repositoryPath: string): Promise<string> {
    const requested = resolve(repositoryPath);
    try {
      const stats = await stat(requested);
      if (!stats.isDirectory()) throw new Error('not a directory');
      if (this.repositoryValidator !== undefined) {
        if (!(await this.repositoryValidator(requested))) throw new Error('repository validator rejected path');
        return requested;
      }
      const result = await this.execFile('git', ['-C', requested, 'rev-parse', '--show-toplevel'], {
        shell: false,
        windowsHide: true,
      });
      const rootText = result.stdout.trim();
      if (rootText === '') throw new Error('git returned no root');
      return await realProjectRoot(rootText);
    } catch (error) {
      throw new CodexRunnerError(
        'INVALID_TARGET_REPOSITORY',
        'Codex target path is not a valid Git repository',
        {},
        { cause: error },
      );
    }
  }

  private async probe(
    executablePath: string,
    args: string[],
    code: 'CLI_VERSION_UNAVAILABLE' | 'CLI_AUTH_UNAVAILABLE' | 'CLI_MODEL_UNAVAILABLE',
  ): Promise<CodexExecFileResult> {
    try {
      return await this.execFile(executablePath, args, { shell: false, windowsHide: true });
    } catch (error) {
      throw new CodexRunnerError(
        code,
        `Codex capability probe failed: ${args[0] ?? 'unknown'}`,
        { args, stderr: redact(String(error instanceof Error ? error.message : error)) },
        { cause: error },
      );
    }
  }

  private isAuthenticated(probe: CodexExecFileResult): boolean {
    const text = `${probe.stdout}\n${probe.stderr}`.trim();
    if (text === '') return false;
    try {
      const parsed: unknown = JSON.parse(probe.stdout);
      if (isRecord(parsed)) {
        if (
          parsed.authenticated === true ||
          parsed.loggedIn === true ||
          parsed.status === 'authenticated' ||
          parsed.status === 'logged_in'
        )
          return true;
        if (parsed.authenticated === false || parsed.loggedIn === false) return false;
      }
    } catch {
      // The installed CLI currently emits a human-readable login status.
    }
    if (/not\s+logged|logged\s*out|unauthenticated|no\s+active\s+login/i.test(text)) return false;
    return /logged\s+in|authenticated|active\s+login/i.test(text);
  }

  private assertParsedTask(task: LunaTaskBlock): void {
    if (task.type !== 'LUNA_TASK' || task.fields.task_id.trim() === '' || task.fields.base_commit.trim() === '')
      throw new CodexRunnerError(
        'INVALID_TARGET_REPOSITORY',
        'Codex runner requires a parsed LUNA_TASK with a base commit',
      );
  }

  private async verifyTaskBaseline(input: CodexTaskInput): Promise<ReturnType<typeof normalizeSnapshot>> {
    const expectedRaw = input.repositorySnapshot ?? input.baselineSnapshot ?? input.snapshot ?? input.snapshots.git;
    if (expectedRaw === undefined)
      throw new CodexRunnerError('BASELINE_CHANGED', 'Codex task is missing its repository baseline snapshot');
    const expected = normalizeSnapshot(expectedRaw);
    const actual = normalizeSnapshot(await this.captureSnapshot(input.repositoryPath));
    if (input.task.fields.base_commit.trim() !== expected.baseCommit)
      throw new CodexRunnerError('BASELINE_CHANGED', 'Task base_commit differs from the input repository snapshot', {
        taskBaseCommit: input.task.fields.base_commit,
        snapshotBaseCommit: expected.baseCommit,
      });
    const mismatch = snapshotMismatch(expected, actual);
    if (mismatch !== null) throw new CodexRunnerError('BASELINE_CHANGED', mismatch);
    this.logger('codex-baseline-verified', { baseCommit: '<redacted>', branch: actual.branch, remote: '<redacted>' });
    return expected;
  }

  private async captureSnapshot(repositoryPath: string): Promise<CodexRepositorySnapshot> {
    if (this.captureRepositorySnapshot !== undefined) return this.captureRepositorySnapshot(repositoryPath);
    const requested = resolve(repositoryPath);
    const rootText = (
      await this.execFile('git', ['-C', requested, 'rev-parse', '--show-toplevel'], { shell: false, windowsHide: true })
    ).stdout.trim();
    if (rootText === '') throw new Error('Git returned no repository root');
    const root = await realProjectRoot(rootText);
    const [head, branch, remote, status] = await Promise.all([
      this.execFile('git', ['-C', root, 'rev-parse', 'HEAD'], { shell: false, windowsHide: true }),
      this.execFile('git', ['-C', root, 'branch', '--show-current'], { shell: false, windowsHide: true }),
      this.execFile('git', ['-C', root, 'remote', 'get-url', 'origin'], { shell: false, windowsHide: true }),
      this.execFile('git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all', '-z'], {
        shell: false,
        windowsHide: true,
      }),
    ]);
    const worktree = status.stdout
      .split('\0')
      .filter((entry) => entry.length > 0)
      .map((entry) => normalizePath(entry.slice(3)))
      .filter((path) => path !== '');
    return {
      repositoryRoot: root,
      baseCommit: head.stdout.trim(),
      branch: branch.stdout.trim(),
      remote: remote.stdout.trim(),
      cleanWorktree: worktree.length === 0,
      worktree,
    };
  }

  private async checkReport(repositoryPath: string, reportPath: string): Promise<{ exists: boolean; reason: string }> {
    const normalized = normalizePath(reportPath);
    if (!isSafeRelativePath(normalized) || isProtectedPath(normalized))
      return { exists: false, reason: 'Report path is unsafe or protected' };
    try {
      const absolute = await assertSafeProjectPath(repositoryPath, normalized);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink() || !stats.isFile())
        return { exists: false, reason: 'Report path is not a regular file' };
      const [rootReal, reportReal] = await Promise.all([realpath(repositoryPath), realpath(absolute)]);
      if (!isPathWithin(rootReal, reportReal))
        return { exists: false, reason: 'Report path resolves outside the repository' };
      await access(absolute);
      return { exists: true, reason: '' };
    } catch {
      return { exists: false, reason: 'Required report file is missing or unsafe' };
    }
  }

  private async checkGitState(repositoryPath: string, task: LunaTaskBlock): Promise<GitStateCheckResult> {
    if (this.gitStateCheck !== undefined) return this.gitStateCheck(repositoryPath, task);
    try {
      const [root, branch, head, remote, status] = await Promise.all([
        this.execFile('git', ['-C', repositoryPath, 'rev-parse', '--show-toplevel'], {
          shell: false,
          windowsHide: true,
        }),
        this.execFile('git', ['-C', repositoryPath, 'branch', '--show-current'], { shell: false, windowsHide: true }),
        this.execFile('git', ['-C', repositoryPath, 'rev-parse', 'HEAD'], { shell: false, windowsHide: true }),
        this.execFile('git', ['-C', repositoryPath, 'remote', 'get-url', 'origin'], {
          shell: false,
          windowsHide: true,
        }),
        this.execFile('git', ['-C', repositoryPath, 'status', '--porcelain=v1', '--untracked-files=all', '-z'], {
          shell: false,
          windowsHide: true,
        }),
      ]);
      if (resolve(root.stdout.trim()) !== resolve(repositoryPath))
        return { valid: false, reason: 'Git repository root changed' };
      if (branch.stdout.trim() === '') return { valid: false, reason: 'Git branch is detached' };
      if (head.stdout.trim() !== task.fields.base_commit.trim())
        return { valid: false, reason: 'Luna changed HEAD unexpectedly' };
      if (remote.stdout.trim() === '') return { valid: false, reason: 'Git remote is missing' };
      const paths = status.stdout
        .split('\0')
        .filter((entry) => entry.length > 0)
        .map((entry) => normalizePath(entry.slice(3)))
        .filter((path) => path !== '');
      if (paths.some(isProtectedPath))
        return { valid: false, reason: 'Luna modified a protected path', changedPaths: paths };
      return { valid: true, changedPaths: paths };
    } catch (error) {
      return { valid: false, reason: `Git state check failed: ${redact(String(error))}` };
    }
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const difference = relative(resolve(root), resolve(candidate));
  const separator = process.platform === 'win32' ? '\\' : '/';
  return (
    difference === '' || (difference !== '..' && !difference.startsWith(`..${separator}`) && !isAbsolute(difference))
  );
}

export { findProtocol, normalizePath, parseJsonLines, promptForHandoff, promptForTask, redact, redactUnknown };
