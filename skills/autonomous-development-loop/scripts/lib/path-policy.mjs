import { isAbsolute, relative, resolve } from 'node:path';

export const DEFAULT_PROTECTED_PATHS = ['.git', '.git/**'];

export function normalizePath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

export function isSafeRelativePath(value) {
  const raw = String(value ?? '').replaceAll('\\', '/');
  if (!raw || isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) return false;
  const normalized = normalizePath(raw);
  return normalized !== '..' && !normalized.startsWith('../') && !normalized.split('/').includes('');
}

export function matchesPath(path, pattern) {
  const candidate = normalizePath(path);
  const rule = normalizePath(pattern);
  if (rule.endsWith('/**')) {
    const prefix = rule.slice(0, -3).replace(/\/$/, '');
    return candidate === prefix || candidate.startsWith(`${prefix}/`);
  }
  if (rule.endsWith('/*')) {
    const prefix = rule.slice(0, -2).replace(/\/$/, '');
    return candidate.startsWith(`${prefix}/`) && !candidate.slice(prefix.length + 1).includes('/');
  }
  return candidate === rule;
}

export function isSensitivePath(path) {
  return /(^|\/)(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|.*(?:private|secret|credential)[-_]?.*)$/i.test(
    normalizePath(path),
  );
}

export function checkPaths(paths, protectedPaths = []) {
  const rules = [...DEFAULT_PROTECTED_PATHS, ...protectedPaths];
  const unsafe = [];
  const protectedMatches = [];
  const sensitive = [];
  for (const original of paths) {
    const path = normalizePath(original);
    if (!isSafeRelativePath(path)) unsafe.push(path);
    if (rules.some((rule) => matchesPath(path, rule))) protectedMatches.push(path);
    if (isSensitivePath(path)) sensitive.push(path);
  }
  return {
    ok: unsafe.length === 0 && protectedMatches.length === 0 && sensitive.length === 0,
    unsafe_paths: [...new Set(unsafe)],
    protected_paths: [...new Set(protectedMatches)],
    sensitive_paths: [...new Set(sensitive)],
  };
}

export function pathWithin(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  const normalized = rel.replaceAll('\\', '/');
  return normalized === '' || (normalized !== '..' && !normalized.startsWith('../') && !isAbsolute(rel));
}
