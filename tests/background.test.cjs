'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../config.js');
const event = () => {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)), listeners };
};
const drain = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
function environment(options = {}) {
  let now = 1800000000000;
  const local = {}, session = {}, logs = [], alarms = new Map();
  const tabs = new Map(options.noChats ? [] : [[1, { id: 1, windowId: 1, url: 'https://chatgpt.com/c/test', active: true, incognito: false }]]);
  const changed = event();
  function storage(data, area) {
    return {
      get: async keys => Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter(key => key in data).map(key => [key, structuredClone(data[key])])),
      set: async values => {
        const updates = {};
        for (const [key, value] of Object.entries(values)) { updates[key] = { oldValue: data[key], newValue: structuredClone(value) }; data[key] = structuredClone(value); }
        queueMicrotask(() => changed.emit(updates, area));
      },
      remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
    };
  }
  const chrome = {
    runtime: { id: 'test-extension', getURL: value => `chrome-extension://test-extension/${value}`, onMessage: event(), onInstalled: event(), onStartup: event() },
    storage: { local: storage(local, 'local'), session: storage(session, 'session'), onChanged: changed },
    alarms: { get: async name => alarms.get(name), create: async (name, value) => alarms.set(name, value), clear: async name => alarms.delete(name), onAlarm: event() },
    tabs: {
      query: async () => [...tabs.values()].filter(tab => C.isChatGPT(tab.url)).map(tab => structuredClone(tab)),
      get: async id => { if (!tabs.has(id)) throw Error('No tab'); return structuredClone(tabs.get(id)); },
      create: async props => { const id = Math.max(1, ...tabs.keys()) + 1; const tab = { id, windowId: 1, incognito: false, ...props }; tabs.set(id, tab); logs.push(['create', id, props]); return structuredClone(tab); },
      update: async (id, props) => { Object.assign(tabs.get(id), props); logs.push(['update', id, props]); return structuredClone(tabs.get(id)); },
      reload: async id => { logs.push(['reload', id]); },
      sendMessage: async (id, message) => { logs.push(['send', id, message]); return { ok: true }; }
    },
    windows: { update: async (id, props) => logs.push(['window', id, props]) }
  };
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ chrome, URL, Date: Clock, console });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), context);
  const pageSender = (id = 1) => ({ id: chrome.runtime.id, tab: structuredClone(tabs.get(id)), url: tabs.get(id)?.url });
  const popupSender = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') };
  async function message(value, sender = popupSender) {
    const handler = chrome.runtime.onMessage.listeners[0];
    return new Promise(resolve => { if (handler(value, sender, resolve) !== true) resolve(undefined); });
  }
  async function poll() { chrome.alarms.onAlarm.emit({ name: 'usage-reader-poll' }); await drain(); }
  return { local, session, tabs, logs, chrome, alarms, message, pageSender, poll, advance: ms => { now += ms; }, now: () => now };
}
const reading = { fiveHour: { remaining: 94, reset: '6:25 PM' }, weekly: { remaining: 99, reset: 'Nov 9, 2026, 1:25 PM' } };

