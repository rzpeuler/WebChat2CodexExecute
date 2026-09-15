import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const workspace = resolve(import.meta.dirname, '..', '..');
const bridgeUrl = pathToFileURL(join(workspace, 'skills', 'sol-engineering-loop', 'scripts', 'sol-bridge', 'sol-bridge.mjs')).href;
const ioUrl = pathToFileURL(join(workspace, 'skills', 'sol-engineering-loop', 'scripts', 'sol-bridge', 'lib', 'io.mjs')).href;
const securityUrl = pathToFileURL(join(workspace, 'skills', 'sol-engineering-loop', 'scripts', 'sol-bridge', 'lib', 'security.mjs')).href;
type BridgeModule = {
  runCommand: (command: string, input: Record<string, unknown>, overrides?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  classifyPendingDelivery: (pending: { message_hash: string; pre_send_latest_user_hash: string }, current: string) => string;
};
type IoModule = {
  loadJsonWithBackup: (path: string, validate?: (value: unknown) => boolean) => Promise<{ value: unknown; source: string }>;
};
type SecurityModule = { hashText: (value: string) => string };
const { runCommand, classifyPendingDelivery } = await import(bridgeUrl) as BridgeModule;
const { loadJsonWithBackup } = await import(ioUrl) as IoModule;
const { hashText } = await import(securityUrl) as SecurityModule;

const temporaryDirectories: string[] = [];
const target = { id: 'target-1', type: 'page', title: 'Bound conversation', url: 'https://chatgpt.com/c/conversation-1' };
const identity = { project_fingerprint: 'project-1', account_fingerprint: 'account-1', conversation_id: 'conversation-1' };

function capture(latestAssistantHash: string, latestUserHash: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    latest_assistant_text: `assistant-${latestAssistantHash}`,
    latest_assistant_hash: latestAssistantHash,
    latest_user_text: `user-${latestUserHash}`,
    latest_user_hash: latestUserHash,
    is_thinking: false,
    login_required: false,
    identity,
    ...extra,
  };
}

function fakeProfile() {
  return { ensure: async () => ({ browser_running: true, endpoint: {} }) };
}

function fakeTransport() {
  return {
    listTargets: async () => [target],
    evaluate: async () => ({ ok: true, composerEmpty: true }),
    sendCommand: async () => ({}),
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'sol-bridge-v1-'));
  temporaryDirectories.push(path);
  return path;
}

