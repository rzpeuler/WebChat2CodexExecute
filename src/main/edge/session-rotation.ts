import { hashRawInput, SolBindingError, SolSessionBindingStore } from './session-binding.js';
import type {
  CodexSessionRotator,
  EdgeSolObservation,
  SolConversationController,
  SolConversationIdentity,
  SolSessionHandoff,
} from './types.js';
import { hasKnownIdentity, isAllowedChatGptUrl } from './url-security.js';

export type SessionRecoveryStatus = 'RECOVERED' | 'ALREADY_ATTEMPTED' | 'PAUSED';

export interface SessionRecoveryResult {
  status: SessionRecoveryStatus;
  eventId: string;
  conversationId?: string;
  inputHash?: string;
  error?: { code: string; message: string };
}

export class SolSessionRecoveryError extends Error {
  readonly code:
    | 'RECOVERY_INPUT_MISSING'
    | 'RECOVERY_INPUT_MISMATCH'
    | 'RECOVERY_FAILED'
    | 'RECOVERY_IDENTITY_MISMATCH'
    | 'RECOVERY_PAUSED';

  constructor(code: SolSessionRecoveryError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SolSessionRecoveryError';
    this.code = code;
  }
}

export interface ContextRecoveryOptions {
  bindingStore: SolSessionBindingStore;
  conversations: SolConversationController;
}

export class ContextRecoveryManager {
  private readonly bindingStore: SolSessionBindingStore;
  private readonly conversations: SolConversationController;

  constructor(options: ContextRecoveryOptions) {
    this.bindingStore = options.bindingStore;
    this.conversations = options.conversations;
  }

  async recover(input: {
    eventId: string;
    observation: EdgeSolObservation;
    rawInput?: string;
  }): Promise<SessionRecoveryResult> {
    const state = await this.bindingStore.load();
    if (state === null) throw new SolSessionRecoveryError('RECOVERY_FAILED', 'No Sol conversation is bound.');
    if (state.lastContextRecoveryEventId === input.eventId) {
      if (input.rawInput !== undefined) {
        const savedHash = state.lastContextRecoveryInputHash ?? state.lastRawInputHash;
        if (savedHash === null || hashRawInput(input.rawInput) !== savedHash) {
          return {
            status: 'PAUSED',
            eventId: input.eventId,
            error: {
              code: 'RECOVERY_INPUT_MISMATCH',
              message: 'The retry input does not match the persisted Sol input hash.',
            },
          };
        }
      }
      return { status: 'ALREADY_ATTEMPTED', eventId: input.eventId };
    }
    if (state.paused) {
      return {
        status: 'PAUSED',
        eventId: input.eventId,
        error: { code: 'RECOVERY_PAUSED', message: state.pauseReason ?? 'Sol session recovery is paused.' },
      };
    }
    if (input.observation.status !== 'CONTEXT_LIMIT') {
      throw new SolSessionRecoveryError(
        'RECOVERY_FAILED',
        'Context recovery requires an explicit CONTEXT_LIMIT observation.',
      );
    }
    const rawInput = input.rawInput ?? state.lastRawInput;
    const attempts = state.contextRecoveryAttempts + 1;
    try {
      if (rawInput === null || rawInput === undefined) {
        throw new SolSessionRecoveryError(
          'RECOVERY_INPUT_MISSING',
          'The original Sol input is unavailable for exact replay.',
        );
      }
      if (input.observation.projectFingerprint !== state.projectFingerprint) {
        throw new SolSessionRecoveryError(
          'RECOVERY_IDENTITY_MISMATCH',
          'The CONTEXT_LIMIT observation is from another Project.',
        );
      }
      if (
        !isAllowedChatGptUrl(input.observation.url) ||
        !hasKnownIdentity(input.observation.projectFingerprint) ||
        !hasKnownIdentity(input.observation.accountFingerprint) ||
        !hasKnownIdentity(state.accountFingerprint) ||
        input.observation.accountFingerprint !== state.accountFingerprint
      ) {
        throw new SolSessionRecoveryError(
          'RECOVERY_IDENTITY_MISMATCH',
          'The CONTEXT_LIMIT observation does not expose the bound Project and account.',
        );
      }
      if (state.lastRawInputHash !== null && hashRawInput(rawInput) !== state.lastRawInputHash) {
        throw new SolSessionRecoveryError(
          'RECOVERY_INPUT_MISMATCH',
          'The Sol input does not match the persisted input hash.',
        );
      }
      await this.bindingStore.prepareContextRecoveryAttempt(input.eventId, attempts, rawInput);
      const conversation = await this.conversations.createConversation({
        projectFingerprint: state.projectFingerprint,
        accountFingerprint: state.accountFingerprint,
        reason: 'CONTEXT_RECOVERY',
      });
      this.assertIdentity(state.projectFingerprint, state.accountFingerprint, conversation);
      await this.conversations.sendMessage({ conversation, text: rawInput });
      await this.bindingStore.setActiveConversation(conversation, 'CONTEXT_RECOVERY');
      await this.bindingStore.markContextRecoveryAttempt(input.eventId, attempts, false, null);
      return {
        status: 'RECOVERED',
        eventId: input.eventId,
        conversationId: conversation.conversationId,
        inputHash: hashRawInput(rawInput),
      };
    } catch (error) {
      const normalized = normalizeError(error);
      await this.bindingStore.markContextRecoveryAttempt(input.eventId, attempts, true, normalized.message);
      return { status: 'PAUSED', eventId: input.eventId, error: normalized };
    }
  }

