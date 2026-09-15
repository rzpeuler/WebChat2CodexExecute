import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { CdpTransport } from '../../skills/sol-engineering-loop/scripts/sol-bridge/lib/cdp.mjs';
import { startFixtureServer } from './fixture/server.mjs';

const execFile = (file, args) => new Promise((resolve) => execFileCallback(file, args, { windowsHide: true }, () => resolve()));

const FIXTURE_MESSAGE = 'spike message';
const FIXTURE_FACTS = `(() => {
  const text = (node) => String(node?.innerText || node?.textContent || '').trim();
  const all = (selector) => [...document.querySelectorAll(selector)];
  const assistant = all('[data-message-author-role="assistant"]');
  const user = all('[data-message-author-role="user"]');
  return {
    url: location.href,
    project_fingerprint: document.querySelector('[data-project-id]')?.getAttribute('data-project-id') || null,
    account_fingerprint: document.querySelector('[data-account-id]')?.getAttribute('data-account-id') || null,
    conversation_id: location.pathname.split('/').pop() || null,
    latest_assistant_text: text(assistant.at(-1)),
    latest_user_text: text(user.at(-1)),
    thinking: !document.querySelector('#thinking')?.hidden,
    user_count: user.length,
    send_status: text(document.querySelector('#send-status')),
  };
})()`;
const FIXTURE_SEND = (message) => `(() => {
  const composer = document.querySelector('#prompt');
  composer.value = ${JSON.stringify(message)};
  composer.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#send').click();
  return true;
})()`;

function executablePath() {
  return [
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean).find((path) => path && requireExists(path));
}

function requireExists(path) {
  try { return existsSync(path); } catch { return false; }
}

async function waitForCdp(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`CDP did not start on port ${port}`);
}

async function waitForTarget(port, fragment, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = targets.find((candidate) => candidate.type === 'page' && candidate.url.includes(fragment));
      if (target) return target;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`CDP target did not reach ${fragment}`);
}

async function waitForCdpClosed(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (!(await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return; } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`CDP port ${port} did not close before restart`);
}

async function waitForCustomFacts(transport, port, fragment, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const target = await waitForTarget(port, fragment, 500);
      const facts = await transport.evaluate(target.id, FIXTURE_FACTS);
      if (facts.url.includes(fragment) && facts.latest_assistant_text) return { target, facts };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`custom CDP page did not become ready for ${fragment}`);
}

async function startEdge(url, profile, port) {
  const executable = executablePath();
  if (!executable) throw new Error('Microsoft Edge executable not found');
  const process = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check', '--new-window', url], { windowsHide: true, stdio: 'ignore' });
  await waitForCdp(port);
  return { process, executable };
}

async function stopProcess(child) {
  if (!child || child.killed) return;
  if (globalThis.process.platform === 'win32') await execFile('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  else child.kill();
  await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 1000); });
}

function assertFixtureFacts(facts) {
  if (facts.conversation_id !== 'fixture-1' || facts.project_fingerprint !== 'fixture-project' || facts.account_fingerprint !== 'fixture-account') throw new Error(`fixture identity mismatch: ${JSON.stringify(facts)}`);
  if (facts.latest_assistant_text !== 'fixture assistant message' || facts.latest_user_text !== 'fixture user message') throw new Error(`fixture capture mismatch: ${JSON.stringify(facts)}`);
  if (facts.thinking) throw new Error(`fixture unexpectedly thinking: ${JSON.stringify(facts)}`);
}

function assertAllowedOrigin(url) {
  const value = new URL(url);
  if (value.protocol !== 'https:' || !['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com', 'www.chat.openai.com'].includes(value.hostname)) throw new Error(`origin rejected as expected: ${url}`);
}

async function runPlaywrightPage(page) {
  const before = await page.evaluate(FIXTURE_FACTS);
  assertFixtureFacts(before);
  await page.locator('#prompt').fill(FIXTURE_MESSAGE);
  await page.locator('#send').click();
  await page.waitForFunction((message) => [...document.querySelectorAll('[data-message-author-role="user"]')].some((node) => node.textContent?.trim() === message), FIXTURE_MESSAGE);
  await page.waitForFunction(() => document.querySelector('#send-status')?.textContent === 'confirmed');
  const after = await page.evaluate(FIXTURE_FACTS);
  if (after.latest_user_text !== FIXTURE_MESSAGE || after.send_status !== 'confirmed') throw new Error('Playwright send confirmation failed');
  return { before, after };
}

