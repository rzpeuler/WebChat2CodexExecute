import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

export type GovernanceTextHashErrorCode = 'EMPTY_OR_BINARY' | 'INVALID_UTF8';

export class GovernanceTextHashError extends Error {
  readonly code: GovernanceTextHashErrorCode;

  constructor(code: GovernanceTextHashErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GovernanceTextHashError';
    this.code = code;
  }
}

export interface CanonicalGovernanceText {
  readonly rawBytes: Buffer;
  readonly text: string;
  readonly canonicalText: string;
  readonly canonicalBytes: Buffer;
  readonly sha256: string;
}

function assertRegularText(bytes: Uint8Array, path: string): string {
  if (bytes.length === 0 || bytes.includes(0)) {
    throw new GovernanceTextHashError('EMPTY_OR_BINARY', `Governance text is empty or binary: ${path}`);
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new GovernanceTextHashError('INVALID_UTF8', `Governance text is not valid UTF-8: ${path}`, {
      cause: error,
    });
  }

  const controls = [...text].filter((character) => {
    const code = character.charCodeAt(0);
    return code < 32 && character !== '\t' && character !== '\n' && character !== '\r';
  }).length;
  if (controls > Math.max(1, Math.floor(text.length / 100))) {
    throw new GovernanceTextHashError('EMPTY_OR_BINARY', `Governance text contains binary control data: ${path}`);
  }
  return text;
}

export function normalizeGovernanceText(bytes: Uint8Array, path = '<content>'): string {
  const text = assertRegularText(bytes, path);
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function hashCanonicalGovernanceText(bytes: Uint8Array, path = '<content>'): string {
  return createHash('sha256')
    .update(Buffer.from(normalizeGovernanceText(bytes, path), 'utf8'))
    .digest('hex');
}

export function canonicalizeGovernanceText(bytes: Uint8Array, path = '<content>'): CanonicalGovernanceText {
  const rawBytes = Buffer.from(bytes);
  const text = assertRegularText(rawBytes, path);
  const canonicalText = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const canonicalBytes = Buffer.from(canonicalText, 'utf8');
  return {
    rawBytes,
    text,
    canonicalText,
    canonicalBytes,
    sha256: createHash('sha256').update(canonicalBytes).digest('hex'),
  };
}

export async function readCanonicalGovernanceText(path: string): Promise<CanonicalGovernanceText> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new GovernanceTextHashError('EMPTY_OR_BINARY', `Governance text is not a regular file: ${path}`);
  }
  return canonicalizeGovernanceText(await readFile(path), path);
}
