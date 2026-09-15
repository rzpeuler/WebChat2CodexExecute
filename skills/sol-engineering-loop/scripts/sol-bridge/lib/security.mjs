import { createHash } from 'node:crypto';

const CHATGPT_HOSTS = new Set([
  'chatgpt.com',
  'www.chatgpt.com',
  'chat.openai.com',
  'www.chat.openai.com',
]);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export class BridgeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }
}

export function isAllowedChatGptUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && CHATGPT_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isAllowedCdpWebSocketUrl(value, port) {
  try {
    const url = new URL(value);
    return (url.protocol === 'ws:' || url.protocol === 'wss:') &&
      LOCAL_HOSTS.has(url.hostname.toLowerCase()) &&
      Number(url.port) === Number(port);
  } catch {
    return false;
  }
}

export function conversationIdFromUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/c\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export function fingerprint(value) {
  if (value === null || value === undefined || value === '') return null;
  return createHash('sha256').update(String(value)).digest('hex');
}

export function hashText(value) {
  return fingerprint(String(value ?? '').replace(/\r\n/g, '\n').trim());
}

export function projectFingerprintFromUrl(value) {
  try {
    const url = new URL(value);
    const project = url.searchParams.get('project') || url.searchParams.get('project_id');
    return fingerprint(project || 'default-chatgpt-project');
  } catch {
    return null;
  }
}

export function identityFromUrl(value) {
  return {
    project_fingerprint: projectFingerprintFromUrl(value),
    conversation_id: conversationIdFromUrl(value),
  };
}

export function isCompleteIdentity(identity) {
  return Boolean(identity?.project_fingerprint && identity?.account_fingerprint && identity?.conversation_id);
}

export function assertAllowedConversationUrl(value) {
  if (!isAllowedChatGptUrl(value)) {
    throw new BridgeError('IDENTITY_ORIGIN_INVALID', 'Conversation URL is not an allowed ChatGPT origin.');
  }
}