  private assertIdentity(
    projectFingerprint: string,
    accountFingerprint: string | null,
    conversation: SolConversationIdentity,
  ): void {
    if (
      !isAllowedChatGptUrl(conversation.url) ||
      !hasKnownIdentity(projectFingerprint) ||
      !hasKnownIdentity(accountFingerprint) ||
      !hasKnownIdentity(conversation.projectFingerprint) ||
      conversation.projectFingerprint !== projectFingerprint
    ) {
      throw new SolSessionRecoveryError(
        'RECOVERY_IDENTITY_MISMATCH',
        'The new conversation does not expose the bound Project and account.',
      );
    }
    if (!hasKnownIdentity(conversation.accountFingerprint) || accountFingerprint !== conversation.accountFingerprint) {
      throw new SolSessionRecoveryError(
        'RECOVERY_IDENTITY_MISMATCH',
        'The new conversation is not in the bound account.',
      );
    }
  }
}

export type ActiveRotationStatus = 'ROTATED' | 'SKIPPED' | 'PAUSED';

export interface ActiveRotationResult {
  status: ActiveRotationStatus;
  rotationKey: string;
  conversationId?: string;
  codexSessionId?: string;
  handoff?: SolSessionHandoff;
  error?: { code: string; message: string };
}

export function serializeSessionHandoff(handoff: SolSessionHandoff): string {
  return `SESSION_HANDOFF\n${JSON.stringify(handoff, null, 2)}`;
}

export interface ActiveRotationOptions extends ContextRecoveryOptions {
  completedTaskThreshold?: number;
  codexRotator?: CodexSessionRotator;
  now?: () => Date;
}

export interface ActiveRotationInput {
  phase: string;
  phaseCompleted?: boolean;
  completedTaskCount: number;
  completedTaskIds: string[];
  productGoal: string;
  commit: string | null;
  governanceRevision: string | number | null;
  architectureRevisionSet: Array<string | number>;
  unresolvedIssues: string[];
  nextStep: string;
}

export class ActiveSessionRotationManager {
  private readonly bindingStore: SolSessionBindingStore;
  private readonly conversations: SolConversationController;
  private readonly codexRotator: CodexSessionRotator | undefined;
  private readonly threshold: number | null;
  private readonly now: () => Date;

  constructor(options: ActiveRotationOptions) {
    this.bindingStore = options.bindingStore;
    this.conversations = options.conversations;
    this.codexRotator = options.codexRotator;
    this.threshold = options.completedTaskThreshold === undefined ? null : Math.max(1, options.completedTaskThreshold);
    this.now = options.now ?? (() => new Date());
  }

  shouldRotate(input: Pick<ActiveRotationInput, 'phaseCompleted' | 'completedTaskCount'>): boolean {
    return input.phaseCompleted === true || (this.threshold !== null && input.completedTaskCount >= this.threshold);
  }

