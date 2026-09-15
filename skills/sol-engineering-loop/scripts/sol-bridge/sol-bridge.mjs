import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promises as fs } from 'node:fs';
import { CdpTransport } from './lib/cdp.mjs';
import { EdgeProfileManager } from './lib/browser-profile.mjs';
import { capturePage, sampleStable } from './lib/capture.mjs';
import { bindingPath, chooseBindingTarget, loadBinding, pendingDeliveryPath, resolveBoundTarget, saveBinding, validateBinding } from './lib/binding.mjs';
import { submitMessage } from './lib/conversation.mjs';
import { clearJson, loadJsonWithBackup, writeJsonAtomic } from './lib/io.mjs';
import { BridgeError, assertAllowedConversationUrl, conversationIdFromUrl, hashText, isCompleteIdentity, isAllowedChatGptUrl } from './lib/security.mjs';

const DEFAULT_STATE_DIR = join(homedir(), '.codex', 'sol-engineering-loop');

function pendingValid(value) {
  return Boolean(value && value.version === 1 && typeof value.project_fingerprint === 'string' &&
    typeof value.account_fingerprint === 'string' && typeof value.conversation_id === 'string' &&
    typeof value.conversation_url === 'string' && isAllowedChatGptUrl(value.conversation_url) &&
    conversationIdFromUrl(value.conversation_url) === value.conversation_id &&
    typeof value.message_hash === 'string' && typeof value.delivery_key === 'string' &&
    (value.pre_send_latest_user_hash === null || typeof value.pre_send_latest_user_hash === 'string') &&
    typeof value.created_at === 'string');
}

async function loadPending(stateDir) {
  const path = pendingDeliveryPath(stateDir);
  const result = await loadJsonWithBackup(path, pendingValid);
  if (result.value) return result.value;
  const present = await Promise.all([path, `${path}.bak`].map(async (candidate) => fs.stat(candidate).then(() => true).catch(() => false)));
  if (present.some(Boolean)) throw new BridgeError('PENDING_STATE_CORRUPT', 'Pending delivery state is not valid in primary or backup storage.');
  return null;
}

export function classifyPendingDelivery(pending, currentLatestUserHash) {
  if (currentLatestUserHash === pending.message_hash && pending.pre_send_latest_user_hash !== pending.message_hash) {
    return 'MESSAGE_ALREADY_DELIVERED';
  }
  return 'SEND_UNCONFIRMED';
}

export function createContext(input = {}, overrides = {}) {
  const stateDir = resolve(input.state_dir || DEFAULT_STATE_DIR);
  const profile = overrides.profile || new EdgeProfileManager({
    stateDir,
    userDataDirectory: input.user_data_directory || join(stateDir, 'edge-profile'),
    port: input.remote_debugging_port || 9229,
    executablePath: input.executable_path,
    initialUrl: input.initial_url,
  });
  const transport = overrides.transport || new CdpTransport({ port: input.remote_debugging_port || 9229 });
  const captureTarget = overrides.captureTarget || ((target) => capturePage(transport, target.id, target.url));
  return { stateDir, profile, transport, captureTarget, now: overrides.now || (() => new Date().toISOString()) };
}

async function ensureBridge(ctx, { inspectLogin = true } = {}) {
  const profile = await ctx.profile.ensure();
  const targets = await ctx.transport.listTargets();
  const pages = targets.filter((target) => target.type === 'page' && isAllowedChatGptUrl(target.url));
  if (!pages.length) throw new BridgeError('CDP_UNAVAILABLE', 'No allowed ChatGPT page is available through localhost CDP.');
  if (inspectLogin) {
    const capture = await ctx.captureTarget(pages[0]);
    if (capture.login_required) return { profile, targets, pages, loginRequired: true };
  }
  return { profile, targets, pages, loginRequired: false };
}

async function requireBoundTarget(ctx) {
  const binding = await loadBinding(ctx.stateDir);
  const ready = await ensureBridge(ctx, { inspectLogin: false });
  const resolved = await resolveBoundTarget(ready.targets, binding, ctx.captureTarget);
  return { binding, ready, target: resolved.target, capture: resolved.capture };
}

function identityForBinding(capture, target) {
  return {
    project_fingerprint: capture.identity?.project_fingerprint,
    account_fingerprint: capture.identity?.account_fingerprint,
    conversation_id: capture.identity?.conversation_id || conversationIdFromUrl(target.url),
  };
}

