import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ArchitectureFreezeBlock } from '../../shared/protocol/writing-block.js';
import { AtomicTextFileStore } from '../state/persistence.js';
import { assertSafeProjectPath, realProjectRoot, resolveProjectPath } from '../security/path-safety.js';

export interface ArchitectureRevisionRecord {
  freeze_id: string;
  version: string | number;
  url: string;
  sha256: string;
  source: string;
  path: string;
  reason: string;
  affected_scope: string[];
  luna_follow_up: string;
  [key: string]: unknown;
}

export interface ArchitectureIndex {
  schema_version: 1;
  revisions: ArchitectureRevisionRecord[];
  [key: string]: unknown;
}

export interface ArchitectureFreezeDownloadResult {
  added: ArchitectureRevisionRecord[];
  skipped: string[];
  indexPath: string;
}

export interface ArchitectureFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  redirected?: boolean;
  url?: string;
}

export type ArchitectureFetch = (url: string, init: { redirect: 'manual' }) => Promise<ArchitectureFetchResponse>;
export type HostResolver = (hostname: string) => Promise<string[]>;

export interface ArchitectureFreezeDownloaderOptions {
  architectureDirectory?: string;
  indexPath?: string;
  maxBytes?: number;
  fetch?: ArchitectureFetch;
  resolveHost?: HostResolver;
  source?: string;
}

export type ArchitectureFreezeErrorCode =
  | 'ARCHITECTURE_FREEZE_INVALID'
  | 'ARCHITECTURE_FREEZE_DUPLICATE_CONFLICT'
  | 'ARCHITECTURE_FREEZE_URL_INVALID'
  | 'ARCHITECTURE_FREEZE_PRIVATE_HOST'
  | 'ARCHITECTURE_FREEZE_REDIRECT_REJECTED'
  | 'ARCHITECTURE_FREEZE_FETCH_FAILED'
  | 'ARCHITECTURE_FREEZE_RESPONSE_INVALID'
  | 'ARCHITECTURE_FREEZE_CONTENT_TYPE_INVALID'
  | 'ARCHITECTURE_FREEZE_TOO_LARGE'
  | 'ARCHITECTURE_FREEZE_CONTENT_UNREADABLE'
  | 'ARCHITECTURE_FREEZE_HASH_MISMATCH'
  | 'ARCHITECTURE_FREEZE_PATH_UNSAFE'
  | 'ARCHITECTURE_FREEZE_COMMIT_FAILED';

export class ArchitectureFreezeError extends Error {
  readonly code: ArchitectureFreezeErrorCode;

  constructor(code: ArchitectureFreezeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ArchitectureFreezeError';
    this.code = code;
  }
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const ARCHITECTURE_SCHEMA_VERSION = 1 as const;

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second !== undefined && second >= 64 && second <= 127) ||
    (first === 198 && second !== undefined && second >= 18 && second <= 19) ||
    first >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  );
}

function mappedIpv4(address: string): string | null {
  const normalized = address.toLowerCase();
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized)?.[1];
  if (dotted !== undefined && isIP(dotted) === 4) return dotted;

  const hexadecimal = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (hexadecimal === null) return null;
  const high = Number.parseInt(hexadecimal[1]!, 16);
  const low = Number.parseInt(hexadecimal[2]!, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) === 6) {
    const mapped = mappedIpv4(address);
    return mapped === null ? isPrivateIpv6(address) : isPrivateIpv4(mapped);
  }
  return false;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const result = await lookup(hostname, { all: true, verbatim: true });
  return result.map((entry) => entry.address);
}