async function bind(root: string, captureTarget = async () => capture('H', 'A')): Promise<void> {
  const result = await runCommand('bind', { state_dir: root }, { profile: fakeProfile(), transport: fakeTransport(), captureTarget });
  expect(result.ok, JSON.stringify(result)).toBe(true);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Sol Bridge V1.1 deterministic contract', () => {
  it('keeps the renamed package and all ADL V1 deterministic tools', async () => {
    await expect(stat(join(workspace, 'skills', 'sol-engineering-loop', 'SKILL.md'))).resolves.toBeTruthy();
    await expect(stat(join(workspace, 'skills', 'autonomous-development-loop'))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const name of ['inspect-baseline', 'validate-governance', 'check-protected-paths', 'validate-task-report', 'verify-remote', 'safe-git-sync']) {
      await expect(stat(join(workspace, 'skills', 'sol-engineering-loop', 'scripts', `${name}.mjs`))).resolves.toBeTruthy();
    }
  });

  it('waits after an unchanged hash and returns the first new stable assistant output', async () => {
    const root = await temporaryDirectory();
    await bind(root);
    const values = ['H', 'H', 'H', 'B', 'B'];
    let calls = 0;
    const result = await runCommand('read', { state_dir: root, after_hash: 'H', wait_ms: 100, stable_sample_count: 2 }, {
      profile: fakeProfile(),
      transport: fakeTransport(),
      captureTarget: async () => capture(values[Math.min(calls++, values.length - 1)]!, 'A'),
    });
    expect(result.code).toBe('ASSISTANT_OUTPUT_READY');
    expect(calls).toBeGreaterThanOrEqual(5);
  });

  it('distinguishes no-change deadline from changed-but-unstable timeout', async () => {
    const unchangedRoot = await temporaryDirectory();
    await bind(unchangedRoot);
    let unchangedCalls = 0;
    const unchanged = await runCommand('read', { state_dir: unchangedRoot, after_hash: 'H', wait_ms: 45 }, {
      profile: fakeProfile(), transport: fakeTransport(), captureTarget: async () => { unchangedCalls += 1; return capture('H', 'A'); },
    });
    expect(unchanged.code).toBe('NO_NEW_ASSISTANT_OUTPUT');
    expect(unchangedCalls).toBeGreaterThan(2);

    const unstableRoot = await temporaryDirectory();
    await bind(unstableRoot);
    let index = 0;
    const unstable = await runCommand('read', { state_dir: unstableRoot, after_hash: 'H', wait_ms: 45 }, {
      profile: fakeProfile(), transport: fakeTransport(), captureTarget: async () => capture(['B', 'C', 'B', 'C'][index++ % 4]!, 'A'),
    });
    expect(unstable.code).toBe('READ_TIMEOUT');
  });

  it('does not treat reading as consumption after a crash or on a later observation', async () => {
    const root = await temporaryDirectory();
    await bind(root);
    const overrides = { profile: fakeProfile(), transport: fakeTransport(), captureTarget: async () => capture('H', 'A') };
    const first = await runCommand('read', { state_dir: root }, overrides);
    const second = await runCommand('read', { state_dir: root }, overrides);
    expect(first.code).toBe('ASSISTANT_OUTPUT_READY');
    expect(second.code).toBe('ASSISTANT_OUTPUT_READY');
  });

  it('requires unique complete identity when binding multiple live targets', async () => {
    const root = await temporaryDirectory();
    const transport = { ...fakeTransport(), listTargets: async () => [target, { ...target, id: 'target-2' }] };
    const result = await runCommand('bind', { state_dir: root }, { profile: fakeProfile(), transport, captureTarget: async () => capture('H', 'A') });
    expect(result.code).toBe('BINDING_AMBIGUOUS');
    await expect(stat(join(root, 'sol-binding.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes pending intent before submit and clears it only after confirmation', async () => {
    const root = await temporaryDirectory();
    await bind(root, async () => capture('H', 'A'));
    let pendingVisibleAtSubmit = false;
    const transport = {
      listTargets: async () => [target],
      evaluate: async (_id: string, expression: string) => {
        if (expression.includes('prompt-textarea')) {
          pendingVisibleAtSubmit = await readFile(join(root, 'sol-pending-send.json'), 'utf8').then(() => true).catch(() => false);
          return { ok: true, composerEmpty: true };
        }
        return { ok: true };
      },
      sendCommand: async () => ({}),
    };
    const message = 'send once';
    const result = await runCommand('send', { state_dir: root, text: message }, { profile: fakeProfile(), transport, captureTarget: async () => capture('H', 'A') });
    expect(result.code).toBe('MESSAGE_SENT');
    expect(pendingVisibleAtSubmit).toBe(true);
    await expect(stat(join(root, 'sol-pending-send.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['A', 'B', 'B', 'MESSAGE_ALREADY_DELIVERED'],
    ['A', 'B', 'A', 'SEND_UNCONFIRMED'],
    ['B', 'B', 'B', 'SEND_UNCONFIRMED'],
    ['A', 'B', 'C', 'SEND_UNCONFIRMED'],
  ] as const)('applies pending recovery rule %s without unsafe resend', (pre, message, current, expected) => {
    expect(classifyPendingDelivery({ message_hash: message, pre_send_latest_user_hash: pre }, current)).toBe(expected);
  });

  it('recovers an interrupted pending-state write from a valid backup and rejects both-invalid state', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'pending.json');
    await writeFile(`${path}.bak`, JSON.stringify({ version: 1, state: 'known' }), 'utf8');
    await writeFile(path, '{"version":', 'utf8');
    const recovered = await loadJsonWithBackup(path, (value: unknown) => (value as { version?: number }).version === 1);
    expect(recovered.source).toBe('backup');
    await writeFile(`${path}.bak`, '{"version":', 'utf8');
    const corrupt = await loadJsonWithBackup(path, (value: unknown) => (value as { version?: number }).version === 1);
    expect(corrupt.value).toBeNull();
  });

  it('uses stable content hashes for delivery records', () => {
    expect(hashText('same\r\ntext')).toBe(hashText(' same\ntext '));
    expect(classifyPendingDelivery({ message_hash: hashText('B'), pre_send_latest_user_hash: hashText('A') }, hashText('B'))).toBe('MESSAGE_ALREADY_DELIVERED');
  });
});
