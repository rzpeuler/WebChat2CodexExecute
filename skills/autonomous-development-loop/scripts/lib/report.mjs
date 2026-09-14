import { lstat, readFile, realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { isSensitivePath, isSafeRelativePath, normalizePath } from './path-policy.mjs';

const REQUIRED_FIELDS = [
  'task_id',
  'status',
  'baseline',
  'branch',
  'final_commit',
  'remote_verified',
  'summary',
  'tests',
  'acceptance_criteria',
  'governance_status',
  'blockers',
];
const STATUSES = new Set(['READY_FOR_SOL_REVIEW', 'BLOCKED', 'FAILED_UNRECOVERABLE']);

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
  const fields = Object.fromEntries(
    [...source.matchAll(/^([a-z][a-z0-9_]*):\s*(.*?)\s*$/gim)].map((match) => [match[1].toLowerCase(), match[2]]),
  );
  const missing = REQUIRED_FIELDS.filter((field) => !fields[field]);
  if (missing.length) return { ok: false, code: 'REPORT_FIELDS_MISSING', message: `missing fields: ${missing.join(', ')}` };
  if (!STATUSES.has(fields.status)) return { ok: false, code: 'REPORT_STATUS_INVALID', message: 'unsupported report status' };
  if (input.task_id !== undefined && fields.task_id !== input.task_id)
    return { ok: false, code: 'REPORT_TASK_MISMATCH', message: 'report task_id differs from input' };
  if (input.baseline !== undefined && fields.baseline !== input.baseline)
    return { ok: false, code: 'REPORT_BASELINE_MISMATCH', message: 'report baseline differs from input' };
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(fields.baseline))
    return { ok: false, code: 'REPORT_BASELINE_INVALID', message: 'report baseline must be a Git SHA' };
  return { ok: true, report_path: reportPath, fields, bytes: stats.size };
}
