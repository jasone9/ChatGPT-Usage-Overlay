/* Schedules a small read inside an existing ChatGPT tab; no automatic tabs or page reloads. */
importScripts('usage.js', 'config.js');
(() => {
  'use strict';
  const U = globalThis.UsageUnderChat, C = globalThis.UsageReaderConfig;
  const POLL = 'usage-reader-poll';
  let pending = null;
  const load = async () => (await chrome.storage.session.get('reader')).reader || {};
  const save = reader => chrome.storage.session.set({ reader });
  const status = (state, detail) => chrome.storage.local.set({ readerStatus: { state, detail, changedAt: Date.now() } });
  async function arm() {
    if (!await chrome.alarms.get(POLL)) await chrome.alarms.create(POLL, { periodInMinutes: 1 });
  }
  async function fail(reader, result) {
    const code = result?.code;
    const scopeKey = typeof result?.scopeKey === 'string' && /^[a-f0-9]{64}$/.test(result.scopeKey) ? result.scopeKey : null;
    if (['sign-in', 'blocked', 'account-mismatch'].includes(code) || (scopeKey && reader.scopeKey && scopeKey !== reader.scopeKey)) await chrome.storage.local.remove('usageSnapshot');
    reader.deadline = 0; reader.failures = (reader.failures || 0) + 1;
    const backoff = Math.min(30, 2 ** Math.min(reader.failures, 5)) * 60000;
    const retryAfter = Number.isFinite(result?.retryAfter) ? Math.min(1800, Math.max(0, result.retryAfter)) * 1000 : 0;
    reader.nextAt = Date.now() + Math.max(backoff, retryAfter);
    if (code === 'no-reader') { reader.attemptAt = 0; reader.nextAt = 0; reader.failures = 0; }
    if (scopeKey) reader.scopeKey = scopeKey;
    await save(reader);
    const messages = {
      'sign-in': 'Sign in to ChatGPT in your chat tab, then choose Refresh.',
      blocked: 'ChatGPT blocked this usage request. Open ChatGPT normally and try again later.',
      'rate-limited': 'ChatGPT asked us to slow down. Usage will retry automatically.',
      unsupported: 'ChatGPT returned an unrecognized usage response. Try Refresh, or check Usage settings.',
      'account-mismatch': 'The returned account did not match your session. Refresh your ChatGPT tab before trying again.',
      'no-reader': 'Refresh your ChatGPT tab to connect the updated extension.'
    };
    await status('error', messages[code] || 'Could not read usage. Retrying automatically; the last successful read may be outdated.');
    return { ok: false };
  }
  async function refreshImpl(force = false) {
    await arm();
    if ((await chrome.storage.local.get('autoEnabled')).autoEnabled === false) { await status('paused', 'Automatic reading is paused.'); return { ok: false, paused: true }; }
    const reader = await load(), now = Date.now();
    if (reader.deadline && reader.deadline <= now) return fail(reader, { code: 'timeout' });
    if (reader.deadline > now) return { ok: true, reading: true };
    if (reader.attemptAt && now - reader.attemptAt < C.cooldownMs) return { ok: true, waiting: true };
    // Backoff also applies to repeated manual clicks after a failed request.
    if (reader.nextAt > now && (!force || reader.failures)) return { ok: true, waiting: true };
    const tabs = (await chrome.tabs.query({ url: 'https://chatgpt.com/*' }))
      .filter(tab => !tab.incognito && !tab.discarded && C.isChatGPT(tab.url))
      .sort((a, b) => Number(b.active) - Number(a.active));
    if (!tabs.length) { await status('idle', 'Open a ChatGPT chat to read usage.'); return { ok: true, idle: true }; }
    reader.attemptAt = now; reader.deadline = now + C.timeoutMs;
    await save(reader);
    await status('reading', 'Checking usage through your current ChatGPT tab…');
    let result = null;
    for (const tab of tabs.slice(0, 3)) {
      try { result = await chrome.tabs.sendMessage(tab.id, { type: 'FETCH_DIRECT_USAGE' }); break; }
      catch { /* A pre-update tab may not have a content-script listener. */ }
    }
    if ((await chrome.storage.local.get('autoEnabled')).autoEnabled === false) {
      reader.deadline = 0; await save(reader);
      await status('paused', 'Automatic reading is paused.'); return { ok: false, paused: true };
    }
    if (!result?.ok) return fail(reader, result || { code: 'no-reader' });
    const normalized = U.valid(U.snapshot(result.windows, 'direct-session'));
    if (!normalized) return fail(reader, { code: 'unsupported' });
    const scopeKey = typeof result.scopeKey === 'string' && /^[a-f0-9]{64}$/.test(result.scopeKey) ? result.scopeKey : null;
    await chrome.storage.local.set({ usageSnapshot: U.snapshot(normalized.windows, 'direct-session') });
    reader.deadline = 0; reader.failures = 0; reader.nextAt = Date.now() + C.refreshMs;
    if (scopeKey) reader.scopeKey = scopeKey;
    await save(reader);
    await status('ready', 'Automatic usage checks about every 2 minutes · no extra tab.');
    return { ok: true };
  }
  function refresh(force = false) {
    if (!pending) pending = refreshImpl(force).catch(() => status('error', 'Could not check usage. Refresh your ChatGPT tab and try again.').then(() => ({ ok: false }))).finally(() => { pending = null; });
    return pending;
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    const fromPage = sender.tab && !sender.tab.incognito && C.isChatGPT(sender.url);
    const fromPopup = !sender.tab && sender.url?.startsWith(chrome.runtime.getURL(''));
    let action;
    if (message?.type === 'CHAT_READY' && fromPage) action = refresh();
    else if (message?.type === 'REFRESH_USAGE' && (fromPage || fromPopup)) action = refresh(true);
    else if (message?.type === 'OPEN_USAGE' && (fromPage || fromPopup)) {
      // Only this explicit user action opens a tab. Automatic checks never do.
      action = chrome.tabs.create({ url: C.usageURLs[0], active: true }).then(() => ({ ok: true }));
    } else return;
    action.then(respond).catch(() => respond({ ok: false })); return true;
  });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === POLL) void refresh(); });
  chrome.runtime.onInstalled.addListener(() => {
    void (async () => {
      const old = await load();
      // Remove only the tracked, inactive Usage tab created by an older extension version.
      if (Number.isInteger(old.tabId)) {
        try { const tab = await chrome.tabs.get(old.tabId); if (!tab.active && C.isUsageURL(tab.url)) await chrome.tabs.remove(tab.id); } catch {}
      }
      await chrome.storage.session.remove('reader');
      await chrome.storage.local.remove(['usageSnapshot', 'readerStatus']);
      await chrome.alarms.clear('usage-reader-timeout');
      await refresh();
    })();
  });
  chrome.runtime.onStartup.addListener(() => { void refresh(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.autoEnabled) return;
    if (changes.autoEnabled.newValue === false) void status('paused', 'Automatic reading is paused.');
    else void refresh(true);
  });
  void arm();
})();
