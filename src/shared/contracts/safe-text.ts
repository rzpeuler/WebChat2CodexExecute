const BEARER_PATTERN = /\bbearer\s+[a-z0-9._~+/=-]+/gi;
const CREDENTIAL_PATTERN =
  /(?<![?&])(?:cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|password|passwd|secret|api[_-]?key|authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;，；。]+/gi;
const URL_CREDENTIAL_PATTERN = /(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const QUERY_CREDENTIAL_PATTERN =
  /([?&](?:token|access[_-]?token|refresh[_-]?token|password|secret|key|auth)[^=]*=)[^&\s]+/gi;

export const SAFE_TEXT_MAX_LENGTH = 240;

export function sanitizeSafeText(value: unknown, maxLength = SAFE_TEXT_MAX_LENGTH): string {
  if (typeof value !== 'string') {
    return '';
  }
  const sanitized = value
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(CREDENTIAL_PATTERN, '[REDACTED]')
    .replace(URL_CREDENTIAL_PATTERN, '$1[REDACTED]@')
    .replace(QUERY_CREDENTIAL_PATTERN, '$1[REDACTED]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized.length > maxLength ? `${sanitized.slice(0, Math.max(0, maxLength - 1))}…` : sanitized;
}

export function stableErrorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string') {
    const normalized = normalizeErrorCode(error.code);
    if (normalized !== '') return normalized;
  }
  if (error instanceof Error) {
    const normalizedName = normalizeErrorCode(error.name);
    if (normalizedName !== '' && normalizedName !== 'ERROR') return normalizedName;
  }
  if (isRecord(error) && typeof error.name === 'string') {
    const normalizedName = normalizeErrorCode(error.name);
    if (normalizedName !== '' && normalizedName !== 'ERROR') return normalizedName;
  }
  return 'UNCLASSIFIED_ERROR';
}

export function sanitizeErrorMessage(error: unknown, fallback = '发生未分类错误'): string {
  const message =
    isRecord(error) && typeof error.message === 'string' ? error.message : error instanceof Error ? error.message : '';
  return sanitizeSafeText(message) || fallback;
}

export function normalizeErrorCode(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
    .slice(0, 64);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
