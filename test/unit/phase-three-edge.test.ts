import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EdgeProfileManager, locateEdgeExecutable } from '../../src/main/edge/profile.js';
import {
  EdgeStateAdapter,
  hasIncompleteWritingBlock,
  selectChatGptProjectTargets,
} from '../../src/main/edge/state-adapter.js';
import { SolBindingError, SolSessionBindingStore } from '../../src/main/edge/session-binding.js';
import type { CdpTransport, EdgeProcess, EdgeSolObservation, SolSessionState } from '../../src/main/edge/types.js';

class MemoryStore {
  value: SolSessionState | null = null;
  async load(): Promise<SolSessionState | null> {
    return this.value;
  }
  async save(value: SolSessionState): Promise<void> {
    this.value = value;
  }
}

function observation(overrides: Partial<EdgeSolObservation> = {}): EdgeSolObservation {
  return {
    targetId: 'target-1',
    title: 'Sol',
    url: 'https://chatgpt.com/g/project-1/c/conversation-1',
    projectFingerprint: 'project-1',
    accountFingerprint: 'account-1',
    latestAssistantText: 'hello',
    latestAssistantHash: 'hash-1',
    statusText: '',
    errorText: '',
    loginWall: false,
    sessionMissing: false,
    contextLimit: false,
    networkError: false,
    isThinking: false,
    writingBlockIncomplete: false,
    sampledAt: '2026-09-10T00:00:00.000Z',
    status: 'COMPLETED_CANDIDATE',
    adapterVersion: 'test',
    consecutiveStableSamples: 2,
    ...overrides,
  };
}

class FakeTransport implements CdpTransport {
  value: Record<string, unknown> = {
    title: 'Sol',
    url: 'https://chatgpt.com/g/project-1/c/conversation-1',
    projectFingerprint: 'project-1',
    accountFingerprint: 'account-1',
    latestAssistantText: 'stream',
    statusText: '',
    errorText: '',
    isThinking: false,
  };
  async listTargets() {
    return [{ id: 'target-1', type: 'page', title: 'Sol', url: String(this.value.url) }];
  }
  async evaluate<T = unknown>(): Promise<T> {
    return this.value as T;
  }
  async sendCommand<T = unknown>(): Promise<T> {
    return {} as T;
  }
}