test('starts one inactive reader automatically and coalesces duplicate requests', async () => {
  const e = environment();
  await Promise.all([e.message({ type: 'CHAT_READY' }, e.pageSender()), e.message({ type: 'CHAT_READY' }, e.pageSender())]);
  assert.equal(e.logs.filter(row => row[0] === 'create').length, 1);
  const tab = e.tabs.get(e.session.reader.tabId);
  assert.equal(tab.active, false);
  assert.equal(tab.url, 'https://chatgpt.com/settings/usage');
  assert.equal(e.tabs.get(1).active, true);
  assert.ok(e.alarms.has('usage-reader-timeout'));
});
test('records real values, sanitizes metadata, and schedules the next automatic read', async () => {
  const e = environment();
  await e.message({ type: 'CHAT_READY' }, e.pageSender());
  const result = await e.message({ type: 'USAGE_READING', windows: { ...reading, rawText: 'must not persist' } }, e.pageSender(e.session.reader.tabId));
  assert.equal(result.ok, true);
  assert.deepEqual(e.local.usageSnapshot.windows, reading);
  assert.equal(e.local.usageSnapshot.source, 'automatic-reader');
  assert.equal(e.local.readerStatus.state, 'ready');
  assert.equal(e.session.reader.deadline, 0);
  assert.equal(e.session.reader.nextAt, e.now() + 120000);
  assert.equal(e.alarms.has('usage-reader-timeout'), false);
});
test('reloads only its reader tab when the next read is due', async () => {
  const e = environment();
  await e.message({ type: 'CHAT_READY' }, e.pageSender());
  const id = e.session.reader.tabId;
  await e.message({ type: 'USAGE_READING', windows: reading }, e.pageSender(id));
  await e.poll();
  assert.equal(e.logs.filter(row => row[0] === 'reload').length, 0);
  e.advance(120001);
  await e.poll();
  assert.deepEqual(e.logs.filter(row => row[0] === 'reload'), [['reload', id]]);
  assert.equal(e.logs.filter(row => row[0] === 'create').length, 1);
});
test('rate-limits manual Refresh requests', async () => {
  const e = environment();
  await e.message({ type: 'CHAT_READY' }, e.pageSender());
  await e.message({ type: 'USAGE_READING', windows: reading }, e.pageSender(e.session.reader.tabId));
  const result = await e.message({ type: 'REFRESH_USAGE' });
  assert.equal(result.waiting, true);
  assert.equal(e.logs.filter(row => row[0] === 'reload').length, 0);
});
test('timeouts preserve the last good values and back off before trying another route', async () => {
  const e = environment();
  await e.message({ type: 'CHAT_READY' }, e.pageSender());
  e.local.usageSnapshot = { old: 'last good read' };
  e.advance(30001); await e.poll();
  assert.equal(e.local.readerStatus.state, 'error');
  assert.equal(e.session.reader.routeIndex, 1);
  assert.equal(e.session.reader.nextAt, e.now() + 120000);
  assert.deepEqual(e.local.usageSnapshot, { old: 'last good read' });
  await e.poll();
  assert.equal(e.logs.filter(row => row[0] === 'reload' || row[0] === 'update').length, 0);
  e.advance(120001); await e.poll();
  assert.equal(e.logs.find(row => row[0] === 'update')[2].url, 'https://chatgpt.com/#settings/Usage');
});
test('a redirect to the home page retries in the same owned tab', async () => {
  const e = environment(); await e.message({ type: 'CHAT_READY' }, e.pageSender());
  const id = e.session.reader.tabId;
  e.tabs.get(id).url = 'https://chatgpt.com/';
  e.advance(30001); await e.poll(); e.advance(120001); await e.poll();
  assert.equal(e.logs.filter(row => row[0] === 'create').length, 1);
  assert.equal(e.tabs.get(id).url, 'https://chatgpt.com/#settings/Usage');
});
test('pausing prevents both navigation and accepting new readings', async () => {
  const e = environment(); e.local.autoEnabled = false;
  assert.equal((await e.message({ type: 'REFRESH_USAGE' })).paused, true);
  assert.equal(e.logs.length, 0);
  assert.equal((await e.message({ type: 'USAGE_READING', windows: reading }, e.pageSender())).ok, false);
  assert.equal(e.local.usageSnapshot, undefined);
});
test('does not open reader tabs when no chat is open', async () => {
  const e = environment({ noChats: true });
  assert.equal((await e.message({ type: 'REFRESH_USAGE' })).idle, true);
  assert.equal(e.logs.length, 0);
});
test('does not reload a foreground Usage tab', async () => {
  const e = environment(); await e.message({ type: 'CHAT_READY' }, e.pageSender());
  const id = e.session.reader.tabId;
  await e.message({ type: 'USAGE_READING', windows: reading }, e.pageSender(id));
  e.tabs.get(id).active = true; e.advance(120001); await e.poll();
  assert.equal(e.logs.some(row => row[0] === 'reload'), false);
  assert.equal(e.logs.some(row => row[0] === 'send' && row[1] === id), true);
});
test('never reloads an original user tab or an owned tab repurposed as a conversation', async () => {
  const e = environment(); await e.message({ type: 'CHAT_READY' }, e.pageSender());
  const id = e.session.reader.tabId;
  await e.message({ type: 'USAGE_READING', windows: reading }, e.pageSender(id));
  e.tabs.get(id).url = 'https://chatgpt.com/c/new-user-chat';
  e.advance(120001); await e.poll();
  assert.equal(e.tabs.get(id).url, 'https://chatgpt.com/c/new-user-chat');
  assert.equal(e.logs.some(row => ['update', 'reload'].includes(row[0]) && [1, id].includes(row[1])), false);
});
test('rejects untrusted origins, invalid readings, and incognito sources', async () => {
  const e = environment();
  assert.equal(await e.message({ type: 'USAGE_READING', windows: reading }, { id: e.chrome.runtime.id, tab: { id: 8 }, url: 'https://example.com' }), undefined);
  assert.equal((await e.message({ type: 'USAGE_READING', windows: { weekly: { remaining: 101 } } }, e.pageSender())).ok, false);
  const sender = e.pageSender(); sender.tab.incognito = true;
  assert.equal((await e.message({ type: 'USAGE_READING', windows: reading }, sender)).ok, false);
  assert.equal(e.local.usageSnapshot, undefined);
});
test('URL checks accept current Settings and Usage hashes, reject unrelated paths', () => {
  for (const url of C.usageURLs) assert.equal(C.isUsageURL(url), true);
  for (const url of ['https://evil.example/settings/usage', 'https://chatgpt.com/c/usage', 'https://chatgpt.com/', 'not a url']) assert.equal(C.isUsageURL(url), false);
});