async function commandEnsure(ctx) {
  const ready = await ensureBridge(ctx);
  return { ok: true, code: ready.loginRequired ? 'LOGIN_REQUIRED' : 'BRIDGE_READY', browser_running: true, cdp_available: true, login_required: ready.loginRequired };
}

async function commandBind(ctx, input) {
  const ready = await ensureBridge(ctx);
  if (ready.loginRequired) throw new BridgeError('LOGIN_REQUIRED', 'Log in to the bound ChatGPT profile manually, then retry bind.');
  const target = await chooseBindingTarget(ready.targets, input, ctx.captureTarget);
  const capture = await ctx.captureTarget(target);
  const identity = identityForBinding(capture, target);
  if (!isCompleteIdentity(identity)) throw new BridgeError('IDENTITY_INCOMPLETE', 'Project, account, and conversation identity must all be observable before binding.');
  if (input.project_fingerprint && input.project_fingerprint !== identity.project_fingerprint) throw new BridgeError('PROJECT_MISMATCH', 'Requested project does not match the live target.');
  if (input.account_fingerprint && input.account_fingerprint !== identity.account_fingerprint) throw new BridgeError('ACCOUNT_MISMATCH', 'Requested account does not match the live target.');
  assertAllowedConversationUrl(target.url);
  const binding = {
    version: 1,
    project_fingerprint: identity.project_fingerprint,
    account_fingerprint: identity.account_fingerprint,
    conversation_id: identity.conversation_id,
    conversation_url: target.url,
    conversation_title: String(target.title || '').slice(0, 300),
    target_id_hint: target.id,
    last_observed_assistant_hash: capture.latest_assistant_hash || null,
    updated_at: ctx.now(),
  };
  await saveBinding(ctx.stateDir, binding);
  return { ok: true, code: 'BOUND', binding: { ...binding, target_id_hint: Boolean(binding.target_id_hint) ? binding.target_id_hint : null } };
}

async function commandRead(ctx, input) {
  const { binding, target } = await requireBoundTarget(ctx);
  const waitMs = Math.max(0, Number(input.wait_ms) || 0);
  const afterHash = input.after_hash || undefined;
  const stableSampleCount = Math.max(2, Number(input.stable_sample_count) || 2);
  const capture = () => ctx.captureTarget(target);
  let result;
  if (waitMs > 0) {
    result = await sampleStable(capture, { stableSampleCount, pollMs: Math.min(250, Math.max(20, Math.floor(waitMs / 20))), deadlineMs: waitMs, afterHash });
  } else {
    result = await sampleStable(capture, { stableSampleCount, pollMs: 0, deadlineMs: 0, maxSamples: stableSampleCount });
  }
  if (result.kind === 'stable' && afterHash && result.value.latest_assistant_hash === afterHash) {
    return { ok: true, code: 'NO_NEW_ASSISTANT_OUTPUT', observed_hash: result.value.latest_assistant_hash, observation: result.value };
  }
  if (result.kind === 'stable') {
    const updated = { ...binding, last_observed_assistant_hash: result.value.latest_assistant_hash || null, updated_at: ctx.now() };
    await saveBinding(ctx.stateDir, updated);
    return { ok: true, code: afterHash ? 'ASSISTANT_OUTPUT_READY' : 'ASSISTANT_OUTPUT_READY', observation: result.value };
  }
  return { ok: true, code: result.kind === 'unstable_timeout' ? 'READ_TIMEOUT' : (waitMs ? 'NO_NEW_ASSISTANT_OUTPUT' : 'READ_TIMEOUT'), observation: result.value };
}

async function recoverPending(ctx, pending) {
  const { binding, target } = await requireBoundTarget(ctx);
  if (pending.project_fingerprint !== binding.project_fingerprint || pending.account_fingerprint !== binding.account_fingerprint ||
      pending.conversation_id !== binding.conversation_id || pending.conversation_url !== binding.conversation_url) {
    throw new BridgeError('PENDING_STATE_INVALID', 'Pending delivery identity does not match the current binding.');
  }
  const capture = await ctx.captureTarget(target);
  const code = classifyPendingDelivery(pending, capture.latest_user_hash);
  if (code === 'MESSAGE_ALREADY_DELIVERED') {
    await clearJson(pendingDeliveryPath(ctx.stateDir));
    return { ok: true, code, delivery_key: pending.delivery_key };
  }
  return { ok: true, code, delivery_key: pending.delivery_key, pending_delivery: true };
}

