import { describe, expect, it } from 'vitest';
import { ActiveSessionRotationManager, ContextRecoveryManager } from '../../src/main/edge/session-rotation.js';
import { hashRawInput, SolSessionBindingStore } from '../../src/main/edge/session-binding.js';
import type {
  EdgeSolObservation,
  SolConversationController,
  SolConversationIdentity,
  SolSessionState,
} from '../../src/main/edge/types.js';

class MemoryStore {
  value: SolSessionState | null = null;
  async load(): Promise<SolSessionState | null> {
    return this.value;
  }
  async save(value: SolSessionState): Promise<void> {
    this.value = JSON.parse(JSON.stringify(value)) as SolSessionState;
  }
}

function observation(status: EdgeSolObservation['status']): EdgeSolObservation {
  return {
    targetId: 'old-target',
    title: 'Sol',
    url: 'https://chatgpt.com/g/project-1/c/old',
    projectFingerprint: 'project-1',
    accountFingerprint: 'account-1',
    latestAssistantText: 'error',
    latestAssistantHash: 'hash',
    statusText: '',
    errorText: 'context window too long',
    loginWall: false,
    sessionMissing: false,
    contextLimit: status === 'CONTEXT_LIMIT',
    networkError: false,
    isThinking: false,
    writingBlockIncomplete: false,
    sampledAt: new Date().toISOString(),
    status,
    adapterVersion: 'test',
    consecutiveStableSamples: 2,
  };
}

function conversation(id: string): SolConversationIdentity {
  return {
    conversationId: id,
    url: `https://chatgpt.com/g/project-1/c/${id}`,
    title: id,
    projectFingerprint: 'project-1',
    accountFingerprint: 'account-1',
    targetId: `${id}-target`,
  };
}

async function bound(): Promise<{ binding: SolSessionBindingStore; persistence: MemoryStore }> {
  const persistence = new MemoryStore();
  const binding = new SolSessionBindingStore({ store: persistence });
  await binding.bind(
    { ...observation('COMPLETED_CANDIDATE'), url: 'https://chatgpt.com/g/project-1/c/old', targetId: 'old-target' },
    'old',
  );
  await binding.recordRawInput('exact original input');
  return { binding, persistence };
}

