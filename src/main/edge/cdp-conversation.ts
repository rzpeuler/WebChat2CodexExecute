import { EdgeStateAdapter, hashMessage } from './state-adapter.js';
import type { CdpTransport, SolConversationController, SolConversationIdentity } from './types.js';
import { hasKnownIdentity, isAllowedChatGptUrl } from './url-security.js';

export interface CdpConversationControllerOptions {
  transport: CdpTransport;
  adapter: EdgeStateAdapter;
  targetId?: string;
  createConversation?: SolConversationController['createConversation'];
  commandTimeoutMs?: number;
  submissionConfirmationTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class CdpConversationController implements SolConversationController {
  private readonly transport: CdpTransport;
  private readonly adapter: EdgeStateAdapter;
  private readonly configuredTargetId: string | undefined;
  private readonly injectedCreate: SolConversationController['createConversation'] | undefined;
  private readonly commandTimeoutMs: number;
  private readonly submissionConfirmationTimeoutMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: CdpConversationControllerOptions) {
    this.transport = options.transport;
    this.adapter = options.adapter;
    this.configuredTargetId = options.targetId;
    this.injectedCreate = options.createConversation;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 10_000;
    this.submissionConfirmationTimeoutMs = options.submissionConfirmationTimeoutMs ?? 3_000;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  }

  async createConversation(input: {
    projectFingerprint: string;
    accountFingerprint: string | null;
    reason: 'CONTEXT_RECOVERY' | 'ACTIVE_ROTATION';
  }): Promise<SolConversationIdentity> {
    if (!hasKnownIdentity(input.projectFingerprint) || !hasKnownIdentity(input.accountFingerprint)) {
      throw new Error('A known Project and account identity are required to create a conversation.');
    }
    if (this.injectedCreate !== undefined) {
      const conversation = await this.injectedCreate(input);
      assertConversationIdentity(input.projectFingerprint, input.accountFingerprint, conversation);
      return conversation;
    }
    const targets = await this.transport.listTargets();
    const target =
      this.configuredTargetId === undefined
        ? targets.find((candidate) => candidate.type === 'page' && isAllowedChatGptUrl(candidate.url))
        : targets.find(
            (candidate) =>
              candidate.id === this.configuredTargetId &&
              candidate.type === 'page' &&
              isAllowedChatGptUrl(candidate.url),
          );
    if (target === undefined) throw new Error('No allowed ChatGPT target is available for creating a conversation.');
    const before = await this.adapter.sample(target.id);
    if (!hasKnownIdentity(before.projectFingerprint) || before.projectFingerprint !== input.projectFingerprint)
      throw new Error('The active tab is not in the bound Project.');
    if (!hasKnownIdentity(before.accountFingerprint) || input.accountFingerprint !== before.accountFingerprint) {
      throw new Error('The active tab is not in the bound account.');
    }
    await this.transport.evaluate<boolean>(target.id, NEW_CHAT_SCRIPT);
    const deadline = Date.now() + this.commandTimeoutMs;
    while (Date.now() < deadline) {
      for (const candidate of await this.transport.listTargets()) {
        if (candidate.type !== 'page' || !isAllowedChatGptUrl(candidate.url)) continue;
        const observation = await this.adapter.sample(candidate.id);
        if (observation.projectFingerprint !== input.projectFingerprint) continue;
        if (observation.accountFingerprint !== input.accountFingerprint) continue;
        if (candidate.id === before.targetId && observation.url === before.url) continue;
        if (observation.loginWall || observation.projectFingerprint === null) continue;
        return {
          conversationId: conversationIdFromUrl(observation.url) ?? candidate.id,
          url: observation.url,
          title: observation.title,
          projectFingerprint: observation.projectFingerprint,
          accountFingerprint: observation.accountFingerprint,
          targetId: candidate.id,
        };
      }
      await this.sleep(100);
    }
    throw new Error('The new ChatGPT Project conversation did not appear before timeout.');
  }

  async sendMessage(input: { conversation: SolConversationIdentity; text: string }): Promise<void> {
    if (
      !isAllowedChatGptUrl(input.conversation.url) ||
      !hasKnownIdentity(input.conversation.projectFingerprint) ||
      !hasKnownIdentity(input.conversation.accountFingerprint)
    ) {
      throw new Error('A known Project, account, and allowed ChatGPT URL are required to send a message.');
    }
    const targets = await this.transport.listTargets();
    const target = targets.find(
      (candidate) =>
        candidate.id === input.conversation.targetId && candidate.type === 'page' && isAllowedChatGptUrl(candidate.url),
    );
    if (target === undefined) throw conversationIdentityChanged('The bound ChatGPT target is no longer available.');
    const current = await this.adapter.sample(target.id);
    if (
      !isAllowedChatGptUrl(current.url) ||
      current.url !== input.conversation.url ||
      current.projectFingerprint !== input.conversation.projectFingerprint ||
      current.accountFingerprint !== input.conversation.accountFingerprint ||
      conversationIdFromUrl(current.url) !== input.conversation.conversationId
    ) {
      throw conversationIdentityChanged('The active ChatGPT target no longer matches the bound conversation.');
    }
    const beforeAssistantHash = current.latestAssistantHash;
    const prepared = await this.transport.evaluate<{
      prepared?: boolean;
      inputHash?: string;
      inputKind?: 'contenteditable' | 'textarea';
    }>(input.conversation.targetId, prepareMessageScript(input.text));
    if (prepared?.prepared !== true || prepared.inputHash !== hashMessage(input.text)) {
      throw solInputSubmissionError('Sol 输入未提交：未找到可见的 ChatGPT 编辑器。');
    }
    if (prepared.inputKind === 'contenteditable') {
      try {
        await this.transport.sendCommand(input.conversation.targetId, 'Input.insertText', { text: input.text });
      } catch (error) {
        throw solInputSubmissionError(
          `Sol 输入未提交：无法写入可见编辑器${error instanceof Error ? `：${error.message}` : ''}`,
        );
      }
    }

    const deadline = Date.now() + this.submissionConfirmationTimeoutMs;
    let clicked = false;
    while (Date.now() < deadline) {
      if (!clicked) {
        const submission = await this.transport.evaluate<{ clicked?: boolean; composerEmpty?: boolean }>(
          input.conversation.targetId,
          CLICK_SUBMIT_SCRIPT,
        );
        if (submission?.clicked !== true) {
          await this.sleep(100);
          continue;
        }
        clicked = true;
        if (submission.composerEmpty === true) return;
      } else {
        const composer = await this.transport.evaluate<{ empty?: boolean }>(
          input.conversation.targetId,
          COMPOSER_STATE_SCRIPT,
        );
        if (composer?.empty === true) return;
      }
      const after = await this.adapter.sample(input.conversation.targetId);
      const assistantChanged = after.latestAssistantHash !== null && after.latestAssistantHash !== beforeAssistantHash;
      if (after.isThinking || assistantChanged) return;
      await this.sleep(100);
    }
    throw solInputSubmissionError(
      clicked
        ? 'Sol 输入提交未得到确认：请检查专用 Edge 中是否出现了本条用户消息，然后重试。'
        : 'Sol 输入未提交：可见编辑器已填充，但发送按钮未出现或仍不可用。',
    );
  }
}