function assertSafeUrl(rawUrl: string, resolveHost: HostResolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new ArchitectureFreezeError('ARCHITECTURE_FREEZE_URL_INVALID', `Architecture URL is invalid: ${rawUrl}`, {
      cause: error,
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ArchitectureFreezeError('ARCHITECTURE_FREEZE_URL_INVALID', 'Architecture URLs must use http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ArchitectureFreezeError(
      'ARCHITECTURE_FREEZE_URL_INVALID',
      'Architecture URLs must not contain credentials',
    );
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new ArchitectureFreezeError(
      'ARCHITECTURE_FREEZE_PRIVATE_HOST',
      `Private architecture host is not allowed: ${hostname}`,
    );
  }
  if (isPrivateAddress(hostname)) {
    throw new ArchitectureFreezeError(
      'ARCHITECTURE_FREEZE_PRIVATE_HOST',
      `Private architecture host is not allowed: ${hostname}`,
    );
  }
  // The resolver check blocks known private answers, but a plain fetch may
  // resolve again later. Without a custom connector bound to the checked IP,
  // DNS rebinding cannot be completely prevented; keep this as a diagnostic
  // limitation of the fetch boundary rather than claiming a full guarantee.
  return resolveHost(hostname)
    .then((addresses) => {
      if (addresses.some(isPrivateAddress)) {
        throw new ArchitectureFreezeError(
          'ARCHITECTURE_FREEZE_PRIVATE_HOST',
          `Architecture host resolves to a private address: ${hostname}`,
        );
      }
      return url;
    })
    .catch((error: unknown) => {
      if (error instanceof ArchitectureFreezeError) throw error;
      throw new ArchitectureFreezeError(
        'ARCHITECTURE_FREEZE_URL_INVALID',
        `Architecture host could not be verified: ${hostname}`,
        {
          cause: error,
        },
      );
    });
}

function header(response: ArchitectureFetchResponse, name: string): string | null {
  return response.headers.get(name) ?? response.headers.get(name.toLowerCase());
}

function safeVersionSegment(version: string | number): string {
  return (
    String(version)
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '_') || 'version'
  );
}

function safeFreezeSegment(freezeId: string): string {
  return freezeId.trim().replace(/[^a-zA-Z0-9._-]+/g, '_') || 'freeze';
}

function assertSafeArchitecturePath(projectRoot: string, candidate: string): Promise<string> {
  try {
    const resolvedPath = resolveProjectPath(projectRoot, candidate);
    return assertSafeProjectPath(projectRoot, resolvedPath).catch((error: unknown) => {
      throw new ArchitectureFreezeError(
        'ARCHITECTURE_FREEZE_PATH_UNSAFE',
        `Architecture path is not safe: ${candidate}`,
        {
          cause: error,
        },
      );
    });
  } catch (error) {
    throw new ArchitectureFreezeError(
      'ARCHITECTURE_FREEZE_PATH_UNSAFE',
      `Architecture path is outside project: ${candidate}`,
      {
        cause: error,
      },
    );
  }
}