describe('active and context-limited Sol session recovery', () => {
  it('recovers once, replays the exact input, and makes repeated events idempotent', async () => {
    const { binding, persistence } = await bound();
    const sent: string[] = [];
    const controller: SolConversationController = {
      createConversation: async () => conversation('new'),
      sendMessage: async ({ text }) => {
        sent.push(text);
      },
    };
    const manager = new ContextRecoveryManager({ bindingStore: binding, conversations: controller });
    await expect(
      manager.recover({ eventId: 'event-1', observation: observation('CONTEXT_LIMIT') }),
    ).resolves.toMatchObject({ status: 'RECOVERED', conversationId: 'new' });
    expect(sent).toEqual(['exact original input']);
    await expect(
      manager.recover({ eventId: 'event-1', observation: observation('CONTEXT_LIMIT') }),
    ).resolves.toMatchObject({ status: 'ALREADY_ATTEMPTED' });
    expect(persistence.value?.activeConversationId).toBe('new');
  });

  it('persists the recovery idempotency record before creating or sending the replacement message', async () => {
    const { binding, persistence } = await bound();
    const controller: SolConversationController = {
      createConversation: async () => {
        expect(persistence.value).toMatchObject({
          lastContextRecoveryEventId: 'event-before-side-effect',
          lastContextRecoveryInputHash: hashRawInput('exact original input'),
          lastRawInputHash: hashRawInput('exact original input'),
        });
        return conversation('new-before-side-effect');
      },
      sendMessage: async () => {
        expect(persistence.value?.lastContextRecoveryEventId).toBe('event-before-side-effect');
      },
    };
    const manager = new ContextRecoveryManager({ bindingStore: binding, conversations: controller });
    await expect(
      manager.recover({ eventId: 'event-before-side-effect', observation: observation('CONTEXT_LIMIT') }),
    ).resolves.toMatchObject({ status: 'RECOVERED' });
  });

  it('rejects a recovery retry whose raw input differs from the saved hash', async () => {
    const { binding, persistence } = await bound();
    let createCount = 0;
    const manager = new ContextRecoveryManager({
      bindingStore: binding,
      conversations: {
        createConversation: async () => {
          createCount += 1;
          return conversation('never-created');
        },
        sendMessage: async () => undefined,
      },
    });
    await expect(
      manager.recover({
        eventId: 'event-input-mismatch',
        observation: observation('CONTEXT_LIMIT'),
        rawInput: 'tampered',
      }),
    ).resolves.toMatchObject({ status: 'PAUSED', error: { code: 'RECOVERY_INPUT_MISMATCH' } });
    expect(createCount).toBe(0);
    expect(persistence.value?.lastContextRecoveryEventId).toBe('event-input-mismatch');
  });

  it('pauses after a recovery failure and does not send on Project mismatch', async () => {
    const { binding, persistence } = await bound();
    let sendCount = 0;
    const controller: SolConversationController = {
      createConversation: async () => ({ ...conversation('wrong'), projectFingerprint: 'other' }),
      sendMessage: async () => {
        sendCount += 1;
      },
    };
    const manager = new ContextRecoveryManager({ bindingStore: binding, conversations: controller });
    await expect(
      manager.recover({ eventId: 'event-2', observation: observation('CONTEXT_LIMIT') }),
    ).resolves.toMatchObject({ status: 'PAUSED' });
    expect(sendCount).toBe(0);
    expect(persistence.value).toMatchObject({ paused: true, lastContextRecoveryEventId: 'event-2' });
    await expect(
      manager.recover({ eventId: 'event-3', observation: observation('CONTEXT_LIMIT') }),
    ).resolves.toMatchObject({ status: 'PAUSED' });
    expect(sendCount).toBe(0);
  });

  it('rotates only at the configured threshold, preserves the old chain, and calls the Codex hook', async () => {
    const { binding } = await bound();
    const calls: string[] = [];
    const manager = new ActiveSessionRotationManager({
      bindingStore: binding,
      completedTaskThreshold: 2,
      conversations: { createConversation: async () => conversation('rotated'), sendMessage: async () => undefined },
      codexRotator: {
        rotate: async ({ handoff }) => {
          calls.push(handoff.nextStep);
          return { sessionId: 'codex-2' };
        },
      },
      now: () => new Date('2026-09-10T00:00:00.000Z'),
    });
    const input = {
      phase: 'phase-7',
      completedTaskCount: 2,
      completedTaskIds: ['a', 'b'],
      productGoal: 'goal',
      commit: 'abc',
      governanceRevision: 1,
      architectureRevisionSet: [1],
      unresolvedIssues: [],
      nextStep: 'continue',
    };
    await expect(manager.rotate(input)).resolves.toMatchObject({
      status: 'ROTATED',
      conversationId: 'rotated',
      codexSessionId: 'codex-2',
    });
    expect(calls).toEqual(['continue']);
    await expect(manager.rotate(input)).resolves.toMatchObject({ status: 'SKIPPED' });
    const restored = new SolSessionBindingStore({ store: (binding as unknown as { store: MemoryStore }).store });
    await restored.load();
    expect(restored.getState()?.conversationChain.map((entry) => entry.conversationId)).toEqual(['old', 'rotated']);
  });

  it('persists the rotation key and handoff hash before creating the replacement conversation', async () => {
    const { binding, persistence } = await bound();
    const input = {
      phase: 'phase-before-side-effect',
      completedTaskCount: 2,
      completedTaskIds: ['a', 'b'],
      productGoal: 'goal',
      commit: 'abc',
      governanceRevision: 1,
      architectureRevisionSet: [1],
      unresolvedIssues: [],
      nextStep: 'continue',
    };
    const manager = new ActiveSessionRotationManager({
      bindingStore: binding,
      completedTaskThreshold: 2,
      conversations: {
        createConversation: async () => {
          expect(persistence.value?.lastActiveRotationKey).toBe('phase-before-side-effect:2:threshold');
          expect(persistence.value?.lastActiveRotationInputHash).toBeTruthy();
          return conversation('rotated-before-side-effect');
        },
        sendMessage: async () => undefined,
      },
      now: () => new Date('2026-09-10T00:00:00.000Z'),
    });
    await expect(manager.rotate(input)).resolves.toMatchObject({ status: 'ROTATED' });
  });

  it('does not treat a changed handoff as an idempotent rotation replay', async () => {
    const { binding } = await bound();
    const manager = new ActiveSessionRotationManager({
      bindingStore: binding,
      completedTaskThreshold: 2,
      conversations: { createConversation: async () => conversation('rotated'), sendMessage: async () => undefined },
      now: () => new Date('2026-09-10T00:00:00.000Z'),
    });
    const input = {
      phase: 'phase-replay',
      completedTaskCount: 2,
      completedTaskIds: ['a', 'b'],
      productGoal: 'goal',
      commit: 'abc',
      governanceRevision: 1,
      architectureRevisionSet: [1],
      unresolvedIssues: [],
      nextStep: 'continue',
    };
    await expect(manager.rotate(input)).resolves.toMatchObject({ status: 'ROTATED' });
    await expect(manager.rotate({ ...input, nextStep: 'changed' })).resolves.toMatchObject({
      status: 'PAUSED',
      error: { code: 'RECOVERY_INPUT_MISMATCH' },
    });
  });
});
