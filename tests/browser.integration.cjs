'use strict';
// Real Chromium extension test; every ChatGPT response below is a local fixture.
// No account credentials or live ChatGPT requests are used by this test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const composer = '<form><textarea id="prompt-textarea" aria-label="Message" placeholder="Message ChatGPT"></textarea><button type="submit">Send</button></form>';
const chatHTML = `<!doctype html><html><head><title>Chat fixture</title><style>
body { margin:0; background:#151918; color:#e0e6e3; font:16px/1.5 sans-serif; }
main { max-width:780px; margin:40px auto; padding:0 16px; } #composer-root { margin-top:80px; }
form { padding:16px; border:1px solid #58635e; border-radius:16px; }
textarea { display:block; box-sizing:border-box; width:100%; min-height:80px; background:#262d29; color:white; border:0; }
button { margin-top:8px; } article { padding:20px 0; }
</style></head><body><main><h1>Chat fixture</h1><article data-message-author-role="assistant">Conversation content.</article><div id="composer-root">${composer}</div></main></body></html>`;
function usageHTML(fiveHour, weekly) {
  return `<!doctype html><html><head><title>Usage reader fixture</title></head><body><main>
  <h1>Usage</h1><h2>General usage limits</h2>
  <section><h3>Monthly usage limit</h3><p>0 of 0 credits used</p><div>0% remaining</div></section>
  <section><div><h3>5 hour usage limit</h3><p>Resets 6:25 PM</p></div><div>${fiveHour}% left</div></section>
  <section><div><h3>Weekly usage limit</h3><p>Resets Nov 9, 2026, 1:25 PM</p></div><div>${weekly}% left</div></section>
  <div style="display:none"><h3>Weekly usage limit</h3><p>1% left</p></div>
  </main></body></html>`;
}
async function eventually(check, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out waiting for automatic reader');
}
test('automatic reader in a real Chromium extension', { timeout: 120000 }, async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-under-chat-'));
  const extension = path.resolve(__dirname, '..');
  let context;
  const diagnostics = { stage: 'launching Chromium', checks: [], error: null };
  const step = async (name, run) => { diagnostics.stage = name; console.log(name); await run(); diagnostics.checks.push(name); };
  let amounts = [94, 99], showLogin = false;
  let usageRequests = 0;
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); };
  // An actual local HTTPS fixture server also covers the first request of extension-created tabs.
  // Playwright route interception can miss that first navigation before attaching to the new target.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(profile, 'key.pem'), '-out', path.join(profile, 'cert.pem'), '-subj', '/CN=chatgpt.com', '-days', '1'], { stdio: 'ignore' });
  const fixture = https.createServer({ key: await fs.readFile(path.join(profile, 'key.pem')), cert: await fs.readFile(path.join(profile, 'cert.pem')) }, (request, response) => {
    const usage = new URL(request.url, 'https://chatgpt.com').pathname === '/settings/usage';
    if (usage) usageRequests++;
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end(usage ? (showLogin ? '<h1>Sign in to ChatGPT</h1>' : usageHTML(...amounts)) : chatHTML);
  });
  fixture.on('connection', track);
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const proxy = http.createServer((_request, response) => { response.writeHead(502); response.end(); });
  proxy.on('connection', track);
  proxy.on('connect', (request, socket, head) => {
    if (request.url !== 'chatgpt.com:443') { socket.destroy(); return; }
    const upstream = net.connect(fixture.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    track(upstream);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: !process.env.CI, colorScheme: 'dark', viewport: { width: 1100, height: 800 },
      ignoreHTTPSErrors: true,
      proxy: { server: `http://127.0.0.1:${proxy.address().port}` },
      args: ['--no-sandbox', '--ignore-certificate-errors', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    diagnostics.stage = 'waiting for extension service worker';
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const id = worker.url().split('/')[2];
    const chat = await context.newPage();
    await chat.goto('https://chatgpt.com/c/test');
    const bar = chat.locator('#usage-under-chat-extension');
    const saved = () => worker.evaluate(async () => (await chrome.storage.local.get('usageSnapshot')).usageSnapshot);
    await step('opens the inactive source and displays actual parsed fixture values without setup', async () => {
      await eventually(async () => (await saved())?.windows?.weekly?.remaining === 99);
      await bar.getByText('94% left', { exact: true }).waitFor();
      await bar.getByText('99% left', { exact: true }).waitFor();
      assert.match(await bar.locator('#age').innerText(), /Auto · read just now/);
      const source = context.pages().filter(page => page.url() === 'https://chatgpt.com/settings/usage');
      assert.equal(source.length, 1);
      const tabs = await worker.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }));
      assert.equal(tabs[0].url, 'https://chatgpt.com/c/test');
      const formRect = await chat.locator('form').boundingBox();
      const barRect = await bar.boundingBox();
      assert.ok(barRect.y >= formRect.y + formRect.height - 1, 'Overlay belongs below composer');
    });
    await step('ignores usage-like text and dialogs inside the conversation', async () => {
      await chat.locator('article').evaluate(el => { el.innerHTML = '<div role="dialog"><h2>Usage</h2><p>5 hour usage limit</p><p>1% left</p><p>Weekly usage limit</p><p>2% left</p></div>'; });
      await new Promise(resolve => setTimeout(resolve, 800));
      assert.equal((await saved()).windows.weekly.remaining, 99);
    });
    const source = context.pages().find(page => page.url() === 'https://chatgpt.com/settings/usage');
    await step('refresh alarm updates the overlay from a newly loaded source page', async () => {
      amounts = [63, 80];
      await worker.evaluate(async () => {
        const { reader } = await chrome.storage.session.get('reader');
        reader.nextAt = 0; reader.attemptAt = 0;
        await chrome.storage.session.set({ reader });
        await chrome.alarms.create('usage-reader-poll', { when: Date.now() + 1000 });
      });
      await eventually(async () => (await saved())?.windows?.weekly?.remaining === 80);
      await bar.getByText('63% left', { exact: true }).waitFor();
      assert.equal(context.pages().filter(page => page.url() === source.url()).length, 1);
    });
    await step('recovers after the app replaces its composer', async () => {
      await chat.locator('#composer-root').evaluate((el, html) => { el.innerHTML = html; }, composer);
      await bar.getByText('80% left', { exact: true }).waitFor();
      assert.equal(await chat.locator('#usage-under-chat-extension').count(), 1);
    });
    await step('fits a narrow viewport without horizontal overflow', async () => {
      await chat.setViewportSize({ width: 390, height: 844 });
      await bar.getByText('63% left', { exact: true }).waitFor();
      assert.equal(await chat.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await step('popup can pause automatic reads without a paste or screenshot flow', async () => {
      assert.equal(await popup.locator('textarea').count(), 0);
      await popup.locator('#automatic').uncheck();
      await eventually(() => worker.evaluate(async () => (await chrome.storage.local.get('autoEnabled')).autoEnabled === false));
      amounts = [20, 30];
      await source.reload();
      await new Promise(resolve => setTimeout(resolve, 800));
      assert.equal((await saved()).windows.weekly.remaining, 80);
      showLogin = true;
      await source.reload();
      await popup.locator('#automatic').check();
    });
    await step('a missing or signed-out source preserves the last read and reports failure', async () => {
      showLogin = true;
      await worker.evaluate(async () => {
        const { reader } = await chrome.storage.session.get('reader');
        reader.deadline = Date.now() - 1;
        await chrome.storage.session.set({ reader });
        await chrome.alarms.create('usage-reader-timeout', { when: Date.now() + 1000 });
      });
      await eventually(() => worker.evaluate(async () => (await chrome.storage.local.get('readerStatus')).readerStatus.state === 'error'));
      assert.equal((await saved()).windows.weekly.remaining, 80);
    });
    diagnostics.stage = 'passed';
  } catch (error) {
    diagnostics.error = error.message;
    diagnostics.usageRequests = usageRequests;
    diagnostics.pages = context?.pages().map(page => page.url());
    diagnostics.workers = context?.serviceWorkers().map(worker => worker.url());
    const worker = context?.serviceWorkers()[0];
    if (worker) {
      try {
        diagnostics.storage = await worker.evaluate(async () => {
          const local = await chrome.storage.local.get(null), session = await chrome.storage.session.get(null);
          let probe;
          try { probe = await chrome.tabs.sendMessage(session.reader?.tabId, { type: 'READER_DIAGNOSTICS' }); } catch (error) { probe = { error: error.message }; }
          return { local, session, probe };
        });
      } catch {}
    }
    throw error;
  } finally {
    await fs.mkdir('test-results', { recursive: true });
    await fs.writeFile('test-results/browser-diagnostics.json', JSON.stringify(diagnostics, null, 2));
    await context?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => proxy.close(resolve));
    await new Promise(resolve => fixture.close(resolve));
    await fs.rm(profile, { recursive: true, force: true });
  }
});