async function loadIndex(indexPath: string, projectRoot: string): Promise<ArchitectureIndex> {
  const safeIndexPath = await assertSafeArchitecturePath(projectRoot, indexPath);
  let source: string;
  try {
    source = await readFile(safeIndexPath, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { schema_version: ARCHITECTURE_SCHEMA_VERSION, revisions: [] };
    throw new ArchitectureFreezeError(
      'ARCHITECTURE_FREEZE_COMMIT_FAILED',
      `Could not read architecture index: ${indexPath}`,
      {
        cause: error,
      },
    );
  }
  try {
    const value: unknown = parseYaml(source);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('index is not an object');
    const record = value as Record<string, unknown>;
    if (record.schema_version !== ARCHITECTURE_SCHEMA_VERSION || !Array.isArray(record.revisions)) {
      throw new Error('unsupported architecture index');
    }
    return record as ArchitectureIndex;
  } catch (error) {
    throw new ArchitectureFreezeError(
      'ARCHITECTURE_FREEZE_COMMIT_FAILED',
      `Architecture index is invalid: ${indexPath}`,
      {
        cause: error,
      },
    );
  }
}

function sameFreeze(existing: ArchitectureRevisionRecord, freeze: ArchitectureFreezeBlock): boolean {
  return (
    existing.version === freeze.fields.version &&
    existing.url === freeze.fields.download_url &&
    (freeze.fields.sha256_if_known === null || existing.sha256 === freeze.fields.sha256_if_known.toLowerCase())
  );
}

export class ArchitectureFreezeDownloader {
  private readonly projectRoot: string;
  private readonly architectureDirectory: string;
  private readonly indexPath: string;
  private readonly maxBytes: number;
  private readonly fetch: ArchitectureFetch;
  private readonly resolveHost: HostResolver;
  private readonly source: string;

  constructor(projectRoot: string, options: ArchitectureFreezeDownloaderOptions = {}) {
    this.projectRoot = resolve(projectRoot);
    this.architectureDirectory = options.architectureDirectory ?? 'docs/governance/architecture';
    this.indexPath = options.indexPath ?? `${this.architectureDirectory}/architecture-index.yaml`;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.fetch = options.fetch ?? (globalThis.fetch as unknown as ArchitectureFetch);
    this.resolveHost = options.resolveHost ?? defaultResolveHost;
    this.source = options.source ?? 'Sol Writing Block';
  }

  async download(freezes: ArchitectureFreezeBlock[]): Promise<ArchitectureFreezeDownloadResult> {
    await realProjectRoot(this.projectRoot);
    await assertSafeArchitecturePath(this.projectRoot, this.architectureDirectory);
    await assertSafeArchitecturePath(this.projectRoot, this.indexPath);
    await mkdir(resolve(this.projectRoot, this.architectureDirectory), { recursive: true });
    const index = await loadIndex(this.indexPath, this.projectRoot);
    const skipped: string[] = [];
    const pending: ArchitectureFreezeBlock[] = [];
    for (const freeze of freezes) {
      const existing = index.revisions.find((revision) => revision.freeze_id === freeze.fields.freeze_id);
      if (existing !== undefined) {
        if (!sameFreeze(existing, freeze)) {
          throw new ArchitectureFreezeError(
            'ARCHITECTURE_FREEZE_DUPLICATE_CONFLICT',
            `freeze_id conflicts with an existing freeze: ${freeze.fields.freeze_id}`,
          );
        }
        skipped.push(freeze.fields.freeze_id);
      } else if (pending.some((item) => item.fields.freeze_id === freeze.fields.freeze_id)) {
        throw new ArchitectureFreezeError(
          'ARCHITECTURE_FREEZE_DUPLICATE_CONFLICT',
          `freeze_id is repeated in the round: ${freeze.fields.freeze_id}`,
        );
      } else {
        pending.push(freeze);
      }
    }
    if (pending.length === 0) return { added: [], skipped, indexPath: this.indexPath };

    const stageDirectory = await mkdtemp(resolve(this.projectRoot, this.architectureDirectory, '.freeze-stage-'));
    const downloaded: Array<{ freeze: ArchitectureFreezeBlock; bytes: Buffer; hash: string }> = [];
    try {
      for (const freeze of pending) {
        const url = await assertSafeUrl(freeze.fields.download_url, this.resolveHost);
        let response: ArchitectureFetchResponse;
        try {
          response = await this.fetch(url.toString(), { redirect: 'manual' });
        } catch (error) {
          throw new ArchitectureFreezeError(
            'ARCHITECTURE_FREEZE_FETCH_FAILED',
            `Could not download architecture freeze: ${freeze.fields.freeze_id}`,
            { cause: error },
          );
        }
        if ((response.status >= 300 && response.status < 400) || response.redirected === true) {
          throw new ArchitectureFreezeError(
            'ARCHITECTURE_FREEZE_REDIRECT_REJECTED',
            `Redirects are not allowed for architecture freeze: ${freeze.fields.freeze_id}`,
          );
        }
        if (response.status < 200 || response.status >= 300) {
          throw new ArchitectureFreezeError(
            'ARCHITECTURE_FREEZE_RESPONSE_INVALID',
            `Architecture download returned HTTP ${response.status}`,
          );
        }
        if (response.url !== undefined && response.url !== '' && response.url !== url.toString()) {
          throw new ArchitectureFreezeError(
            'ARCHITECTURE_FREEZE_REDIRECT_REJECTED',
            `Architecture download changed URL: ${freeze.fields.freeze_id}`,
          );
        }
        const contentType = ((header(response, 'content-type') ?? '').split(';', 1)[0] ?? '').trim().toLowerCase();
        if (contentType !== 'text/plain' && contentType !== 'text/markdown' && contentType !== 'text/x-markdown') {
          throw new ArchitectureFreezeError(
            'ARCHITECTURE_FREEZE_CONTENT_TYPE_INVALID',
            `Unsupported architecture content type: ${contentType || '[missing]'}`,
          );
        }
        const declaredLength = Number(header(response, 'content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > this.maxBytes) {
          throw new ArchitectureFreezeError(
            'ARCHITECTURE_FREEZE_TOO_LARGE',
            `Architecture document exceeds ${this.maxBytes} bytes`,
          );
        }
        let bytes: Buffer;
        try {
          bytes = Buffer.from(await response.arrayBuffer());
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (text.includes('\u0000')) throw new Error('binary content');
        } catch (error) {
          throw new ArchitectureFreezeError(
            'ARCHITECTURE_FREEZE_CONTENT_UNREADABLE',
            `Architecture document is not readable: ${freeze.fields.freeze_id}`,
            { cause: error },
          );
        }
        if (bytes.byteLength > this.maxBytes) {
          throw new ArchitectureFreezeError(
            'ARCHITECTURE_FREEZE_TOO_LARGE',
            `Architecture document exceeds ${this.maxBytes} bytes`,
          );
        }
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (freeze.fields.sha256_if_known !== null && freeze.fields.sha256_if_known.toLowerCase() !== hash) {
          throw new ArchitectureFreezeError(
            'ARCHITECTURE_FREEZE_HASH_MISMATCH',
            `Architecture hash mismatch: ${freeze.fields.freeze_id}`,
          );
        }
        const stageFile = resolve(stageDirectory, `${safeFreezeSegment(freeze.fields.freeze_id)}.md`);
        await writeFile(stageFile, bytes, { flag: 'wx', mode: 0o600 });
        downloaded.push({ freeze, bytes, hash });
      }

      const addedRecords: ArchitectureRevisionRecord[] = [];
      const addedPaths: string[] = [];
      const createdDirectories = new Set<string>();
      try {
        for (const item of downloaded) {
          const versionDirectory = `${this.architectureDirectory}/versions/${safeVersionSegment(item.freeze.fields.version)}`;
          const versionDirectoryPath = await assertSafeArchitecturePath(this.projectRoot, versionDirectory);
          await mkdir(versionDirectoryPath, { recursive: true });
          createdDirectories.add(versionDirectoryPath);
          const targetRelativePath = `${versionDirectory}/${safeFreezeSegment(item.freeze.fields.freeze_id)}.md`;
          const targetPath = await assertSafeArchitecturePath(this.projectRoot, targetRelativePath);
          await rename(resolve(stageDirectory, `${safeFreezeSegment(item.freeze.fields.freeze_id)}.md`), targetPath);
          addedPaths.push(targetRelativePath);
          addedRecords.push({
            ...item.freeze.extensions,
            freeze_id: item.freeze.fields.freeze_id,
            version: item.freeze.fields.version,
            url: item.freeze.fields.download_url,
            sha256: item.hash,
            source: this.source,
            path: targetRelativePath,
            reason: item.freeze.fields.reason,
            affected_scope: [...item.freeze.fields.affected_scope],
            luna_follow_up: item.freeze.fields.luna_follow_up,
          });
        }
        const nextIndex: ArchitectureIndex = {
          ...index,
          schema_version: ARCHITECTURE_SCHEMA_VERSION,
          revisions: [...index.revisions, ...addedRecords],
        };
        const indexStore = new AtomicTextFileStore(resolveProjectPath(this.projectRoot, this.indexPath), {
          beforeOperation: async () => {
            await assertSafeArchitecturePath(this.projectRoot, this.indexPath);
            await mkdir(resolve(this.projectRoot, this.architectureDirectory), { recursive: true });
          },
        });
        await indexStore.save(stringifyYaml(nextIndex));
        return { added: addedRecords, skipped, indexPath: this.indexPath };
      } catch (error) {
        for (const path of addedPaths) {
          try {
            await rm(await assertSafeArchitecturePath(this.projectRoot, path), { force: true });
          } catch {
            // Preserve the original commit error.
          }
        }
        for (const directory of createdDirectories) {
          try {
            await rm(directory, { recursive: true, force: false });
          } catch {
            // Existing version directories are intentionally left in place.
          }
        }
        throw new ArchitectureFreezeError(
          'ARCHITECTURE_FREEZE_COMMIT_FAILED',
          'Architecture freeze commit failed; staged files were rolled back',
          { cause: error },
        );
      }
    } finally {
      await rm(stageDirectory, { recursive: true, force: true });
    }
  }
}

export async function downloadArchitectureFreezes(
  projectRoot: string,
  freezes: ArchitectureFreezeBlock[],
  options: ArchitectureFreezeDownloaderOptions = {},
): Promise<ArchitectureFreezeDownloadResult> {
  return new ArchitectureFreezeDownloader(projectRoot, options).download(freezes);
}
