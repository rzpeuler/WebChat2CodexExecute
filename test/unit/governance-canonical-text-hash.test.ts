import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalizeGovernanceText,
  GovernanceTextHashError,
  type GovernanceTextHashErrorCode,
  hashCanonicalGovernanceText,
  normalizeGovernanceText,
  readCanonicalGovernanceText,
} from '../../src/main/governance/canonical-text-hash.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function expectedHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('canonical governance text hash', () => {
  it.each([
    ['LF', 'title\nbody\n'],
    ['CRLF', 'title\r\nbody\r\n'],
    ['CR', 'title\rbody\r'],
  ])('normalizes %s line endings to LF', (_label, source) => {
    expect(normalizeGovernanceText(Buffer.from(source, 'utf8'))).toBe('title\nbody\n');
    expect(hashCanonicalGovernanceText(Buffer.from(source, 'utf8'))).toBe(expectedHash('title\nbody\n'));
  });

  it('removes a UTF-8 BOM before hashing', () => {
    const withoutBom = Buffer.from('title\n', 'utf8');
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), withoutBom]);
    expect(hashCanonicalGovernanceText(withBom)).toBe(hashCanonicalGovernanceText(withoutBom));
    expect(canonicalizeGovernanceText(withBom)).toMatchObject({ text: '\uFEFFtitle\n', canonicalText: 'title\n' });
  });

  it.each([
    ['body changes', 'title\nbody\n', 'title\nchanged\n'],
    ['space changes', 'title\nbody\n', 'title\nbody \n'],
    ['trailing newline changes', 'title\nbody\n', 'title\nbody'],
  ])('keeps %s significant', (_label, first, second) => {
    expect(hashCanonicalGovernanceText(Buffer.from(first, 'utf8'))).not.toBe(
      hashCanonicalGovernanceText(Buffer.from(second, 'utf8')),
    );
  });

  it.each([
    ['empty', Buffer.alloc(0), 'EMPTY_OR_BINARY'],
    ['binary', Buffer.from('text\0text', 'utf8'), 'EMPTY_OR_BINARY'],
    ['short binary control prefix', Buffer.from([0x01, 0x41]), 'EMPTY_OR_BINARY'],
    ['DEL control byte', Buffer.from([0x41, 0x7f]), 'EMPTY_OR_BINARY'],
    ['invalid UTF-8', Buffer.from([0xc3, 0x28]), 'INVALID_UTF8' as const],
  ] as const)('rejects %s input', (_label, bytes, code: GovernanceTextHashErrorCode) => {
    expect(() => hashCanonicalGovernanceText(bytes)).toThrowError(
      expect.objectContaining<Partial<GovernanceTextHashError>>({ code }),
    );
  });

  it('reads a regular UTF-8 file and exposes raw, canonical, and hashed forms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-chat2codex-canonical-text-'));
    roots.push(root);
    const path = join(root, 'policy.md');
    await writeFile(path, Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('title\r\n', 'utf8')]));
    const result = await readCanonicalGovernanceText(path);
    expect(result.rawBytes).toEqual(await readFile(path));
    expect(result.text).toBe('\uFEFFtitle\r\n');
    expect(result.canonicalText).toBe('title\n');
    expect(result.canonicalBytes).toEqual(Buffer.from('title\n', 'utf8'));
    expect(result.sha256).toBe(expectedHash('title\n'));
  });
});