function solInputSubmissionError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = 'SOL_INPUT_SUBMIT_UNCONFIRMED';
  return error;
}

function conversationIdentityChanged(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = 'SESSION_CONVERSATION_IDENTITY_CHANGED';
  return error;
}

export const NEW_CHAT_SCRIPT = `(() => {
  const selectors = [
    '[data-testid="create-new-chat"]',
    '[data-testid*="new-chat"]',
    'a[href*="/new"]',
    'button[aria-label*="New chat"]',
    'button[aria-label*="新聊天"]'
  ];
  const button = selectors.map((selector) => document.querySelector(selector)).find(Boolean);
  if (!(button instanceof HTMLElement)) throw new Error('ChatGPT new-chat control was not found.');
  button.click();
  return true;
})()`;

export function prepareMessageScript(text: string): string {
  return `(() => {
    const value = ${JSON.stringify(text)};
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const preferred = document.querySelector('#prompt-textarea[contenteditable="true"]');
    const input = preferred instanceof HTMLElement && isVisible(preferred)
      ? preferred
      : [...document.querySelectorAll('[contenteditable="true"], textarea')]
          .find((element) => element instanceof HTMLElement && isVisible(element));
    if (!(input instanceof HTMLElement)) return { prepared: false, inputHash: null };
    input.focus();
    if (input.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return {
        prepared: true,
        inputKind: 'contenteditable',
        inputHash: ${JSON.stringify(hashMessage(text))}
      };
    }
    if (input instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      return {
        prepared: true,
        inputKind: 'textarea',
        inputHash: ${JSON.stringify(hashMessage(text))}
      };
    } else {
      return { prepared: false, inputHash: null };
    }
  })()`;
}

export const CLICK_SUBMIT_SCRIPT = `(() => {
  const isVisible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const input = document.querySelector('#prompt-textarea[contenteditable="true"], textarea');
  if (!(input instanceof HTMLElement) || !isVisible(input)) return { clicked: false };
  const form = input.closest('form');
  if (!(form instanceof HTMLFormElement)) return { clicked: false };
  const submit = [...form.querySelectorAll('button')].find((button) => {
    const label = ((button.getAttribute('aria-label') ?? '') + ' ' + (button.getAttribute('data-testid') ?? '')).toLowerCase();
    return (
      isVisible(button) &&
      !button.disabled &&
      !/voice|听写|语音|mic|microphone/.test(label) &&
      (/send|发送|submit/.test(label) || button.type === 'submit' || /composer-submit/.test(label))
    );
  });
  if (!(submit instanceof HTMLElement)) return { clicked: false };
  submit.click();
  const text = input instanceof HTMLTextAreaElement ? input.value : input.textContent ?? '';
  return { clicked: true, composerEmpty: text.trim() === '' };
})()`;

export const COMPOSER_STATE_SCRIPT = `(() => {
  const isVisible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const input = document.querySelector('#prompt-textarea[contenteditable="true"], textarea');
  if (!(input instanceof HTMLElement) || !isVisible(input)) return { empty: true };
  const text = input instanceof HTMLTextAreaElement ? input.value : input.textContent ?? '';
  return { empty: text.trim() === '' };
})()`;

function conversationIdFromUrl(url: string): string | null {
  if (!isAllowedChatGptUrl(url)) return null;
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const marker = parts.findIndex((part) => part === 'c' || part === 'conversation');
    return marker >= 0 ? (parts[marker + 1] ?? null) : (parts.at(-1) ?? null);
  } catch {
    return null;
  }
}

function assertConversationIdentity(
  projectFingerprint: string,
  accountFingerprint: string,
  conversation: SolConversationIdentity,
): void {
  if (
    !isAllowedChatGptUrl(conversation.url) ||
    conversation.projectFingerprint !== projectFingerprint ||
    !hasKnownIdentity(conversation.accountFingerprint) ||
    conversation.accountFingerprint !== accountFingerprint
  ) {
    throw new Error('The created conversation does not expose the bound Project and account.');
  }
}
