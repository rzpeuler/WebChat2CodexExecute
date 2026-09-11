import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EdgeProfileManager, locateEdgeExecutable } from '../../src/main/edge/profile.js';
import {
  accountFingerprintFromStorageKeys,
  EdgeStateAdapter,
  hasIncompleteWritingBlock,
  hashMessage,
  projectFingerprintFromChatGptUrl,
  selectChatGptProjectTargets,
} from '../../src/main/edge/state-adapter.js';
import { SolBindingError, SolSessionBindingStore } from '../../src/main/edge/session-binding.js';
import { CdpTransportError, HttpCdpTransport } from '../../src/main/edge/cdp.js';
import {
  CLICK_SUBMIT_SCRIPT,
  CdpConversationController,
  prepareMessageScript,
} from '../../src/main/edge/cdp-conversation.js';
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

class FakeWebSocket {
  readyState = 1;
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: Event = new Event(type)): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }

  send(): void {
    // The test drives the connection close before a response arrives.
  }

  close(): void {
    this.readyState = 3;
  }
}

describe('dedicated Edge profile and CDP state adapter', () => {
  it('exposes stable retryable codes for unreachable and malformed CDP responses', async () => {
    const unreachable = new HttpCdpTransport({
      port: 9227,
      fetchImpl: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    });
    await expect(unreachable.listTargets()).rejects.toMatchObject({
      name: 'CdpTransportError',
      code: 'NETWORK_CDP_UNREACHABLE',
    });

    const malformed = new HttpCdpTransport({
      port: 9227,
      fetchImpl: vi.fn(async () => new Response('{malformed', { status: 200 })),
    });
    await expect(malformed.listTargets()).rejects.toMatchObject({
      name: 'CdpTransportError',
      code: 'NETWORK_CDP_INVALID_RESPONSE',
    });
    expect(CdpTransportError).toBeDefined();
  });

  it('bounds CDP fetches and rejects a transport that was closed before use', async () => {
    const timedOut = new HttpCdpTransport({
      port: 9227,
      requestTimeoutMs: 5,
      fetchImpl: vi.fn(() => new Promise<Response>(() => undefined)),
    });
    await expect(timedOut.listTargets()).rejects.toMatchObject({ code: 'NETWORK_CDP_TIMEOUT' });

    const closed = new HttpCdpTransport({ port: 9227, fetchImpl: vi.fn() });
    closed.close();
    await expect(closed.listTargets()).rejects.toMatchObject({
      name: 'CdpTransportError',
      code: 'SESSION_CDP_CLOSED',
    });
  });

  it('rejects a target list containing any malformed target instead of filtering it', async () => {
    const transport = new HttpCdpTransport({
      port: 9227,
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                id: 'target-1',
                type: 'page',
                title: 'Sol',
                url: 'https://chatgpt.com/g/project-1/c/conversation-1',
              },
              { id: 'target-2', type: 'page', title: 'Malformed' },
            ]),
            { status: 200 },
          ),
      ),
    });
    await expect(transport.listTargets()).rejects.toMatchObject({
      name: 'CdpTransportError',
      code: 'SESSION_CDP_INVALID_RESPONSE',
    });
  });

  it('rejects malformed CDP result/error structures instead of adapting them', async () => {
    const socket = new FakeWebSocket();
    socket.send = () => {
      queueMicrotask(() =>
        socket.emit(
          'message',
          new MessageEvent('message', { data: JSON.stringify({ id: 1, result: {}, error: { message: 'bad' } }) }),
        ),
      );
    };
    const transport = new HttpCdpTransport({
      port: 9227,
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                id: 'target-1',
                type: 'page',
                title: 'Sol',
                url: 'https://chatgpt.com/g/project-1/c/conversation-1',
                webSocketDebuggerUrl: 'ws://127.0.0.1:9227/devtools/page/target-1',
              },
            ]),
            { status: 200 },
          ),
      ),
      webSocketFactory: () => socket as unknown as WebSocket,
    });

    await expect(transport.sendCommand('target-1', 'Runtime.evaluate')).rejects.toMatchObject({
      code: 'SESSION_CDP_INVALID_RESPONSE',
    });
  });

  it('classifies a real Edge CDP WebSocket disconnect as retryable session loss', async () => {
    const socket = new FakeWebSocket();
    const transport = new HttpCdpTransport({
      port: 9227,
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                id: 'target-1',
                type: 'page',
                title: 'Sol',
                url: 'https://chatgpt.com/g/project-1/c/conversation-1',
                webSocketDebuggerUrl: 'ws://127.0.0.1:9227/devtools/page/target-1',
              },
            ]),
            { status: 200 },
          ),
      ),
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const command = transport.sendCommand('target-1', 'Runtime.evaluate');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    socket.emit('close');
    await expect(command).rejects.toMatchObject({
      name: 'CdpTransportError',
      code: 'SESSION_CDP_DISCONNECTED',
    });
  });

  it('cancels a pending CDP response when the transport closes', async () => {
    const socket = new FakeWebSocket();
    const transport = new HttpCdpTransport({
      port: 9227,
      socketTimeoutMs: 1_000,
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                id: 'target-1',
                type: 'page',
                title: 'Sol',
                url: 'https://chatgpt.com/g/project-1/c/conversation-1',
                webSocketDebuggerUrl: 'ws://127.0.0.1:9227/devtools/page/target-1',
              },
            ]),
            { status: 200 },
          ),
      ),
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const command = transport.sendCommand('target-1', 'Runtime.evaluate');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    transport.close();
    await expect(command).rejects.toMatchObject({ code: 'SESSION_CDP_CLOSED' });
  });

  it('re-samples the bound target immediately before evaluate and rejects navigation', async () => {
    const evaluate = vi.fn(async <T = unknown>(_: string, expression: string): Promise<T> => {
      if (expression.includes('textarea')) return { sent: true, inputHash: 'unused' } as T;
      return {
        title: 'Sol',
        url: 'https://chatgpt.com/g/project-1/c/conversation-2',
        projectFingerprint: 'project-1',
        accountFingerprint: 'account-1',
        latestAssistantText: '',
        statusText: '',
        errorText: '',
        isThinking: false,
      } as T;
    });
    const transport: CdpTransport = {
      listTargets: vi.fn(async () => [
        {
          id: 'target-1',
          type: 'page',
          title: 'Sol',
          url: 'https://chatgpt.com/g/project-1/c/conversation-2',
        },
      ]),
      evaluate: evaluate as CdpTransport['evaluate'],
      sendCommand: vi.fn(async <T = unknown>() => ({}) as T) as CdpTransport['sendCommand'],
    };
    const controller = new CdpConversationController({ transport, adapter: new EdgeStateAdapter(transport) });

    await expect(
      controller.sendMessage({
        conversation: {
          conversationId: 'conversation-1',
          url: 'https://chatgpt.com/g/project-1/c/conversation-1',
          title: 'Sol',
          projectFingerprint: 'project-1',
          accountFingerprint: 'account-1',
          targetId: 'target-1',
        },
        text: 'hello',
      }),
    ).rejects.toMatchObject({ code: 'SESSION_CONVERSATION_IDENTITY_CHANGED' });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0]?.[1]).not.toContain('textarea');
  });

  it('confirms a Sol message after the DOM submission before returning success', async () => {
    const evaluate = vi.fn(async <T = unknown>(_: string, expression: string): Promise<T> => {
      if (expression.includes('const value')) {
        return { prepared: true, inputHash: hashMessage('hello'), inputKind: 'contenteditable' } as T;
      }
      if (expression.includes('const submit')) {
        return { clicked: true, composerEmpty: true } as T;
      }
      return {
        title: 'Sol',
        url: 'https://chatgpt.com/g/project-1/c/conversation-1',
        projectFingerprint: 'project-1',
        accountFingerprint: 'account-1',
        latestAssistantText: 'hello',
        statusText: '',
        errorText: '',
        isThinking: false,
      } as T;
    });
    const transport: CdpTransport = {
      listTargets: vi.fn(async () => [
        { id: 'target-1', type: 'page', title: 'Sol', url: 'https://chatgpt.com/g/project-1/c/conversation-1' },
      ]),
      evaluate: evaluate as CdpTransport['evaluate'],
      sendCommand: vi.fn(async <T = unknown>() => ({}) as T) as CdpTransport['sendCommand'],
    };
    const controller = new CdpConversationController({ transport, adapter: new EdgeStateAdapter(transport) });

    await expect(
      controller.sendMessage({
        conversation: {
          conversationId: 'conversation-1',
          url: 'https://chatgpt.com/g/project-1/c/conversation-1',
          title: 'Sol',
          projectFingerprint: 'project-1',
          accountFingerprint: 'account-1',
          targetId: 'target-1',
        },
        text: 'hello',
      }),
    ).resolves.toBeUndefined();
    expect(evaluate).toHaveBeenCalledWith('target-1', expect.stringContaining('const value'));
    expect(transport.sendCommand).toHaveBeenCalledWith('target-1', 'Input.insertText', { text: 'hello' });
  });

  it('rejects an unconfirmed Sol submission instead of reporting it as sent', async () => {
    const evaluate = vi.fn(async <T = unknown>(_: string, expression: string): Promise<T> => {
      if (expression.includes('const value')) {
        return { prepared: true, inputHash: hashMessage('hello'), inputKind: 'contenteditable' } as T;
      }
      if (expression.includes('const submit')) {
        return { clicked: true, composerEmpty: false } as T;
      }
      if (expression.includes('return { empty')) return { empty: false } as T;
      return {
        title: 'Sol',
        url: 'https://chatgpt.com/g/project-1/c/conversation-1',
        projectFingerprint: 'project-1',
        accountFingerprint: 'account-1',
        latestAssistantText: 'hello',
        statusText: '',
        errorText: '',
        isThinking: false,
      } as T;
    });
    const transport: CdpTransport = {
      listTargets: vi.fn(async () => [
        { id: 'target-1', type: 'page', title: 'Sol', url: 'https://chatgpt.com/g/project-1/c/conversation-1' },
      ]),
      evaluate: evaluate as CdpTransport['evaluate'],
      sendCommand: vi.fn(async <T = unknown>() => ({}) as T) as CdpTransport['sendCommand'],
    };
    const controller = new CdpConversationController({
      transport,
      adapter: new EdgeStateAdapter(transport),
      submissionConfirmationTimeoutMs: 1,
    });

    await expect(
      controller.sendMessage({
        conversation: {
          conversationId: 'conversation-1',
          url: 'https://chatgpt.com/g/project-1/c/conversation-1',
          title: 'Sol',
          projectFingerprint: 'project-1',
          accountFingerprint: 'account-1',
          targetId: 'target-1',
        },
        text: 'hello',
      }),
    ).rejects.toMatchObject({ code: 'SOL_INPUT_SUBMIT_UNCONFIRMED' });
  });

  it('targets the visible composer and never falls back to submitting an empty form', () => {
    expect(prepareMessageScript('hello')).toContain('#prompt-textarea[contenteditable="true"]');
    expect(CLICK_SUBMIT_SCRIPT).not.toContain('requestSubmit');
  });

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

  it('bounds and classifies the default Edge ownership probes', async () => {
    const profileDirectory = await mkdtemp(join(tmpdir(), 'web-chat2codex-edge-ownership-timeout-'));
    const ownershipFilePath = join(profileDirectory, 'ownership.json');
    const process: EdgeProcess = { exitCode: null, kill: () => true, once: () => undefined };
    const base = {
      executablePath: 'C:\\Edge\\msedge.exe',
      userDataDirectory: profileDirectory,
      ownershipFilePath,
      remoteDebuggingPort: 9555,
      fileExists: async () => true,
      debugPortProbe: async () => false,
      waitForDebugPort: async () => true,
      processRunner: () => process,
    } as const;
    await new EdgeProfileManager(base).startOrReuse();

    await expect(
      new EdgeProfileManager({
        ...base,
        debugPortProbe: async () => true,
        ownershipTimeoutMs: 5,
        ownershipFetchImpl: vi.fn(() => new Promise<Response>(() => undefined)),
      }).startOrReuse(),
    ).rejects.toMatchObject({ code: 'EDGE_OWNERSHIP_TIMEOUT' });

    const closedSocket = new FakeWebSocket();
    closedSocket.readyState = 3;
    await expect(
      new EdgeProfileManager({
        ...base,
        debugPortProbe: async () => true,
        ownershipFetchImpl: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                Browser: 'Microsoft Edge/140.0',
                webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/browser/test',
              }),
              { status: 200 },
            ),
        ),
        ownershipWebSocketFactory: () => closedSocket as unknown as WebSocket,
      }).startOrReuse(),
    ).rejects.toMatchObject({ code: 'EDGE_OWNERSHIP_DISCONNECTED' });
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

  it('derives Project identity from a safe conversation URL and account identity from storage keys', async () => {
    expect(projectFingerprintFromChatGptUrl('https://chatgpt.com/g/g-p-project/c/conversation')).toBe('g-p-project');
    expect(projectFingerprintFromChatGptUrl('https://chatgpt.com/g/g-p-project')).toBeNull();
    expect(
      projectFingerprintFromChatGptUrl('https://chatgpt.com.evil.example/g/g-p-project/c/conversation'),
    ).toBeNull();
    expect(
      accountFingerprintFromStorageKeys([
        'cache/user-arT9Q0ywHCEhyx8lT1ngq4v8/19e598c2-16a6-4232-8880-6165eb609c5d/conversation-history',
      ]),
    ).toBe('user-arT9Q0ywHCEhyx8lT1ngq4v8');
    expect(accountFingerprintFromStorageKeys(['oai/apps/lastUtmCampaign'])).toBeNull();
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
