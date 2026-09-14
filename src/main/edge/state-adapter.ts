import { createHash } from 'node:crypto';
import type {
  CdpTransport,
  EdgeAdapterRules,
  EdgePageSnapshot,
  EdgeProtocolCaptureDiagnostics,
  EdgeSolObservation,
  CdpTarget,
} from './types.js';
import {
  extractUserMessage,
  normalizeWritingBlockMarkers,
  parseWritingBlocks,
  selectLatestValidWritingBlockSequence,
} from '../../shared/protocol/writing-block.js';
import { hasKnownIdentity, isAllowedChatGptUrl } from './url-security.js';

export const DEFAULT_EDGE_ADAPTER_RULES: EdgeAdapterRules = {
  version: 'chatgpt-dom-2026-09-14-candidate-stability',
  assistantSelectors: [
    '[data-message-author-role="assistant"]',
    'article[data-testid*="conversation-turn"] [data-message-author-role="assistant"]',
  ],
  finalAnswerSelectors: ['[data-message-content]', '[data-testid*="markdown"]', '.markdown', '.prose'],
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

export function extractWritingBlockTail(value: string): string | null {
  return selectLatestValidWritingBlockSequence(normalizeWritingBlockMarkers(value));
}

export function domSnapshotScript(rules: EdgeAdapterRules = DEFAULT_EDGE_ADAPTER_RULES): string {
  return `(() => {
  const isCaptureUsable = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    if (!node.isConnected) return false;
    const style = window.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
      node.getAttribute('aria-hidden') !== 'true';
  };
  const text = (node) => isCaptureUsable(node) ? (node.innerText || node.textContent || '').trim() : '';
  const all = (selectors, root = document) => selectors.flatMap((selector) => Array.from(root.querySelectorAll(selector)));
  const captureUsableAll = (selectors, root = document) => all(selectors, root).filter(isCaptureUsable);
  const assistantNodes = [...new Set(captureUsableAll(${JSON.stringify(rules.assistantSelectors)}))];
  const assistantNode = assistantNodes.at(-1) || null;
  const assistantRootText = text(assistantNode);
  const normalizeMarkers = (value) => value
    .replaceAll('<WRITING_BLOCK', '[WRITING_BLOCK')
    .replaceAll('</WRITING_BLOCK>', '[/WRITING_BLOCK]');
  const isFinalPayload = (value) => {
    const normalized = normalizeMarkers(value);
    const firstOpen = normalized.indexOf('[WRITING_BLOCK');
    const lastClose = normalized.lastIndexOf('[/WRITING_BLOCK]');
    const openCount = (normalized.match(/\\[WRITING_BLOCK\\b/g) || []).length;
    const closeCount = (normalized.match(/\\[\\/WRITING_BLOCK\\]/g) || []).length;
    const writingBlockPayload = firstOpen === 0 && lastClose >= firstOpen &&
      normalized.slice(lastClose + '[/WRITING_BLOCK]'.length).trim() === '' &&
      openCount > 0 && openCount === closeCount;
    const userPayload = normalized.startsWith('[USER_MESSAGE]') && normalized.endsWith('[/USER_MESSAGE]');
    return writingBlockPayload || userPayload;
  };
  const finalAnswerCandidates = assistantNode === null
    ? []
    : assistantNodes.flatMap((root, nodeIndex) => [
        root,
        ...captureUsableAll(${JSON.stringify(rules.finalAnswerSelectors)}, root),
        ...Array.from(root.querySelectorAll('*')).filter(isCaptureUsable),
      ].map((node, index) => {
        let depth = 0;
        for (let parent = node.parentElement; parent !== null && parent !== root; parent = parent.parentElement)
          depth += 1;
        return { node, index, nodeIndex, depth, value: text(node) };
      }))
      .filter(({ value }) => isFinalPayload(value));
  const finalAnswer = finalAnswerCandidates
    .sort((left, right) => left.nodeIndex - right.nodeIndex || left.depth - right.depth || left.index - right.index)
    .at(-1);
  const latestProtocolNode = [...assistantNodes]
    .map((node, nodeIndex) => ({ nodeIndex, value: text(node) }))
    .reverse()
    .find(({ value }) => /\\[WRITING_BLOCK\\b|\\[USER_MESSAGE\\]/.test(normalizeMarkers(value)));
  const finalAssistant = finalAnswer?.value || latestProtocolNode?.value || assistantRootText;
  const normalizedAssistant = normalizeMarkers(finalAssistant);
  const writingBlockOpenCount = (normalizedAssistant.match(/\\[WRITING_BLOCK\\b/g) || []).length;
  const writingBlockCloseCount = (normalizedAssistant.match(/\\[\\/WRITING_BLOCK\\]/g) || []).length;
  const userMessageMarkerCount = (normalizedAssistant.match(/\\[USER_MESSAGE\\]/g) || []).length;
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
  const visibleLoginNodes = captureUsableAll(${JSON.stringify(rules.loginSelectors)});
  const visibleEmailFields = captureUsableAll(['input[type="email"]']);
  const visiblePasswordFields = captureUsableAll(['input[type="password"]']);
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
    finalAnswerBoundaryFound: finalAnswer !== undefined,
    captureDiagnostics: {
      assistantNodeCount: assistantNodes.length,
      completeCandidateCount: finalAnswerCandidates.length,
      selectedAssistantNodeIndex: finalAnswer?.nodeIndex ?? latestProtocolNode?.nodeIndex ?? (assistantNode === null ? null : assistantNodes.length - 1),
      writingBlockOpenCount,
      writingBlockCloseCount,
      userMessageMarkerCount,
    },
    statusText: status,
    errorText: errors,
    loginWall,
    sessionMissing: false,
    contextLimit: false,
    networkError: false,
    isThinking: captureUsableAll(${JSON.stringify(rules.thinkingSelectors)}).length > 0,
  };
})()`;
}

export const EDGE_DOM_SNAPSHOT_SCRIPT = domSnapshotScript();

export interface EdgeStateAdapterOptions {
  rules?: EdgeAdapterRules;
  stableSampleCount?: number;
  unconsumableSampleCount?: number;
  now?: () => Date;
}

interface StableSample {
  hash: string | null;
  count: number;
  unconsumableCount: number;
}

export function hashMessage(text: string): string | null {
  const normalized = text.trim();
  return normalized === '' ? null : createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function markerCount(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

function protocolDiagnosticsForText(text: string): EdgeProtocolCaptureDiagnostics {
  const normalized = normalizeWritingBlockMarkers(text);
  return {
    assistantNodeCount: 0,
    completeCandidateCount: 0,
    selectedAssistantNodeIndex: null,
    writingBlockOpenCount: markerCount(normalized, '[WRITING_BLOCK'),
    writingBlockCloseCount: markerCount(normalized, '[/WRITING_BLOCK]'),
    userMessageMarkerCount: markerCount(normalized, '[USER_MESSAGE]'),
  };
}

function protocolReady(text: string): boolean {
  if (extractUserMessage(text) !== null) return true;
  try {
    return parseWritingBlocks(text).blocks.length > 0;
  } catch {
    return false;
  }
}

function captureDiagnostics(value: unknown): EdgeProtocolCaptureDiagnostics | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const numbers = [
    candidate.assistantNodeCount,
    candidate.completeCandidateCount,
    candidate.writingBlockOpenCount,
    candidate.writingBlockCloseCount,
    candidate.userMessageMarkerCount,
  ];
  if (numbers.some((item) => typeof item !== 'number' || !Number.isInteger(item) || item < 0)) return undefined;
  const selected = candidate.selectedAssistantNodeIndex;
  if (
    selected !== null &&
    selected !== undefined &&
    (typeof selected !== 'number' || !Number.isInteger(selected) || selected < 0)
  )
    return undefined;
  return {
    assistantNodeCount: candidate.assistantNodeCount as number,
    completeCandidateCount: candidate.completeCandidateCount as number,
    selectedAssistantNodeIndex: (selected ?? null) as number | null,
    writingBlockOpenCount: candidate.writingBlockOpenCount as number,
    writingBlockCloseCount: candidate.writingBlockCloseCount as number,
    userMessageMarkerCount: candidate.userMessageMarkerCount as number,
  };
}

export function hasIncompleteWritingBlock(text: string): boolean {
  text = normalizeWritingBlockMarkers(text);
  const startCount = (text.match(/\[WRITING_BLOCK\b/g) ?? []).length;
  const endCount = (text.match(/\[\/WRITING_BLOCK\]/g) ?? []).length;
  return startCount > endCount;
}

export function hasMixedWritingBlockContent(text: string): boolean {
  const normalized = normalizeWritingBlockMarkers(text);
  const hasOpen = normalized.includes('[WRITING_BLOCK');
  const hasClose = normalized.includes('[/WRITING_BLOCK]');
  if (!hasOpen || !hasClose) return false;
  const firstOpen = normalized.indexOf('[WRITING_BLOCK');
  const lastClose = normalized.lastIndexOf('[/WRITING_BLOCK]');
  const openCount = (normalized.match(/\[WRITING_BLOCK\b/g) ?? []).length;
  const closeCount = (normalized.match(/\[\/WRITING_BLOCK\]/g) ?? []).length;
  return (
    openCount === 0 ||
    openCount !== closeCount ||
    normalized.slice(0, firstOpen).trim() !== '' ||
    normalized.slice(lastClose + '[/WRITING_BLOCK]'.length).trim() !== ''
  );
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
  private readonly unconsumableSampleCount: number;
  private readonly now: () => Date;
  private readonly stableSamples = new Map<string, StableSample>();

  constructor(transport: CdpTransport, options: EdgeStateAdapterOptions = {}) {
    this.transport = transport;
    this.rules = options.rules ?? DEFAULT_EDGE_ADAPTER_RULES;
    this.stableSampleCount = Math.max(2, options.stableSampleCount ?? 2);
    this.unconsumableSampleCount = Math.max(2, options.unconsumableSampleCount ?? 3);
    this.now = options.now ?? (() => new Date());
  }

  async readPage(targetId: string): Promise<EdgePageSnapshot> {
    const raw = await this.transport.evaluate<Record<string, unknown>>(targetId, domSnapshotScript(this.rules));
    const rawText = normalizeWritingBlockMarkers(
      typeof raw.latestAssistantText === 'string' ? raw.latestAssistantText : '',
    );
    const text = raw.finalAnswerBoundaryFound === false ? rawText : (extractWritingBlockTail(rawText) ?? rawText);
    const diagnostics = captureDiagnostics(raw.captureDiagnostics) ?? protocolDiagnosticsForText(text);
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
      ...(typeof raw.finalAnswerBoundaryFound === 'boolean'
        ? { finalAnswerBoundaryFound: raw.finalAnswerBoundaryFound }
        : {}),
      protocolReady: protocolReady(text),
      protocolDiagnostics: diagnostics,
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
    const unconsumableCount = page.protocolReady
      ? 0
      : previous?.hash === page.latestAssistantHash
        ? previous.unconsumableCount + 1
        : 1;
    this.stableSamples.set(targetId, {
      hash: page.latestAssistantHash,
      count,
      unconsumableCount,
    });
    const status = this.classify(page, count, unconsumableCount);
    return { ...page, status, adapterVersion: this.rules.version, consecutiveStableSamples: count };
  }

  reset(targetId?: string): void {
    if (targetId === undefined) this.stableSamples.clear();
    else this.stableSamples.delete(targetId);
  }

  private classify(
    page: EdgePageSnapshot,
    stableCount: number,
    unconsumableCount: number,
  ): EdgeSolObservation['status'] {
    if (page.loginWall) return 'AUTH_REQUIRED';
    if (page.contextLimit) return 'CONTEXT_LIMIT';
    if (page.networkError) return 'NETWORK_ERROR';
    if (page.sessionMissing) return 'SESSION_LOST';
    if (page.projectFingerprint === null || page.url === '') return 'AMBIGUOUS';
    if (page.isThinking) return 'THINKING';
    if (stableCount >= this.stableSampleCount && page.latestAssistantHash !== null) {
      if (page.writingBlockIncomplete) return 'AMBIGUOUS';
      if (page.protocolReady === true) return 'COMPLETED_CANDIDATE';
      if (unconsumableCount >= this.unconsumableSampleCount) return 'UNCONSUMABLE_CANDIDATE';
      return 'AMBIGUOUS';
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