  async rotate(input: ActiveRotationInput): Promise<ActiveRotationResult> {
    const state = await this.bindingStore.load();
    if (state === null) throw new SolSessionRecoveryError('RECOVERY_FAILED', 'No Sol conversation is bound.');
    const rotationKey = `${input.phase}:${input.completedTaskCount}:${input.phaseCompleted === true ? 'complete' : 'threshold'}`;
    if (!this.shouldRotate(input)) return { status: 'SKIPPED', rotationKey };

    const handoff: SolSessionHandoff = {
      version: 1,
      projectFingerprint: state.projectFingerprint,
      accountFingerprint: state.accountFingerprint,
      phase: input.phase,
      productGoal: input.productGoal,
      completedTaskCount: input.completedTaskCount,
      completedTaskIds: [...input.completedTaskIds],
      commit: input.commit,
      governanceRevision: input.governanceRevision,
      architectureRevisionSet: [...input.architectureRevisionSet],
      unresolvedIssues: [...input.unresolvedIssues],
      nextStep: input.nextStep,
      createdAt: this.now().toISOString(),
    };
    const handoffInputHash = hashRawInput(
      JSON.stringify({
        version: handoff.version,
        projectFingerprint: handoff.projectFingerprint,
        accountFingerprint: handoff.accountFingerprint,
        phase: handoff.phase,
        productGoal: handoff.productGoal,
        completedTaskCount: handoff.completedTaskCount,
        completedTaskIds: handoff.completedTaskIds,
        commit: handoff.commit,
        governanceRevision: handoff.governanceRevision,
        architectureRevisionSet: handoff.architectureRevisionSet,
        unresolvedIssues: handoff.unresolvedIssues,
        nextStep: handoff.nextStep,
      }),
    );
    if (state.lastActiveRotationKey === rotationKey) {
      if (
        state.lastActiveRotationInputHash !== null &&
        state.lastActiveRotationInputHash !== undefined &&
        state.lastActiveRotationInputHash !== handoffInputHash
      ) {
        return {
          status: 'PAUSED',
          rotationKey,
          handoff,
          error: {
            code: 'RECOVERY_INPUT_MISMATCH',
            message: 'The rotation retry does not match the persisted handoff hash.',
          },
        };
      }
      return { status: 'SKIPPED', rotationKey };
    }
    try {
      if (!hasKnownIdentity(state.projectFingerprint) || !hasKnownIdentity(state.accountFingerprint)) {
        throw new SolSessionRecoveryError(
          'RECOVERY_IDENTITY_MISMATCH',
          'A known bound Project and account are required for rotation.',
        );
      }
      await this.bindingStore.markActiveRotation(rotationKey, handoffInputHash);
      const conversation = await this.conversations.createConversation({
        projectFingerprint: state.projectFingerprint,
        accountFingerprint: state.accountFingerprint,
        reason: 'ACTIVE_ROTATION',
      });
      assertConversationIdentity(state.projectFingerprint, state.accountFingerprint, conversation);
      await this.conversations.sendMessage({ conversation, text: serializeSessionHandoff(handoff) });
      const codex =
        this.codexRotator === undefined
          ? null
          : await this.codexRotator.rotate({ projectFingerprint: state.projectFingerprint, handoff });
      await this.bindingStore.setActiveConversation(conversation, 'ACTIVE_ROTATION');
      return {
        status: 'ROTATED',
        rotationKey,
        conversationId: conversation.conversationId,
        ...(codex === null ? {} : { codexSessionId: codex.sessionId }),
        handoff,
      };
    } catch (error) {
      return { status: 'PAUSED', rotationKey, handoff, error: normalizeError(error) };
    }
  }
}

function assertConversationIdentity(
  projectFingerprint: string,
  accountFingerprint: string | null,
  conversation: SolConversationIdentity,
): void {
  if (
    !isAllowedChatGptUrl(conversation.url) ||
    !hasKnownIdentity(projectFingerprint) ||
    !hasKnownIdentity(accountFingerprint) ||
    !hasKnownIdentity(conversation.projectFingerprint) ||
    conversation.projectFingerprint !== projectFingerprint ||
    !hasKnownIdentity(conversation.accountFingerprint) ||
    conversation.accountFingerprint !== accountFingerprint
  ) {
    throw new SolSessionRecoveryError(
      'RECOVERY_IDENTITY_MISMATCH',
      'The rotated conversation does not expose the bound Project and account.',
    );
  }
}

function normalizeError(error: unknown): { code: string; message: string } {
  if (error instanceof SolBindingError || error instanceof SolSessionRecoveryError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'RECOVERY_FAILED', message: error instanceof Error ? error.message : String(error) };
}
