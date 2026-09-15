import { BridgeError } from './security.mjs';

export const PREPARE_MESSAGE_SCRIPT = (text) => `(() => {
  const value = ${JSON.stringify(String(text))};
  const usable = (node) => node && node.isConnected && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden' && node.getAttribute('aria-hidden') !== 'true';
  const composer = [...document.querySelectorAll('#prompt-textarea[contenteditable="true"], textarea, [contenteditable="true"]')].find(usable);
  if (!composer) return { ok: false, reason: 'composer_missing' };
  composer.focus();
  if (composer.matches('textarea')) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(composer, value); else composer.value = value;
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    return { ok: true, contenteditable: false, composerEmpty: composer.value === '' };
  }
  document.execCommand('selectAll', false);
  document.execCommand('insertText', false, value);
  composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  return { ok: true, contenteditable: true, composerEmpty: textOf(composer) === '' };
  function textOf(node) { return String(node?.innerText || node?.textContent || '').trim(); }
})()`;

export const CLICK_SUBMIT_SCRIPT = `(() => {
  const usable = (node) => node && node.isConnected && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden' && node.getAttribute('aria-hidden') !== 'true' && !node.disabled;
  const composer = [...document.querySelectorAll('#prompt-textarea[contenteditable="true"], textarea, [contenteditable="true"]')].find(usable);
  if (!composer) return { ok: false, reason: 'composer_missing' };
  const form = composer.closest('form');
  const button = [...(form || document).querySelectorAll('button, [role="button"]')].find((node) => usable(node) && !/mic|voice|语音/i.test(String(node.getAttribute('aria-label') || '') + ' ' + String(node.textContent || '')) && (/send|submit|发送/i.test(String(node.getAttribute('aria-label') || '') + ' ' + String(node.textContent || '')) || node.getAttribute('type') === 'submit'));
  if (!button) return { ok: false, reason: 'submit_missing' };
  button.click();
  return { ok: true };
})()`;

export async function submitMessage(transport, targetId, text) {
  const prepared = await transport.evaluate(targetId, PREPARE_MESSAGE_SCRIPT(text));
  if (!prepared?.ok) throw new BridgeError('SOL_COMPOSER_UNAVAILABLE', 'Sol composer could not be located or populated.');
  if (prepared.contenteditable) await transport.sendCommand(targetId, 'Input.insertText', { text: String(text) });
  const submitted = await transport.evaluate(targetId, CLICK_SUBMIT_SCRIPT);
  if (!submitted?.ok) throw new BridgeError('SOL_SUBMIT_UNAVAILABLE', 'Sol submit control could not be located.');
  return submitted;
}