async function runDirect(fixture) {
  const profile = join(tmpdir(), `sol-spike-direct-${randomUUID()}`);
  await fs.mkdir(profile, { recursive: true });
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { executablePath: executablePath(), headless: true });
    const page = await context.newPage();
    await page.goto(fixture.url);
    const first = await runPlaywrightPage(page);
    await page.evaluate(() => localStorage.setItem('spike-login-marker', 'persisted'));
    await context.close();
    context = await chromium.launchPersistentContext(profile, { executablePath: executablePath(), headless: true });
    const reopened = await context.newPage();
    await reopened.goto(fixture.url);
    const marker = await reopened.evaluate(() => localStorage.getItem('spike-login-marker'));
    if (marker !== 'persisted') throw new Error('direct persistent profile did not retain marker');
    return { candidate: 'SELECT_PLAYWRIGHT_DIRECT', result: 'PROVEN_FIXTURE', persistent_profile_reuse: true, pages: context.pages().length, scenario: first };
  } finally {
    await context?.close().catch(() => {});
    await fs.rm(profile, { recursive: true, force: true });
  }
}

async function runPlaywrightCdp(fixture) {
  const profile = join(tmpdir(), `sol-spike-cdp-${randomUUID()}`);
  const port = 9300 + Math.floor(Math.random() * 500);
  let edge;
  let browser;
  try {
    edge = await startEdge(fixture.url, profile, port);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const page = context.pages().find((candidate) => candidate.url().includes('/c/fixture-1')) || context.pages()[0];
    if (!page) throw new Error('connectOverCDP exposed no page');
    const first = await runPlaywrightPage(page);
    await page.evaluate(() => localStorage.setItem('spike-login-marker', 'persisted'));
    await page.reload();
    if (await page.evaluate(() => localStorage.getItem('spike-login-marker')) !== 'persisted') throw new Error('CDP marker was not durable before restart');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await browser.close();
    browser = undefined;
    await stopProcess(edge.process);
    await waitForCdpClosed(port);
    edge = await startEdge(fixture.url, profile, port);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const reopened = browser.contexts()[0].pages().find((candidate) => candidate.url().includes('/c/fixture-1')) || browser.contexts()[0].pages()[0];
    await reopened.waitForURL(/\/c\/fixture-1/);
    const marker = await reopened.evaluate(() => localStorage.getItem('spike-login-marker'));
    return { candidate: 'SELECT_PLAYWRIGHT_OVER_CDP', result: marker === 'persisted' ? 'PROVEN_FIXTURE' : 'NOT_VERIFIED_RESTART_MARKER', persistent_profile_reuse: marker === 'persisted', restart_marker: marker, cdp_contexts: browser.contexts().length, scenario: first };
  } finally {
    await browser?.close().catch(() => {});
    await stopProcess(edge?.process);
    await fs.rm(profile, { recursive: true, force: true });
  }
}

async function runCustomCdp(fixture) {
  const profile = join(tmpdir(), `sol-spike-custom-cdp-${randomUUID()}`);
  const port = 9800 + Math.floor(Math.random() * 500);
  let edge;
  try {
    edge = await startEdge(fixture.url, profile, port);
    const transport = new CdpTransport({ port });
    const ready = await waitForCustomFacts(transport, port, '/c/fixture-1');
    const target = ready.target;
    const before = ready.facts;
    assertFixtureFacts(before);
    await transport.evaluate(target.id, FIXTURE_SEND(FIXTURE_MESSAGE));
    const deadline = Date.now() + 2000;
    let after;
    do { after = await transport.evaluate(target.id, FIXTURE_FACTS); if (after.send_status === 'confirmed') break; await new Promise((resolve) => setTimeout(resolve, 40)); } while (Date.now() < deadline);
    if (after.latest_user_text !== FIXTURE_MESSAGE || after.send_status !== 'confirmed') throw new Error('custom CDP send confirmation failed');
    await transport.evaluate(target.id, `localStorage.setItem('spike-login-marker', 'persisted')`);
    await transport.evaluate(target.id, `location.reload()`);
    await waitForCustomFacts(transport, port, '/c/fixture-1');
    await stopProcess(edge.process);
    await waitForCdpClosed(port);
    edge = await startEdge(fixture.url, profile, port);
    const reopened = (await waitForCustomFacts(transport, port, '/c/fixture-1')).target;
    const marker = await transport.evaluate(reopened.id, `localStorage.getItem('spike-login-marker')`);
    return { candidate: 'SELECT_W2C_CUSTOM_CDP', result: marker === 'persisted' ? 'PROVEN_FIXTURE' : 'NOT_VERIFIED_RESTART_MARKER', persistent_profile_reuse: marker === 'persisted', restart_marker: marker, scenario: { before, after } };
  } finally {
    await stopProcess(edge?.process);
    await fs.rm(profile, { recursive: true, force: true });
  }
}

async function main() {
  const fixture = await startFixtureServer();
  try {
    assertAllowedOrigin('https://chatgpt.com/c/example');
    let selected = process.argv.includes('--candidate') ? process.argv[process.argv.indexOf('--candidate') + 1] : 'all';
    const results = [];
    if (selected === 'all' || selected === 'direct') results.push(await runDirect(fixture));
    if (selected === 'all' || selected === 'cdp') results.push(await runPlaywrightCdp(fixture));
    if (selected === 'all' || selected === 'custom') results.push(await runCustomCdp(fixture));
    console.log(JSON.stringify({ fixture: { url: fixture.url, simulated: true }, results }, null, 2));
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
  }
}

await main();
