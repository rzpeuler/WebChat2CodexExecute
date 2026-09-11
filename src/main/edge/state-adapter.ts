import { createHash } from 'node:crypto';
import type { CdpTransport, EdgeAdapterRules, EdgePageSnapshot, EdgeSolObservation, CdpTarget } from './types.js';
import { normalizeWritingBlockMarkers } from '../../shared/protocol/writing-block.js';
import { hasKnownIdentity, isAllowedChatGptUrl } from './url-security.js';

export const DEFAULT_EDGE_ADAPTER_RULES: EdgeAdapterRules = {
  version: 'chatgpt-dom-2026-09-10',
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
  const OPEN_MARKER = '[WRITING_BLOCK';
  const CLOSE_MARKER = '[/WRITING_BLOCK]';
  const ANGLE_OPEN_MARKER = '<WRITING_BLOCK';
  const ANGLE_CLOSE_MARKER = '</WRITING_BLOCK>';
  const hasOpenMarker = (value) => value.includes(OPEN_MARKER) || value.includes(ANGLE_OPEN_MARKER);
  const hasCloseMarker = (value) => value.includes(CLOSE_MARKER) || value.includes(ANGLE_CLOSE_MARKER);
  const isVisible = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
      style.opacity !== '0' && rect.width > 0 && rect.height > 0;
  };
  const text = (node) => isVisible(node) ? (node.innerText || node.textContent || '').trim() : '';
  const all = (selectors, root = document) => selectors.flatMap((selector) => Array.from(root.querySelectorAll(selector)));
  const visibleAll = (selectors, root = document) => all(selectors, root).filter(isVisible);
  const assistantNodes = visibleAll(${JSON.stringify(rules.assistantSelectors)});
  const assistantNode = assistantNodes.at(-1) || null;
  const assistantCandidates = assistantNode === null
    ? []
    : [assistantNode, ...Array.from(assistantNode.querySelectorAll('*'))]
        .filter(isVisible)
        .map((node) => ({ node, value: text(node) }))
        .filter(({ value }) => hasOpenMarker(value) && hasCloseMarker(value))
        .filter(({ node }) => !Array.from(node.children).some((child) => {
          if (!isVisible(child)) return false;
          const childText = text(child);
          return hasOpenMarker(childText) && hasCloseMarker(childText);
        }));
  const finalAssistant = assistantCandidates.at(-1)?.value || text(assistantNode);
  const errors = all(${JSON.stringify(rules.errorSelectors)}).map(text).filter(Boolean).join('\\n');
  const status = all(['[aria-live="polite"]', '[role="status"]', 'button[aria-label]']).map(text).filter(Boolean).join('\\n');
  const project = document.querySelector('[data-project-id], meta[name="chatgpt-project-id"]');
  const account = document.querySelector('[data-account-id], meta[name="chatgpt-account-id"]');
  const projectValue = project?.getAttribute('data-project-id') || project?.getAttribute('content') || '';
  const accountValue = account?.getAttribute('data-account-id') || account?.getAttribute('content') || '';
  const pathParts = location.pathname.split('/').filter(Boolean);
  const projectFromUrl = pathParts[0] === 'g' && pathParts[1] && pathParts[2] === 'c' ? pathParts[1] : '';
  let accountFromStorage = '';
  try {
    const accountKey = Object.keys(localStorage).find((key) => /(?:^|\\/)user-[a-zA-Z0-9_-]{8,}(?:\\/|$)/.test(key));
    accountFromStorage = accountKey?.match(/(?:^|\\/)user-([a-zA-Z0-9_-]{8,})(?:\\/|$)/)?.[1] || '';
  } catch {}
  const authPath = /\\/(?:auth|login|signin)(?:\\/|$)/i.test(location.pathname);
  const visibleLoginNodes = visibleAll(${JSON.stringify(rules.loginSelectors)});
  const visibleEmailFields = visibleAll(['input[type="email"]']);
  const visiblePasswordFields = visibleAll(['input[type="password"]']);
  const explicitLoginNodes = visibleLoginNodes.filter((node) => {
    return !(node instanceof HTMLInputElement && (node.type || '').toLowerCase() === 'email');
  });
  const loginWall = authPath || explicitLoginNodes.length > 0 ||
    (visibleEmailFields.length > 0 && visiblePasswordFields.length > 0);
  return {
    title: document.title,
    url: location.href,
    projectFingerprint: projectValue || projectFromUrl || null,
    accountFingerprint: accountValue || (accountFromStorage ? 'user-' + accountFromStorage : null),
    latestAssistantText: finalAssistant,
    statusText: status,
    errorText: errors,
    loginWall,
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
  text = normalizeWritingBlockMarkers(text);
  const startCount = (text.match(/\[WRITING_BLOCK\b/g) ?? []).length;
  const endCount = (text.match(/\[\/WRITING_BLOCK\]/g) ?? []).length;
  return startCount > endCount;
}

export function projectFingerprintFromChatGptUrl(value: string): string | null {
  if (!isAllowedChatGptUrl(value)) return null;
  try {
    const parts = new URL(value).pathname.split('/').filter(Boolean);
    return parts[0] === 'g' && parts[1] !== undefined && parts[2] === 'c' ? parts[1] : null;
  } catch {
    return null;
  }
}

export function accountFingerprintFromStorageKeys(keys: readonly string[]): string | null {
  for (const key of keys) {
    const match = key.match(/(?:^|\/)user-([a-zA-Z0-9_-]{8,})(?:\/|$)/);
    if (match?.[1] !== undefined) return `user-${match[1]}`;
  }
  return null;
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
    const text = normalizeWritingBlockMarkers(
      typeof raw.latestAssistantText === 'string' ? raw.latestAssistantText : '',
    );
    const errorText = typeof raw.errorText === 'string' ? raw.errorText : '';
    const statusText = typeof raw.statusText === 'string' ? raw.statusText : '';
    const combined = `${errorText}\n${statusText}`;
    const url = stringOrNull(raw.url) ?? '';
    const projectFingerprint = isAllowedChatGptUrl(url)
      ? (stringOrNull(raw.projectFingerprint) ?? projectFingerprintFromChatGptUrl(url))
      : null;
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
      loginWall: booleanOrFalse(raw.loginWall),
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
