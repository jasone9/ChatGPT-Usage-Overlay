/* The page itself handles authentication. This worker never reads cookies or tokens. */
importScripts('usage.js', 'config.js');
(() => {
  'use strict';
  const U = globalThis.UsageUnderChat, C = globalThis.UsageReaderConfig;
  const POLL = 'usage-reader-poll', TIMEOUT = 'usage-reader-timeout';
  let pending = null;
  const load = async () => (await chrome.storage.session.get('reader')).reader || {};
  const save = reader => chrome.storage.session.set({ reader });
  async function status(state, detail) {
    await chrome.storage.local.set({ readerStatus: { state, detail, changedAt: Date.now() } });
  }
  async function tabById(id) {
    if (!Number.isInteger(id)) return null;
    try { return await chrome.tabs.get(id); } catch { return null; }
  }
  async function arm() {
    if (!await chrome.alarms.get(POLL)) await chrome.alarms.create(POLL, { periodInMinutes: 1 });
  }
  async function fail(reader) {
    reader.deadline = 0;
    reader.failures = (reader.failures || 0) + 1;
    // Try known UI routes in order, with increasing delays; never rapidly reload a failed page.
    reader.routeIndex = ((reader.routeIndex || 0) + 1) % C.usageURLs.length;
    reader.nextAt = Date.now() + Math.min(30, 2 ** Math.min(reader.failures, 5)) * 60000;
    await save(reader);
    await status('error', 'Could not read Usage yet. Sign in to ChatGPT, or open the reader tab to check it. Retrying automatically.');
  }
  async function refreshImpl(force = false) {
    await arm();
    const prefs = await chrome.storage.local.get(['autoEnabled']);
    if (prefs.autoEnabled === false) { await status('paused', 'Automatic reading is paused.'); return { ok: false, paused: true }; }
    const reader = await load();
    const now = Date.now();
    if (reader.deadline && reader.deadline <= now) { await fail(reader); return { ok: false }; }
    if (reader.deadline > now) return { ok: true, reading: true };
    if (reader.attemptAt && now - reader.attemptAt < C.cooldownMs) return { ok: true, waiting: true };
    if (!force && reader.nextAt > now) return { ok: true, waiting: true };
    const chats = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
    if (!chats.some(tab => tab.id !== reader.tabId && !tab.incognito)) {
      await status('idle', 'Waiting for an open ChatGPT chat.'); return { ok: true, idle: true };
    }
    let tab = await tabById(reader.tabId);
    if (tab?.incognito) tab = null;
    const untouchedRedirect = tab && !reader.hasRead && !tab.active && tab.url === 'https://chatgpt.com/';
    if (tab && !C.isUsageURL(tab.url || tab.pendingUrl) && !untouchedRedirect) {
      // The user may have navigated this tab elsewhere. Relinquish it, never overwrite it.
      tab = null; reader.tabId = null;
    }
    // Do not reload a Usage tab the user is currently interacting with.
    if (tab?.active) {
      try { await chrome.tabs.sendMessage(tab.id, { type: 'READ_USAGE_NOW' }); } catch { /* May be loading. */ }
      return { ok: true, viewing: true };
    }
    reader.attemptAt = now;
    reader.deadline = now + C.timeoutMs;
    reader.routeIndex ||= 0;
    reader.targetURL = C.usageURLs[reader.routeIndex];
    await save(reader);
    await status('reading', 'Reading Usage in the background…');
    try {
      if (tab) {
        // A query/route change after a failed read is deliberate, but only in our own Usage tab.
        if (tab.url !== reader.targetURL) await chrome.tabs.update(tab.id, { url: reader.targetURL });
        else await chrome.tabs.reload(tab.id);
      } else {
        tab = await chrome.tabs.create({ url: reader.targetURL, active: false });
        reader.tabId = tab.id;
        await save(reader);
      }
      await chrome.alarms.create(TIMEOUT, { when: reader.deadline });
      return { ok: true, reading: true };
    } catch {
      await fail(reader); return { ok: false };
    }
  }
  function refresh(force = false) {
    if (pending) return pending;
    pending = refreshImpl(force).catch(async () => {
      await status('error', 'Could not start the Usage reader. Try Refresh now.'); return { ok: false };
    }).finally(() => { pending = null; });
    return pending;
  }
  async function acceptReading(message, sender) {
    if (!sender.tab || sender.tab.incognito || !C.isChatGPT(sender.url)) return { ok: false };
    const prefs = await chrome.storage.local.get('autoEnabled');
    if (prefs.autoEnabled === false) return { ok: false };
    const reader = await load();
    const automatic = sender.tab.id === reader.tabId;
    if (automatic && !C.isUsageURL(sender.url)) return { ok: false };
    const normalized = U.valid(U.snapshot(message.windows, automatic ? 'automatic-reader' : 'visible-settings'));
    if (!normalized) return { ok: false };
    // Explicitly pick fields so no arbitrary message metadata or page text is stored.
    const snapshot = U.snapshot(normalized.windows, automatic ? 'automatic-reader' : 'visible-settings');
    await chrome.storage.local.set({ usageSnapshot: snapshot });
    if (automatic) {
      const current = await tabById(reader.tabId);
      if (current && C.isUsageURL(current.url)) {
        // Remember which of the known UI routes worked for this browser session.
        const index = C.usageURLs.findIndex(value => value === current.url);
        if (index >= 0) reader.routeIndex = index;
      }
      reader.deadline = 0; reader.failures = 0; reader.hasRead = true; reader.nextAt = Date.now() + C.refreshMs;
      await save(reader);
      await chrome.alarms.clear(TIMEOUT);
    }
    await status('ready', 'Automatic reader on · checks about every 2 minutes.');
    return { ok: true };
  }
  async function openReader() {
    const reader = await load();
    const tab = await tabById(reader.tabId);
    if (tab && C.isUsageURL(tab.url)) {
      await chrome.tabs.update(tab.id, { active: true });
      if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
    } else {
      // User-requested diagnostic tab; it is never silently adopted for automatic reloads.
      await chrome.tabs.create({ url: C.usageURLs[0], active: true });
    }
    return { ok: true };
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    const fromPage = sender.tab && C.isChatGPT(sender.url);
    const fromPopup = !sender.tab && sender.url?.startsWith(chrome.runtime.getURL(''));
    let action;
    if (message?.type === 'USAGE_READING' && fromPage) action = acceptReading(message, sender);
    else if (message?.type === 'CHAT_READY' && fromPage) action = refresh();
    else if (message?.type === 'REFRESH_USAGE' && (fromPage || fromPopup)) action = refresh(true);
    else if (message?.type === 'OPEN_READER' && (fromPage || fromPopup)) action = openReader();
    else return;
    action.then(respond).catch(() => respond({ ok: false }));
    return true;
  });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === POLL || alarm.name === TIMEOUT) void refresh();
  });
  chrome.runtime.onInstalled.addListener(() => {
    // Do not display a pasted/previous-version value as an automatic reading.
    void chrome.storage.local.remove(['usageSnapshot', 'readerStatus']).then(() => refresh());
  });
  chrome.runtime.onStartup.addListener(() => { void refresh(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.autoEnabled) return;
    if (changes.autoEnabled.newValue === false) void status('paused', 'Automatic reading is paused.');
    else void refresh(true);
  });
  // Alarms can disappear on restart or extension reload. Restore them on every worker start.
  void arm();
})();
