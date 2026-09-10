import { createHash } from 'node:crypto';
import type { CdpTransport, EdgeAdapterRules, EdgePageSnapshot, EdgeSolObservation, CdpTarget } from './types.js';
import { hasKnownIdentity, isAllowedChatGptUrl } from './url-security.js';

export const DEFAULT_EDGE_ADAPTER_RULES: EdgeAdapterRules = {
  version: 'chatgpt-dom-2026-09-09',
  assistantSelectors: [
    '[data-message-author-role="assistant"]',
    'article[data-testid*="conversation-turn"] [data-message-author-role="assistant"]',
  ],
  thinkingSelectors: ['[aria-busy="true"]', '[data-testid*="stop"], button[aria-label*="Stop"]'],
  errorSelectors: ['[role="alert"]', '[data-testid*="error"]'],
  loginSelectors: ['input[type="email"]', 'button[data-testid*="login"]', '[data-testid*="logged-out"]'],
  contextLimitPatterns: [
    /context(?: window)?(?: is)? too long/i,
    /maximum context length/i,
    /上下文.{0,8}(过长|超限)/i,
  ],
  networkErrorPatterns: [/network error/i, /failed to fetch/i, /网络错误/i, /连接失败/i],
  sessionLostPatterns: [/conversation.*not found/i, /chat.*unavailable/i, /会话不存在/i],
};

export function domSnapshotScript(rules: EdgeAdapterRules = DEFAULT_EDGE_ADAPTER_RULES): string {
  return `(() => {
  const text = (node) => node instanceof HTMLElement ? (node.innerText || node.textContent || '').trim() : '';
  const all = (selectors) => selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
  const assistant = all(${JSON.stringify(rules.assistantSelectors)}).map(text).filter(Boolean).at(-1) || '';
  const errors = all(${JSON.stringify(rules.errorSelectors)}).map(text).filter(Boolean).join('\\n');
  const status = all(['[aria-live="polite"]', '[role="status"]', 'button[aria-label]']).map(text).filter(Boolean).join('\\n');
  const project = document.querySelector('[data-project-id], meta[name="chatgpt-project-id"]');
  const account = document.querySelector('[data-account-id], meta[name="chatgpt-account-id"]');
  const projectValue = project?.getAttribute('data-project-id') || project?.getAttribute('content') || '';
  const accountValue = account?.getAttribute('data-account-id') || account?.getAttribute('content') || '';
  return {
    title: document.title,
    url: location.href,
    projectFingerprint: projectValue || null,
    accountFingerprint: accountValue || null,
    latestAssistantText: assistant,
    statusText: status,
    errorText: errors,
    loginWall: all(${JSON.stringify(rules.loginSelectors)}).length > 0,
    sessionMissing: false,
    contextLimit: false,
    networkError: false,
    isThinking: all(${JSON.stringify(rules.thinkingSelectors)}).length > 0,
  };
})()`;
}

export const EDGE_DOM_SNAPSHOT_SCRIPT = domSnapshotScript();

export interface EdgeStateAdapterOptions {
  rules?: EdgeAdapterRules;
  stableSampleCount?: number;
  now?: () => Date;
}

interface StableSample {
  hash: string | null;
  count: number;
}

