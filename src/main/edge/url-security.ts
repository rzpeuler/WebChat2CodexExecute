const ALLOWED_CHATGPT_HOSTNAMES = new Set(['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com', 'www.chat.openai.com']);

const ALLOWED_CDP_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

export function isAllowedChatGptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ALLOWED_CHATGPT_HOSTNAMES.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isAllowedCdpWebSocketUrl(value: string, port: number): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'ws:' || url.protocol === 'wss:') &&
      ALLOWED_CDP_HOSTNAMES.has(url.hostname.toLowerCase()) &&
      url.port === String(port)
    );
  } catch {
    return false;
  }
}

export function hasKnownIdentity(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
