'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const event = () => {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)), listeners };
};
const drain = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const windows = { fiveHour: { remaining: 94, reset: '6:25 PM' }, weekly: { remaining: 99, reset: 'Nov 9, 1:25 PM' } };
function environment(options = {}) {
  let now = 1800000000000;
  const local = {}, session = {}, logs = [], alarms = new Map();
  const tabs = new Map(options.noChats ? [] : [[1, { id: 1, windowId: 1, url: 'https://chatgpt.com/c/test', active: true, incognito: false }]]);
  const changed = event();
  function storage(data, area) {
    return {
      get: async keys => Object.fromEntries((keys == null ? Object.keys(data) : typeof keys === 'string' ? [keys] : keys).filter(key => key in data).map(key => [key, structuredClone(data[key])])),
      set: async values => {
        const updates = {};
        for (const [key, value] of Object.entries(values)) { updates[key] = { oldValue: data[key], newValue: structuredClone(value) }; data[key] = structuredClone(value); }
        queueMicrotask(() => changed.emit(updates, area));
      },
      remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
    };
  }
  let reply = options.reply || (async () => ({ ok: true, windows, scopeKey: 'a'.repeat(64) }));
  const chrome = {
    runtime: { id: 'test-extension', getURL: value => `chrome-extension://test-extension/${value}`, onMessage: event(), onInstalled: event(), onStartup: event() },
    storage: { local: storage(local, 'local'), session: storage(session, 'session'), onChanged: changed },
    alarms: { get: async name => alarms.get(name), create: async (name, value) => alarms.set(name, value), clear: async name => alarms.delete(name), onAlarm: event() },
    tabs: {
      query: async () => [...tabs.values()].map(tab => structuredClone(tab)),
      get: async id => { if (!tabs.has(id)) throw Error('No tab'); return structuredClone(tabs.get(id)); },
      create: async props => { logs.push(['create', props]); return { id: 99, ...props }; },
      remove: async id => { tabs.delete(id); logs.push(['remove', id]); },
      reload: async id => logs.push(['reload', id]),
      update: async (id, props) => logs.push(['update', id, props]),
      sendMessage: async (id, message) => { logs.push(['send', id, message]); return reply(id, message); }
    }
  };
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ chrome, URL, Date: Clock, Intl, console });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), context);
  const pageSender = () => ({ id: chrome.runtime.id, tab: structuredClone(tabs.get(1)), url: tabs.get(1)?.url });
  const popupSender = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') };
  async function message(value, sender = popupSender) {
    const handler = chrome.runtime.onMessage.listeners[0];
    return new Promise(resolve => { if (handler(value, sender, resolve) !== true) resolve(undefined); });
  }
  async function poll() { chrome.alarms.onAlarm.emit({ name: 'usage-reader-poll' }); await drain(); }
  return { local, session, tabs, logs, chrome, alarms, message, pageSender, poll, setReply: fn => { reply = fn; }, advance: ms => { now += ms; }, now: () => now };
}
test('reads in the existing active chat and coalesces requests without opening or reloading tabs', async () => {
  const e = environment();
  await Promise.all([e.message({ type: 'CHAT_READY' }, e.pageSender()), e.message({ type: 'CHAT_READY' }, e.pageSender())]);
  assert.deepEqual(e.logs.map(row => row[0]), ['send']);
  assert.equal(e.logs[0][1], 1); assert.equal(e.logs[0][2].type, 'FETCH_DIRECT_USAGE');
  assert.deepEqual(e.local.usageSnapshot.windows, windows); assert.equal(e.local.usageSnapshot.source, 'direct-session');
  assert.equal(e.session.reader.nextAt, e.now() + 120000);
});
test('an alarm reads again only when due, retaining a single chat tab', async () => {
  const e = environment(); await e.message({ type: 'REFRESH_USAGE' }); await e.poll();
  assert.equal(e.logs.length, 1); e.advance(120001); await e.poll();
  assert.equal(e.logs.length, 2); assert.equal(e.tabs.size, 1);
});
test('manual clicks honor cooldown and error backoff', async () => {
  const e = environment(); await e.message({ type: 'REFRESH_USAGE' });
  assert.equal((await e.message({ type: 'REFRESH_USAGE' })).waiting, true);
  e.advance(120001); e.setReply(async () => ({ ok: false, code: 'rate-limited', retryAfter: 900 })); await e.poll();
  assert.equal(e.session.reader.nextAt, e.now() + 900000); e.advance(60001);
  assert.equal((await e.message({ type: 'REFRESH_USAGE' })).waiting, true);
  assert.equal(e.logs.length, 2);
});
test('temporarily unavailable responses preserve the last good reading and retry slowly', async () => {
  const e = environment(); await e.message({ type: 'REFRESH_USAGE' }); e.advance(120001);
  e.setReply(async () => ({ ok: false, code: 'network' })); await e.poll();
  assert.equal(e.local.usageSnapshot.windows.weekly.remaining, 99);
  assert.equal(e.local.readerStatus.state, 'error'); assert.equal(e.session.reader.nextAt, e.now() + 120000);
});
test('signed-out, blocked, and account-mismatch results clear cached balances', async () => {
  for (const code of ['sign-in', 'blocked', 'account-mismatch']) {
    const e = environment(); await e.message({ type: 'REFRESH_USAGE' }); e.advance(120001);
    e.setReply(async () => ({ ok: false, code })); await e.poll(); assert.equal(e.local.usageSnapshot, undefined, code);
  }
});
test('changing account scope clears the previous balance even when the next read fails', async () => {
  const e = environment(); await e.message({ type: 'REFRESH_USAGE' }); e.advance(120001);
  e.setReply(async () => ({ ok: false, code: 'network', scopeKey: 'b'.repeat(64) })); await e.poll();
  assert.equal(e.local.usageSnapshot, undefined); assert.equal(e.session.reader.scopeKey, 'b'.repeat(64));
});
test('no chat, discarded tabs, and incognito cause no network work or new tabs', async () => {
  for (const mode of ['none', 'discarded', 'incognito']) {
    const e = environment({ noChats: mode === 'none' });
    if (mode !== 'none') e.tabs.get(1)[mode] = true;
    assert.equal((await e.message({ type: 'REFRESH_USAGE' })).idle, true);
    assert.equal(e.logs.length, 0);
  }
});
test('pausing prevents requests and discards an in-flight result', async () => {
  const e = environment(); e.local.autoEnabled = false;
  assert.equal((await e.message({ type: 'REFRESH_USAGE' })).paused, true); assert.equal(e.logs.length, 0);
  e.local.autoEnabled = true;
  let resolve; e.setReply(() => new Promise(done => { resolve = done; }));
  const pending = e.message({ type: 'REFRESH_USAGE' }); await drain(); e.local.autoEnabled = false;
  resolve({ ok: true, windows }); await pending;
  assert.equal(e.local.usageSnapshot, undefined); assert.equal(e.local.readerStatus.state, 'paused');
});
test('uses another already-open tab if the first lacks an updated content script', async () => {
  const e = environment(); e.tabs.set(2, { id: 2, url: 'https://chatgpt.com/c/other', active: false });
  e.setReply(async id => { if (id === 1) throw Error('No receiver'); return { ok: true, windows }; });
  assert.equal((await e.message({ type: 'REFRESH_USAGE' })).ok, true);
  assert.deepEqual(e.logs.map(row => row[1]), [1, 2]);
});
test('a freshly connected tab can recover immediately from missing listeners without issuing API retries', async () => {
  const e = environment({ reply: async () => { throw Error('No receiver'); } });
  await e.message({ type: 'REFRESH_USAGE' }); assert.equal(e.session.reader.failures, 0);
  e.setReply(async () => ({ ok: true, windows }));
  assert.equal((await e.message({ type: 'CHAT_READY' }, e.pageSender())).ok, true);
});
test('validates replies and never persists arbitrary credentials or raw response fields', async () => {
  const e = environment({ reply: async () => ({ ok: true, windows: { ...windows, accessToken: 'secret' }, accessToken: 'secret', scopeKey: 'not-a-hash' }) });
  await e.message({ type: 'REFRESH_USAGE' }); assert.equal(JSON.stringify([e.local, e.session]).includes('secret'), false);
  assert.equal(e.session.reader.scopeKey, undefined);
  e.advance(120001); e.setReply(async () => ({ ok: true, windows: { weekly: { remaining: 101 } } })); await e.poll();
  assert.equal(e.local.readerStatus.state, 'error');
});
test('rejects messages from other extensions and websites', async () => {
  const e = environment();
  assert.equal(await e.message({ type: 'REFRESH_USAGE' }, { id: 'other-extension', url: 'chrome-extension://other/popup.html' }), undefined);
  assert.equal(await e.message({ type: 'CHAT_READY' }, { id: e.chrome.runtime.id, tab: { id: 2 }, url: 'https://example.com' }), undefined);
  assert.equal(e.logs.length, 0);
});
test('upgrade closes only the tracked inactive Usage tab, preserving foreground and repurposed tabs', async () => {
  for (const mode of ['owned', 'foreground', 'repurposed']) {
    const e = environment(); e.tabs.set(2, { id: 2, url: mode === 'repurposed' ? 'https://chatgpt.com/c/preserved' : 'https://chatgpt.com/settings/usage', active: mode === 'foreground' });
    e.session.reader = { tabId: 2 }; e.chrome.runtime.onInstalled.emit({ reason: 'update' }); await drain();
    assert.equal(e.tabs.has(2), mode !== 'owned', mode);
    assert.equal(e.logs.some(row => row[0] === 'create'), false);
  }
});
test('only the explicit settings button creates a tab', async () => {
  const e = environment(); await e.message({ type: 'REFRESH_USAGE' });
  assert.equal(e.logs.some(row => row[0] === 'create'), false);
  await e.message({ type: 'OPEN_USAGE' }); assert.equal(e.logs.filter(row => row[0] === 'create').length, 1);
});
