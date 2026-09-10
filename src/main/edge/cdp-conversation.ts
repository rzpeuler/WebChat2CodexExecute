import { EdgeStateAdapter, hashMessage } from './state-adapter.js';
import type { CdpTransport, SolConversationController, SolConversationIdentity } from './types.js';
import { hasKnownIdentity, isAllowedChatGptUrl } from './url-security.js';

export interface CdpConversationControllerOptions {
  transport: CdpTransport;
  adapter: EdgeStateAdapter;
  targetId?: string;
  createConversation?: SolConversationController['createConversation'];
  commandTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class CdpConversationController implements SolConversationController {
  private readonly transport: CdpTransport;
  private readonly adapter: EdgeStateAdapter;
  private readonly configuredTargetId: string | undefined;
  private readonly injectedCreate: SolConversationController['createConversation'] | undefined;
  private readonly commandTimeoutMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: CdpConversationControllerOptions) {
    this.transport = options.transport;
    this.adapter = options.adapter;
    this.configuredTargetId = options.targetId;
    this.injectedCreate = options.createConversation;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 10_000;
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
    const result = await this.transport.evaluate<{ sent?: boolean; inputHash?: string }>(
      input.conversation.targetId,
      sendMessageScript(input.text),
    );
    if (result?.sent !== true || result.inputHash !== hashMessage(input.text)) {
      throw new Error('The original Sol input could not be submitted exactly.');
    }
  }
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

function sendMessageScript(text: string): string {
  return `(() => {
    const value = ${JSON.stringify(text)};
    const input = document.querySelector('textarea, [contenteditable="true"]');
    if (!(input instanceof HTMLElement)) return { sent: false, inputHash: null };
    if (input instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(input, value);
    } else {
      input.textContent = value;
    }
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    const form = input.closest('form');
    const submit = form?.querySelector('button[type="submit"], button[aria-label*="Send"], button[aria-label*="发送"]');
    if (submit instanceof HTMLElement) submit.click();
    else if (form instanceof HTMLFormElement) form.requestSubmit();
    else return { sent: false, inputHash: null };
    return { sent: true, inputHash: ${JSON.stringify(hashMessage(text))} };
  })()`;
}

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
