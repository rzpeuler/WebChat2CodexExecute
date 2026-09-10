import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ArchitectureFreezeDownloader,
  ArchitectureFreezeError,
} from '../../src/main/architecture/freeze-downloader.js';
import { parseWritingBlock, type ArchitectureFreezeBlock } from '../../src/shared/protocol/writing-block.js';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'web-chat2codex-architecture-'));
  directories.push(root);
  return root;
}

function freeze(fields: Record<string, unknown>): ArchitectureFreezeBlock {
  const body = {
    freeze_id: 'freeze-1',
    version: 1,
    download_url: 'https://architecture.example/freeze.md',
    sha256_if_known: null,
    reason: 'freeze architecture',
    affected_scope: ['src'],
    luna_follow_up: 'Use the frozen document.',
    ...fields,
  };
  return parseWritingBlock(
    `[WRITING_BLOCK type="ARCHITECTURE_FREEZE"]\n${JSON.stringify(body)}\n[/WRITING_BLOCK]`,
  ) as ArchitectureFreezeBlock;
}

function response(
  body: string,
  contentType = 'text/markdown',
  status = 200,
): {
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
} {
  const bytes = Buffer.from(body, 'utf8');
  return {
    status,
    headers: {
      get: (name) => {
        if (name.toLowerCase() === 'content-type') return contentType;
        if (name.toLowerCase() === 'content-length') return String(bytes.byteLength);
        return null;
      },
    },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

const publicResolver = async (): Promise<string[]> => ['93.184.216.34'];

describe('architecture freeze downloader', () => {
  it('downloads multiple freezes and atomically writes version documents plus index', async () => {
    const root = await project();
    const fetch = vi.fn(async (url: string) => response(url.endsWith('two.md') ? '# Two' : '# One'));
    const first = freeze({ freeze_id: 'freeze-one', version: 7 });
    const second = freeze({ freeze_id: 'freeze-two', version: 7, download_url: 'https://architecture.example/two.md' });
    const result = await new ArchitectureFreezeDownloader(root, { fetch, resolveHost: publicResolver }).download([
      first,
      second,
    ]);

    expect(result.added).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await readFile(join(root, 'docs/governance/architecture/versions/7/freeze-one.md'), 'utf8')).toBe('# One');
    expect(await readFile(join(root, 'docs/governance/architecture/versions/7/freeze-two.md'), 'utf8')).toBe('# Two');
    const index = parseYaml(
      await readFile(join(root, 'docs/governance/architecture/architecture-index.yaml'), 'utf8'),
    ) as {
      revisions: Array<Record<string, unknown>>;
    };
    expect(index.revisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          freeze_id: 'freeze-one',
          version: 7,
          url: 'https://architecture.example/freeze.md',
          source: 'Sol Writing Block',
        }),
        expect.objectContaining({ freeze_id: 'freeze-two', version: 7 }),
      ]),
    );
  });

  it('rolls back all staged files if a later freeze fails', async () => {
    const root = await project();
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('two.md')) throw new Error('network down');
      return response('# One');
    });
    await expect(
      new ArchitectureFreezeDownloader(root, { fetch, resolveHost: publicResolver }).download([
        freeze({ freeze_id: 'freeze-one' }),
        freeze({ freeze_id: 'freeze-two', download_url: 'https://architecture.example/two.md' }),
      ]),
    ).rejects.toMatchObject({ code: 'ARCHITECTURE_FREEZE_FETCH_FAILED' });
    await expect(access(join(root, 'docs/governance/architecture/architecture-index.yaml'))).rejects.toThrow();
    await expect(access(join(root, 'docs/governance/architecture/versions'))).rejects.toThrow();
  });

  it('verifies known hashes, rejects wrong hashes, and does not duplicate an existing freeze', async () => {
    const root = await project();
    const content = '# One';
    const hash = createHash('sha256').update(content).digest('hex');
    const fetch = vi.fn(async () => response(content));
    const downloader = new ArchitectureFreezeDownloader(root, { fetch, resolveHost: publicResolver });
    const item = freeze({ sha256_if_known: hash });
    await expect(downloader.download([item])).resolves.toMatchObject({
      added: [expect.objectContaining({ sha256: hash })],
    });
    await expect(downloader.download([item])).resolves.toMatchObject({ added: [], skipped: ['freeze-1'] });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(downloader.download([freeze({ sha256_if_known: '0'.repeat(64) })])).rejects.toMatchObject({
      code: 'ARCHITECTURE_FREEZE_DUPLICATE_CONFLICT',
    });
  });

  it.each([
    ['file://C:/secret.md', 'ARCHITECTURE_FREEZE_URL_INVALID'],
    ['data:text/plain,secret', 'ARCHITECTURE_FREEZE_URL_INVALID'],
    ['http://localhost/freeze.md', 'ARCHITECTURE_FREEZE_PRIVATE_HOST'],
    ['http://127.0.0.1/freeze.md', 'ARCHITECTURE_FREEZE_PRIVATE_HOST'],
  ])('rejects malicious URL %s', async (url, code) => {
    const root = await project();
    const fetch = vi.fn(async () => response('# not reached'));
    await expect(
      new ArchitectureFreezeDownloader(root, { fetch, resolveHost: publicResolver }).download([
        freeze({ download_url: url }),
      ]),
    ).rejects.toMatchObject({ code });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects redirects, unsupported content, and oversized responses', async () => {
    const root = await project();
    await expect(
      new ArchitectureFreezeDownloader(root, {
        fetch: async () => ({ ...response('# redirect'), status: 302 }),
        resolveHost: publicResolver,
      }).download([freeze({ freeze_id: 'redirect' })]),
    ).rejects.toMatchObject({ code: 'ARCHITECTURE_FREEZE_REDIRECT_REJECTED' });
    await expect(
      new ArchitectureFreezeDownloader(root, {
        fetch: async () => response('<html />', 'text/html'),
        resolveHost: publicResolver,
      }).download([freeze({ freeze_id: 'html' })]),
    ).rejects.toMatchObject({ code: 'ARCHITECTURE_FREEZE_CONTENT_TYPE_INVALID' });
    await expect(
      new ArchitectureFreezeDownloader(root, {
        maxBytes: 2,
        fetch: async () => response('# too large'),
        resolveHost: publicResolver,
      }).download([freeze({ freeze_id: 'large' })]),
    ).rejects.toMatchObject({ code: 'ARCHITECTURE_FREEZE_TOO_LARGE' });
  });

  it('rejects a path outside the project before downloading', async () => {
    const root = await project();
    const fetch = vi.fn(async () => response('# never'));
    await expect(
      new ArchitectureFreezeDownloader(root, {
        architectureDirectory: '../outside',
        fetch,
        resolveHost: publicResolver,
      }).download([freeze({})]),
    ).rejects.toBeInstanceOf(ArchitectureFreezeError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
