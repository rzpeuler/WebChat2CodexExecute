import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { isSensitivePath, isSafeRelativePath, normalizePath } from './path-policy.mjs';

const REQUIRED_FIELDS = [
  'task_id',
  'status',
  'baseline',
  'branch',
  'implementation_commit',
  'verified_remote_tip',
  'sync_status',
  'summary',
  'tests',
  'acceptance_criteria',
  'governance_status',
  'blockers',
];
const STATUSES = new Set(['READY_FOR_SOL_REVIEW', 'BLOCKED', 'FAILED_UNRECOVERABLE']);
const SYNC_STATUSES = new Set(['READY_TO_SYNC', 'SYNCED']);
const SHA_PATTERN = /^([0-9a-f]{40}|[0-9a-f]{64})$/i;

export async function validateTaskReport(input) {
  const reportPath = normalizePath(input.report_path);
  if (!isSafeRelativePath(reportPath) || isSensitivePath(reportPath))
    return { ok: false, code: 'REPORT_PATH_UNSAFE', message: 'report path is unsafe' };
  const absolute = resolve(input.repo, reportPath);
  let stats;
  try {
    stats = await lstat(absolute);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('not a regular file');
    const realRoot = await realpath(input.repo);
    const realReport = await realpath(absolute);
    const relativePath = relative(realRoot, realReport);
    if (relativePath.replaceAll('\\', '/') === '..' || relativePath.replaceAll('\\', '/').startsWith('../'))
      throw new Error('report resolves outside repository');
  } catch (error) {
    return { ok: false, code: 'REPORT_MISSING_OR_UNSAFE', message: String(error.message ?? error) };
  }
  const source = await readFile(absolute, 'utf8');
  const fields = {};
  const duplicates = new Set();
  for (const match of source.matchAll(/^([a-z][a-z0-9_]*):\s*(.*?)\s*$/gim)) {
    const field = match[1].toLowerCase();
    if (fields[field] !== undefined) duplicates.add(field);
    fields[field] = match[2];
  }
  if (duplicates.size) return { ok: false, code: 'REPORT_FIELDS_DUPLICATE', message: `duplicate fields: ${[...duplicates].join(', ')}` };
  const missing = REQUIRED_FIELDS.filter((field) => fields[field] === undefined || fields[field] === '');
  if (missing.length) return { ok: false, code: 'REPORT_FIELDS_MISSING', message: `missing fields: ${missing.join(', ')}` };
  if (fields.final_commit !== undefined || fields.remote_verified !== undefined)
    return { ok: false, code: 'REPORT_LEGACY_FINALIZATION_FIELDS', message: 'use implementation_commit, verified_remote_tip, and sync_status' };
  if (!STATUSES.has(fields.status)) return { ok: false, code: 'REPORT_STATUS_INVALID', message: 'unsupported report status' };
  if (input.task_id !== undefined && fields.task_id !== input.task_id)
    return { ok: false, code: 'REPORT_TASK_MISMATCH', message: 'report task_id differs from input' };
  if (input.baseline !== undefined && fields.baseline !== input.baseline)
    return { ok: false, code: 'REPORT_BASELINE_MISMATCH', message: 'report baseline differs from input' };
  if (input.branch !== undefined && fields.branch !== input.branch)
    return { ok: false, code: 'REPORT_BRANCH_MISMATCH', message: 'report branch differs from input' };
  if (!SHA_PATTERN.test(fields.baseline))
    return { ok: false, code: 'REPORT_BASELINE_INVALID', message: 'report baseline must be a Git SHA' };
  if (!SYNC_STATUSES.has(fields.sync_status))
    return { ok: false, code: 'REPORT_SYNC_STATUS_INVALID', message: 'unsupported sync_status' };
  const pendingFinalization = fields.implementation_commit === 'pending' && fields.verified_remote_tip === 'pending';
  const finalized = SHA_PATTERN.test(fields.implementation_commit) && SHA_PATTERN.test(fields.verified_remote_tip);
  if (fields.sync_status === 'READY_TO_SYNC' && !pendingFinalization)
    return { ok: false, code: 'REPORT_SYNC_STATE_INVALID', message: 'READY_TO_SYNC requires both finalization fields to be pending' };
  if (fields.sync_status === 'SYNCED' && (!finalized || fields.implementation_commit !== fields.verified_remote_tip))
    return { ok: false, code: 'REPORT_SYNC_STATE_INVALID', message: 'SYNCED requires matching implementation and verified remote SHAs' };
  if (input.phase === 'pre-sync' && fields.sync_status !== 'READY_TO_SYNC')
    return { ok: false, code: 'REPORT_PHASE_INVALID', message: 'pre-sync validation requires READY_TO_SYNC' };
  if (input.phase === 'final' && fields.sync_status !== 'SYNCED')
    return { ok: false, code: 'REPORT_PHASE_INVALID', message: 'final validation requires SYNCED' };
  const forbiddenTimeField = source.match(/^\s*(ETA|estimated_duration|predicted_completion|planned_start_time)\s*:/im);
  if (forbiddenTimeField)
    return { ok: false, code: 'REPORT_TIME_FIELD_FORBIDDEN', message: `future time field is forbidden: ${forbiddenTimeField[1]}` };
  return { ok: true, report_path: reportPath, fields, bytes: stats.size };
}

export async function finalizeTaskReport(input) {
  const current = await validateTaskReport({ ...input, phase: 'pre-sync' });
  if (!current.ok) return current;
  if (!SHA_PATTERN.test(input.implementation_commit) || !SHA_PATTERN.test(input.verified_remote_tip))
    return { ok: false, code: 'REPORT_FINALIZATION_SHA_INVALID', message: 'finalization values must be Git SHAs' };
  if (input.implementation_commit !== input.verified_remote_tip)
    return { ok: false, code: 'REPORT_FINALIZATION_TIP_MISMATCH', message: 'implementation commit and verified remote tip must match' };
  const absolute = resolve(input.repo, current.report_path);
  let source = await readFile(absolute, 'utf8');
  source = source.replace(/^implementation_commit:\s*.*$/im, `implementation_commit: ${input.implementation_commit}`);
  source = source.replace(/^verified_remote_tip:\s*.*$/im, `verified_remote_tip: ${input.verified_remote_tip}`);
  source = source.replace(/^sync_status:\s*.*$/im, 'sync_status: SYNCED');
  await writeFile(absolute, source, 'utf8');
  return validateTaskReport({ ...input, phase: 'final' });
}
