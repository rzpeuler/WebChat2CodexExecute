import { hashText, identityFromUrl, fingerprint } from './security.mjs';

export const DOM_SNAPSHOT_SCRIPT = `(() => {
  const textOf = (node) => String(node?.innerText || node?.textContent || '').replace(/\\r\\n/g, '\\n').trim();
  const usable = (node) => {
    if (!node || !node.isConnected) return false;
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getAttribute('aria-hidden') !== 'true';
  };
  const lastText = (selectors) => {
    const nodes = [...document.querySelectorAll(selectors)].filter(usable);
    return nodes.length ? textOf(nodes[nodes.length - 1]) : '';
  };
  const body = textOf(document.body);
  const url = location.href;
  const storageKeys = [];
  try { for (let index = 0; index < localStorage.length; index += 1) storageKeys.push(localStorage.key(index)); } catch {}
  const projectNode = document.querySelector('[data-project-id], [data-project-slug], meta[name="chatgpt-project-id"]');
  const projectValue = projectNode?.getAttribute('data-project-id') || projectNode?.getAttribute('data-project-slug') || projectNode?.getAttribute('content') || '';
  const accountKeys = storageKeys.filter((key) => /account|user|session|auth/i.test(String(key))).sort();
  const login = /log in|sign in|登录|注册|create account/i.test(body) && !document.querySelector('[data-message-author-role="assistant"]');
  const thinking = Boolean(document.querySelector('[data-testid*="stop"], button[aria-label*="Stop"], button[aria-label*="停止"]')) || /thinking|generating|正在思考|生成中/i.test(body.slice(-500));
  const errors = /network error|something went wrong|context limit|上下文|网络错误/i.test(body);
  return {
    url,
    latestAssistantText: lastText('[data-message-author-role="assistant"], [data-testid^="conversation-turn"] article'),
    latestUserText: lastText('[data-message-author-role="user"]'),
    projectValue,
    accountKeys,
    loginRequired: login,
    isThinking: thinking,
    networkError: errors,
    bodyTail: body.slice(-1000),
  };
})()`;

export function normalizeCapture(raw, pageUrl) {
  const identity = identityFromUrl(raw?.url || pageUrl);
  const project = raw?.project_fingerprint || raw?.projectFingerprint ||
    (raw?.projectValue ? fingerprint(raw.projectValue) : identity.project_fingerprint);
  const account = raw?.account_fingerprint || raw?.accountFingerprint ||
    (Array.isArray(raw?.accountKeys) && raw.accountKeys.length ? fingerprint(raw.accountKeys.join('\n')) : null);
  const assistantText = String(raw?.latestAssistantText || raw?.latest_assistant_text || '').trim();
  const userText = String(raw?.latestUserText || raw?.latest_user_text || '').trim();
  return {
    latest_assistant_text: assistantText,
    latest_assistant_hash: raw?.latest_assistant_hash || raw?.latestAssistantHash || hashText(assistantText),
    latest_user_text: userText,
    latest_user_hash: raw?.latest_user_hash || raw?.latestUserHash || hashText(userText),
    is_thinking: Boolean(raw?.isThinking ?? raw?.is_thinking),
    login_required: Boolean(raw?.loginRequired ?? raw?.login_required),
    network_error: Boolean(raw?.networkError ?? raw?.network_error),
    identity: {
      project_fingerprint: project,
      account_fingerprint: account,
      conversation_id: raw?.conversation_id || raw?.conversationId || identity.conversation_id,
    },
    diagnostics: { body_tail: raw?.bodyTail || raw?.body_tail || '' },
  };
}

export async function capturePage(transport, targetId, pageUrl) {
  const raw = await transport.evaluate(targetId, DOM_SNAPSHOT_SCRIPT);
  return normalizeCapture(raw || {}, pageUrl);
}

export async function sampleStable(capture, { stableSampleCount = 2, pollMs = 150, deadlineMs = 0, afterHash = undefined, maxSamples = undefined } = {}) {
  const count = Math.max(2, Number(stableSampleCount) || 2);
  const requestedDeadline = Math.max(0, Number(deadlineMs) || 0);
  const deadline = requestedDeadline > 0 ? Date.now() + requestedDeadline : 0;
  let previousHash = null;
  let stableCount = 0;
  let changed = false;
  let last = null;
  let samples = 0;
  while (true) {
    last = await capture();
    samples += 1;
    const hash = last.latest_assistant_hash;
    if (afterHash && hash && hash !== afterHash) changed = true;
    if (hash && hash === previousHash && last.latest_assistant_text && !last.is_thinking) stableCount += 1;
    else stableCount = hash && last.latest_assistant_text && !last.is_thinking ? 1 : 0;
    previousHash = hash;
    const currentDifferent = !afterHash || (Boolean(hash) && hash !== afterHash);
    if (stableCount >= count && currentDifferent) return { kind: 'stable', value: last, changed };
    if (maxSamples && samples >= maxSamples) return { kind: changed ? 'unstable_timeout' : 'no_change', value: last, changed };
    if (deadline && Date.now() >= deadline) return { kind: changed ? 'unstable_timeout' : 'no_change', value: last, changed };
    if (!deadline && Number(deadlineMs) !== 0) return { kind: changed ? 'unstable_timeout' : 'no_change', value: last, changed };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
