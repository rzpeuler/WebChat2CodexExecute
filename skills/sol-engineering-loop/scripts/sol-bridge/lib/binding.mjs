import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { loadJsonWithBackup, writeJsonAtomic } from './io.mjs';
import { BridgeError, assertAllowedConversationUrl, conversationIdFromUrl, isAllowedChatGptUrl, isCompleteIdentity } from './security.mjs';

export function bindingPath(stateDir) { return join(stateDir, 'sol-binding.json'); }
export function pendingDeliveryPath(stateDir) { return join(stateDir, 'sol-pending-send.json'); }

export function validateBinding(value) {
  return Boolean(value && value.version === 1 && typeof value.project_fingerprint === 'string' &&
    typeof value.account_fingerprint === 'string' && typeof value.conversation_id === 'string' &&
    typeof value.conversation_url === 'string' && isAllowedChatGptUrl(value.conversation_url) &&
    conversationIdFromUrl(value.conversation_url) === value.conversation_id &&
    (value.target_id_hint === null || typeof value.target_id_hint === 'string') &&
    (value.last_observed_assistant_hash === null || typeof value.last_observed_assistant_hash === 'string') &&
    typeof value.updated_at === 'string');
}

export async function loadBinding(stateDir) {
  const result = await loadJsonWithBackup(bindingPath(stateDir), validateBinding);
  if (!result.value) throw new BridgeError('BINDING_MISSING', 'No valid Sol conversation binding exists.');
  return result.value;
}

export async function saveBinding(stateDir, value) {
  if (!validateBinding(value)) throw new BridgeError('BINDING_INVALID', 'Binding does not satisfy the minimal durable schema.');
  await writeJsonAtomic(bindingPath(stateDir), value);
}

export function bindingIdentityMatches(binding, capture, targetUrl) {
  const identity = capture?.identity || {};
  return isAllowedChatGptUrl(targetUrl) && conversationIdFromUrl(targetUrl) === binding.conversation_id &&
    identity.conversation_id === binding.conversation_id &&
    identity.project_fingerprint === binding.project_fingerprint &&
    identity.account_fingerprint === binding.account_fingerprint;
}

export async function chooseBindingTarget(targets, input, captureTarget) {
  const pages = targets.filter((target) => target.type === 'page' && isAllowedChatGptUrl(target.url));
  if (input.target_id) {
    const target = pages.find((item) => item.id === input.target_id);
    if (!target) throw new BridgeError('BINDING_AMBIGUOUS', 'Requested target is not an allowed live ChatGPT page.');
    return target;
  }
  if (input.conversation_url) {
    assertAllowedConversationUrl(input.conversation_url);
    const matches = pages.filter((item) => item.url === input.conversation_url);
    if (matches.length !== 1) throw new BridgeError('BINDING_AMBIGUOUS', 'Expected conversation URL did not identify exactly one live target.');
    return matches[0];
  }
  const candidates = [];
  for (const target of pages) {
    const capture = await captureTarget(target);
    if (isCompleteIdentity(capture.identity)) candidates.push({ target, capture });
  }
  if (candidates.length !== 1) throw new BridgeError('BINDING_AMBIGUOUS', 'Live ChatGPT targets cannot be uniquely identified.');
  return candidates[0].target;
}

export async function resolveBoundTarget(targets, binding, captureTarget) {
  const pages = targets.filter((target) => target.type === 'page' && isAllowedChatGptUrl(target.url) && conversationIdFromUrl(target.url) === binding.conversation_id);
  const hinted = binding.target_id_hint ? pages.filter((target) => target.id === binding.target_id_hint) : [];
  const candidates = hinted.length ? hinted : pages;
  const matches = [];
  for (const target of candidates) {
    const capture = await captureTarget(target);
    if (bindingIdentityMatches(binding, capture, target.url)) matches.push({ target, capture });
  }
  if (matches.length !== 1) throw new BridgeError(matches.length ? 'BINDING_AMBIGUOUS' : 'BOUND_CONVERSATION_UNAVAILABLE', 'Bound conversation could not be uniquely revalidated.');
  return matches[0];
}