describe('dedicated Edge profile and CDP state adapter', () => {
  it('locates configured Edge and starts with an isolated profile and shell:false', async () => {
    await expect(
      locateEdgeExecutable({ executablePath: 'C:\\Edge\\msedge.exe', fileExists: async () => true }),
    ).resolves.toBe('C:\\Edge\\msedge.exe');
    const calls: { file: string; args: readonly string[]; options: unknown }[] = [];
    const process: EdgeProcess = {
      exitCode: null,
      kill: () => true,
      once: () => undefined,
    };
    const manager = new EdgeProfileManager({
      executablePath: 'C:\\Edge\\msedge.exe',
      userDataDirectory: 'C:\\app\\edge-profile',
      remoteDebuggingPort: 9333,
      fileExists: async () => true,
      debugPortProbe: async () => false,
      waitForDebugPort: async () => true,
      processRunner: (file, args, options) => {
        calls.push({ file, args, options });
        return process;
      },
    });
    const handle = await manager.startOrReuse();
    expect(handle.reused).toBe(false);
    expect(calls[0]).toMatchObject({ file: 'C:\\Edge\\msedge.exe', options: { shell: false, detached: false } });
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(['--user-data-dir=C:\\app\\edge-profile', '--remote-debugging-port=9333']),
    );
    expect(calls[0]?.args).not.toContain('--enable-automation');
  });

  it('requires two stable samples and never marks an incomplete Writing Block complete', async () => {
    const transport = new FakeTransport();
    const adapter = new EdgeStateAdapter(transport, { stableSampleCount: 2 });
    await expect(adapter.sample('target-1')).resolves.toMatchObject({
      status: 'THINKING',
      consecutiveStableSamples: 1,
    });
    await expect(adapter.sample('target-1')).resolves.toMatchObject({
      status: 'COMPLETED_CANDIDATE',
      consecutiveStableSamples: 2,
    });
    transport.value.latestAssistantText = '[WRITING_BLOCK type="LUNA_TASK"]\n{"task_id":"x"}';
    adapter.reset('target-1');
    await adapter.sample('target-1');
    await expect(adapter.sample('target-1')).resolves.toMatchObject({
      status: 'AMBIGUOUS',
      writingBlockIncomplete: true,
    });
    expect(hasIncompleteWritingBlock('[WRITING_BLOCK]x[/WRITING_BLOCK]')).toBe(false);
  });

  it('persists an ownership token and rejects an external process on a reused port', async () => {
    const profileDirectory = await mkdtemp(join(tmpdir(), 'web-chat2codex-edge-'));
    const ownershipFilePath = join(profileDirectory, 'ownership.json');
    const process: EdgeProcess = { exitCode: null, kill: () => true, once: () => undefined };
    const base = {
      executablePath: 'C:\\Edge\\msedge.exe',
      userDataDirectory: profileDirectory,
      ownershipFilePath,
      remoteDebuggingPort: 9444,
      fileExists: async () => true,
    } as const;
    const started = await new EdgeProfileManager({
      ...base,
      debugPortProbe: async () => false,
      waitForDebugPort: async () => true,
      processRunner: () => process,
    }).startOrReuse();
    expect(started.ownershipToken).toBeTruthy();

    await expect(
      new EdgeProfileManager({
        ...base,
        debugPortProbe: async () => true,
        ownershipProbe: async () => false,
      }).startOrReuse(),
    ).rejects.toMatchObject({ code: 'EDGE_PROFILE_OWNERSHIP_INVALID' });
    await expect(
      new EdgeProfileManager({
        ...base,
        debugPortProbe: async () => true,
        ownershipProbe: async (_port, ownership) => ownership.token === started.ownershipToken,
      }).startOrReuse(),
    ).resolves.toMatchObject({ reused: true, ownershipToken: started.ownershipToken });
  });

  it('classifies explicit auth, network, context and lost-session signals', async () => {
    const transport = new FakeTransport();
    const adapter = new EdgeStateAdapter(transport);
    for (const [field, status] of [
      ['loginWall', 'AUTH_REQUIRED'],
      ['networkError', 'NETWORK_ERROR'],
      ['contextLimit', 'CONTEXT_LIMIT'],
      ['sessionMissing', 'SESSION_LOST'],
    ] as const) {
      transport.value = { ...transport.value, [field]: true };
      await expect(adapter.sample('target-1')).resolves.toMatchObject({ status });
      transport.value = { ...transport.value, [field]: false };
    }
  });

  it('does not infer Project identity from an untrusted hostname and selects only known identities', async () => {
    const transport = new FakeTransport();
    transport.value = {
      ...transport.value,
      url: 'https://chatgpt.com.evil.example/g/project-from-url/c/c1',
      projectFingerprint: 'project-from-dom',
      accountFingerprint: 'account-1',
    };
    const adapter = new EdgeStateAdapter(transport);
    await expect(adapter.readPage('target-1')).resolves.toMatchObject({
      url: 'https://chatgpt.com.evil.example/g/project-from-url/c/c1',
      projectFingerprint: null,
      accountFingerprint: null,
    });
    await expect(selectChatGptProjectTargets(transport, adapter)).resolves.toEqual([]);
  });

  it('binds the current message only as baseline and blocks identity mismatches', async () => {
    const store = new SolSessionBindingStore({
      store: new MemoryStore(),
      now: () => new Date('2026-09-10T00:00:00.000Z'),
    });
    const state = await store.bind(observation(), 'conversation-1');
    expect(state.baselineMessageHash).toBe('hash-1');
    expect(state.lastRawInput).toBeNull();
    expect(state.conversationChain).toHaveLength(1);
    await expect(
      Promise.resolve().then(() =>
        store.assertCanSend({
          projectFingerprint: 'other',
          accountFingerprint: 'account-1',
          conversationId: 'conversation-1',
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' });
    await expect(
      Promise.resolve().then(() =>
        store.assertCanSend({
          projectFingerprint: 'project-1',
          accountFingerprint: 'other',
          conversationId: 'conversation-1',
        }),
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
    await expect(
      Promise.resolve().then(() =>
        store.assertCanSend({
          projectFingerprint: 'project-1',
          accountFingerprint: 'account-1',
          conversationId: 'conversation-2',
        }),
      ),
    ).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });
    expect(SolBindingError).toBeDefined();
  });

  it('rejects a binding when the account identity is unknown', async () => {
    const store = new SolSessionBindingStore({ store: new MemoryStore() });
    await expect(store.bind(observation({ accountFingerprint: null }))).rejects.toMatchObject({
      code: 'INVALID_BINDING',
    });
  });
});