async function commandSend(ctx, input) {
  if (typeof input.text !== 'string' || !input.text.trim()) throw new BridgeError('MESSAGE_INVALID', 'send requires non-empty text.');
  const pending = await loadPending(ctx.stateDir);
  if (pending) return recoverPending(ctx, pending);
  const { binding, target, capture: before } = await requireBoundTarget(ctx);
  const messageHash = hashText(input.text);
  const pendingRecord = {
    version: 1,
    project_fingerprint: binding.project_fingerprint,
    account_fingerprint: binding.account_fingerprint,
    conversation_id: binding.conversation_id,
    conversation_url: binding.conversation_url,
    message_hash: messageHash,
    delivery_key: randomUUID(),
    pre_send_latest_user_hash: before.latest_user_hash || null,
    created_at: ctx.now(),
  };
  await writeJsonAtomic(pendingDeliveryPath(ctx.stateDir), pendingRecord);
  try {
    const submitted = await submitMessage(ctx.transport, target.id, input.text);
    let confirmed = Boolean(submitted?.composerEmpty);
    if (!confirmed) {
      const after = await ctx.captureTarget(target);
      confirmed = after.latest_user_hash === messageHash || after.latest_assistant_hash !== before.latest_assistant_hash || after.is_thinking;
    }
    if (!confirmed) throw new BridgeError('SEND_UNCONFIRMED', 'Message submission has no transport-level confirmation.');
    await clearJson(pendingDeliveryPath(ctx.stateDir));
    return { ok: true, code: 'MESSAGE_SENT', delivery_key: pendingRecord.delivery_key };
  } catch (error) {
    if (error instanceof BridgeError && error.code === 'SEND_UNCONFIRMED') return { ok: true, code: 'SEND_UNCONFIRMED', delivery_key: pendingRecord.delivery_key, pending_delivery: true };
    return { ok: true, code: 'SEND_UNCONFIRMED', delivery_key: pendingRecord.delivery_key, pending_delivery: true, reason: error.message };
  }
}

async function commandStatus(ctx) {
  const pending = await loadPending(ctx.stateDir);
  const result = { ok: true, browser_running: false, cdp_available: false, login_required: false, bound: false, project_matches: false, account_matches: false, conversation_matches: false, sol_thinking: false, pending_delivery_present: Boolean(pending) };
  try {
    const ready = await ensureBridge(ctx);
    result.browser_running = true;
    result.cdp_available = true;
    result.login_required = ready.loginRequired;
    if (pending) return result;
    const binding = await loadBinding(ctx.stateDir).catch(() => null);
    if (!binding) return result;
    const resolved = await resolveBoundTarget(ready.targets, binding, ctx.captureTarget).catch(() => null);
    if (!resolved) return result;
    result.bound = true;
    result.project_matches = true;
    result.account_matches = true;
    result.conversation_matches = true;
    result.sol_thinking = Boolean(resolved.capture.is_thinking);
    return result;
  } catch (error) {
    return { ...result, ok: false, code: error.code || 'BRIDGE_STATUS_UNAVAILABLE', error: error.message };
  }
}

export async function runCommand(command, input = {}, overrides = {}) {
  const ctx = createContext(input, overrides);
  try {
    if (command === 'ensure') return await commandEnsure(ctx);
    if (command === 'bind') return await commandBind(ctx, input);
    if (command === 'read') return await commandRead(ctx, input);
    if (command === 'send') return await commandSend(ctx, input);
    if (command === 'status') return await commandStatus(ctx);
    throw new BridgeError('COMMAND_INVALID', `Unknown Sol Bridge command: ${command}`);
  } catch (error) {
    return { ok: false, code: error.code || 'BRIDGE_FAILED', error: error.message, details: error.details };
  }
}

async function main() {
  const command = process.argv[2];
  const inputIndex = process.argv.indexOf('--input');
  const input = inputIndex >= 0 ? JSON.parse(await fs.readFile(process.argv[inputIndex + 1], 'utf8')) : {};
  const result = await runCommand(command, input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