export function hashMessage(text: string): string | null {
  const normalized = text.trim();
  return normalized === '' ? null : createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function hasIncompleteWritingBlock(text: string): boolean {
  const startCount = (text.match(/\[WRITING_BLOCK\b/g) ?? []).length;
  const endCount = (text.match(/\[\/WRITING_BLOCK\]/g) ?? []).length;
  return startCount > endCount;
}

export class EdgeStateAdapter {
  readonly rules: EdgeAdapterRules;
  private readonly transport: CdpTransport;
  private readonly stableSampleCount: number;
  private readonly now: () => Date;
  private readonly stableSamples = new Map<string, StableSample>();

  constructor(transport: CdpTransport, options: EdgeStateAdapterOptions = {}) {
    this.transport = transport;
    this.rules = options.rules ?? DEFAULT_EDGE_ADAPTER_RULES;
    this.stableSampleCount = Math.max(2, options.stableSampleCount ?? 2);
    this.now = options.now ?? (() => new Date());
  }

  async readPage(targetId: string): Promise<EdgePageSnapshot> {
    const raw = await this.transport.evaluate<Record<string, unknown>>(targetId, domSnapshotScript(this.rules));
    const text = typeof raw.latestAssistantText === 'string' ? raw.latestAssistantText : '';
    const errorText = typeof raw.errorText === 'string' ? raw.errorText : '';
    const statusText = typeof raw.statusText === 'string' ? raw.statusText : '';
    const combined = `${errorText}\n${statusText}`;
    const url = stringOrNull(raw.url) ?? '';
    const projectFingerprint = isAllowedChatGptUrl(url) ? stringOrNull(raw.projectFingerprint) : null;
    const accountFingerprint = isAllowedChatGptUrl(url) ? stringOrNull(raw.accountFingerprint) : null;
    return {
      targetId,
      title: stringOrNull(raw.title) ?? '',
      url,
      projectFingerprint,
      accountFingerprint,
      latestAssistantText: text,
      latestAssistantHash: hashMessage(text),
      statusText,
      errorText,
      loginWall:
        booleanOrFalse(raw.loginWall) ||
        matchesAny(
          combined,
          this.rules.loginSelectors.map((value) => new RegExp(value, 'i')),
        ),
      sessionMissing: booleanOrFalse(raw.sessionMissing) || matchesAny(combined, this.rules.sessionLostPatterns),
      contextLimit: booleanOrFalse(raw.contextLimit) || matchesAny(combined, this.rules.contextLimitPatterns),
      networkError: booleanOrFalse(raw.networkError) || matchesAny(combined, this.rules.networkErrorPatterns),
      isThinking: booleanOrFalse(raw.isThinking) || matchesAny(statusText, [/thinking/i, /generating/i, /正在思考/i]),
      writingBlockIncomplete: hasIncompleteWritingBlock(text),
      sampledAt: this.now().toISOString(),
    };
  }

  async sample(targetId: string): Promise<EdgeSolObservation> {
    const page = await this.readPage(targetId);
    const previous = this.stableSamples.get(targetId);
    const count = previous?.hash === page.latestAssistantHash ? previous.count + 1 : 1;
    this.stableSamples.set(targetId, { hash: page.latestAssistantHash, count });
    const status = this.classify(page, count);
    return { ...page, status, adapterVersion: this.rules.version, consecutiveStableSamples: count };
  }

  reset(targetId?: string): void {
    if (targetId === undefined) this.stableSamples.clear();
    else this.stableSamples.delete(targetId);
  }

  private classify(page: EdgePageSnapshot, stableCount: number): EdgeSolObservation['status'] {
    if (page.loginWall) return 'AUTH_REQUIRED';
    if (page.contextLimit) return 'CONTEXT_LIMIT';
    if (page.networkError) return 'NETWORK_ERROR';
    if (page.sessionMissing) return 'SESSION_LOST';
    if (page.projectFingerprint === null || page.url === '') return 'AMBIGUOUS';
    if (page.isThinking) return 'THINKING';
    if (stableCount >= this.stableSampleCount && page.latestAssistantHash !== null) {
      return page.writingBlockIncomplete ? 'AMBIGUOUS' : 'COMPLETED_CANDIDATE';
    }
    return page.latestAssistantHash === null ? 'AMBIGUOUS' : 'THINKING';
  }
}

export async function selectChatGptProjectTargets(
  transport: CdpTransport,
  adapter: EdgeStateAdapter,
): Promise<Array<{ target: CdpTarget; observation: EdgeSolObservation }>> {
  const targets = await transport.listTargets();
  const selected: Array<{ target: CdpTarget; observation: EdgeSolObservation }> = [];
  for (const target of targets) {
    if (target.type !== 'page' || !isAllowedChatGptUrl(target.url)) continue;
    const observation = await adapter.sample(target.id);
    if (hasKnownIdentity(observation.projectFingerprint) && hasKnownIdentity(observation.accountFingerprint)) {
      selected.push({ target, observation });
    }
  }
  return selected;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function booleanOrFalse(value: unknown): boolean {
  return value === true;
}

function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}
