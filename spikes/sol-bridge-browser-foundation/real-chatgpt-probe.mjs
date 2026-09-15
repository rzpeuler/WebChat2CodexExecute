import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { CdpTransport } from '../../skills/sol-engineering-loop/scripts/sol-bridge/lib/cdp.mjs';

const execFile = (file, args) => new Promise((resolve) => execFileCallback(file, args, { windowsHide: true }, () => resolve()));
const CHATGPT_URL = 'https://chatgpt.com/';
const executable = [
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].filter(Boolean).find((path) => existsSync(path));

function summarize(value) {
  const url = new URL(value.url);
  const body = String(value.body || '').replace(/\s+/g, ' ').trim();
  return { title: value.title, origin: url.origin, path: url.pathname, body_prefix: body.slice(0, 500), login_required: /log in|sign in|登录|无法登录|create account/i.test(body) };
}

async function waitCdp(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('CDP startup timeout');
}

async function stop(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') await execFile('taskkill', ['/PID', String(child.pid), '/T', '/F']); else child.kill();
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

async function removeProfile(path) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { await fs.rm(path, { recursive: true, force: true }); return; }
    catch (error) { if (error.code !== 'EBUSY' && error.code !== 'EPERM') throw error; await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw new Error(`profile cleanup remained locked: ${path}`);
}

async function direct() {
  const profile = join(tmpdir(), `sol-real-direct-${randomUUID()}`);
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { executablePath: executable, headless: false });
    const page = await context.newPage();
    await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    return { candidate: 'PLAYWRIGHT_DIRECT', result: summarize({ title: await page.title(), url: page.url(), body: await page.locator('body').innerText().catch(() => '') }) };
  } finally { await context?.close().catch(() => {}); await removeProfile(profile); }
}

async function overCdp() {
  const profile = join(tmpdir(), `sol-real-cdp-${randomUUID()}`);
  const port = 10500 + Math.floor(Math.random() * 300);
  let child;
  let browser;
  try {
    child = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check', '--new-window', CHATGPT_URL], { windowsHide: true, stdio: 'ignore' });
    await waitCdp(port);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts()[0].pages().find((candidate) => candidate.url().startsWith('https://chatgpt.com')) || browser.contexts()[0].pages()[0];
    if (!page) throw new Error('connectOverCDP exposed no ChatGPT page');
    await page.waitForTimeout(2000);
    return { candidate: 'PLAYWRIGHT_OVER_CDP', result: summarize({ title: await page.title(), url: page.url(), body: await page.locator('body').innerText().catch(() => '') }) };
  } finally { await browser?.close().catch(() => {}); await stop(child); await removeProfile(profile); }
}

async function custom() {
  const profile = join(tmpdir(), `sol-real-custom-${randomUUID()}`);
  const port = 10800 + Math.floor(Math.random() * 300);
  let child;
  try {
    child = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check', '--new-window', CHATGPT_URL], { windowsHide: true, stdio: 'ignore' });
    await waitCdp(port);
    const transport = new CdpTransport({ port });
    const deadline = Date.now() + 15000;
    let target;
    while (Date.now() < deadline) {
      target = (await transport.listTargets()).find((candidate) => candidate.type === 'page' && candidate.url.startsWith('https://chatgpt.com'));
      if (target) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!target) throw new Error('custom CDP exposed no ChatGPT page');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const value = await transport.evaluate(target.id, `JSON.stringify({title:document.title,url:location.href,body:document.body?.innerText||''})`);
    return { candidate: 'W2C_CUSTOM_CDP', result: summarize(JSON.parse(value)) };
  } finally { await stop(child); await removeProfile(profile); }
}

if (!executable) throw new Error('Microsoft Edge executable not found');
const results = [];
for (const probe of [direct, overCdp, custom]) {
  try { results.push(await probe()); } catch (error) { results.push({ candidate: probe.name, result: 'ERROR', error: error.message }); }
}
console.log(JSON.stringify({ real_chatgpt: true, authenticated: false, sent_message: false, results }, null, 2));
