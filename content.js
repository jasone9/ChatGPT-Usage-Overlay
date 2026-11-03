(() => {
  'use strict';
  if (globalThis.__usageUnderChatLoaded) return;
  globalThis.__usageUnderChatLoaded = true;
  const U = globalThis.UsageUnderChat;
  const C = globalThis.UsageReaderConfig;
  const HOST_ID = 'usage-under-chat-extension';
  const EXCLUDE = 'article, [data-message-author-role], [data-testid*="conversation-turn"], pre, code, nav, aside, [contenteditable="true"], textarea';
  let saved = null, enabled = true, autoEnabled = true, readerStatus = null, host = null, root = null;
  let previousPanel = null, previousValues = '', timer = null, stopped = false, saving = false;
  let helpOpen = false, lastRender = '', announced = false;

  function visible(element) {
    if (!element || !element.isConnected || element.closest('[hidden], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  }
  function safeSettingsText(panel) {
    let size = 0;
    function read(node) {
      if (size > 24000) return '';
      if (node.nodeType === Node.TEXT_NODE) { size += node.textContent.length; return node.textContent; }
      if (node.nodeType !== Node.ELEMENT_NODE || !visible(node) || node.matches(`${EXCLUDE},script,style,#${HOST_ID}`)) return '';
      const block = /^(DIV|SECTION|P|H[1-6]|LI|BR)$/.test(node.tagName);
      return `${block ? '\n' : ''}${[...node.childNodes].map(read).join('')}${block ? '\n' : ''}`;
    }
    return read(panel).slice(0, 24001);
  }
  function usagePanel() {
    // Never scan chat messages for percentages. Only Settings dialogs or explicit usage routes.
    const candidates = [...document.querySelectorAll('[role="dialog"], dialog, [role="tabpanel"]')];
    if (C.isUsageURL(location.href)) {
      candidates.push(document.querySelector('main'), document.body);
    }
    for (const panel of candidates) {
      if (!visible(panel) || panel.closest(EXCLUDE)) continue;
      const title = [...panel.querySelectorAll('h1,h2,h3,[role="heading"],[role="tab"][aria-selected="true"]')]
        .some(el => visible(el) && !el.closest(EXCLUDE) && /^(usage(?:\s*(?:&|and)\s*billing)?|general usage limits)$/i.test(el.textContent.trim()));
      if (!title) continue;
      const windows = U.parse(safeSettingsText(panel));
      if (windows) return { panel, windows };
    }
    return null;
  }
  async function capture(force = false) {
    if (saving) return false;
    const found = usagePanel();
    if (!found) { previousPanel = null; previousValues = ''; return false; }
    const fingerprint = JSON.stringify(found.windows);
    if (!force && previousPanel === found.panel && previousValues === fingerprint) return true;
    saving = true;
    try {
      if (!autoEnabled) return false;
      const result = await chrome.runtime.sendMessage({ type: 'USAGE_READING', windows: found.windows });
      if (!result?.ok) return false;
      previousPanel = found.panel;
      previousValues = fingerprint;
      render();
      return true;
    } catch { return false; }
    finally { saving = false; }
  }
  function composerAnchor() {
    const editors = document.querySelectorAll('#prompt-textarea, [contenteditable="true"][role="textbox"], [data-slate-editor="true"], [data-lexical-editor="true"], textarea[placeholder]');
    for (const editor of editors) {
      if (!visible(editor) || editor.closest('[role="dialog"], dialog, nav, aside, article, [data-message-author-role]')) continue;
      const form = editor.closest('form');
      if (form) return form;
      const composer = editor.closest('[data-testid="composer"], #composer-background');
      if (composer) return composer;
      // A small editor container near the bottom, for Work composer variants without a form.
      if (editor.getBoundingClientRect().top < innerHeight * 0.5) continue;
      let anchor = editor.parentElement;
      for (let n = 0; n < 3 && anchor?.parentElement; n++) {
        const parent = anchor.parentElement;
        if (parent === document.body || parent.tagName === 'MAIN' || parent.getBoundingClientRect().height > 220 || parent.contains(host)) break;
        anchor = parent;
      }
      return anchor;
    }
    return null;
  }
  function makeUI() {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'display:block!important;position:relative!important;flex:0 0 auto!important;grid-column:1 / -1!important;width:100%!important;max-width:100%!important;min-width:0!important;box-sizing:border-box!important;z-index:10!important;';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host { color-scheme:light dark; font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
      * { box-sizing:border-box; } [hidden] { display:none!important; }
      .wrap { padding:6px 8px 3px; color:#647168; text-align:center; }
      .bar { display:flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:5px 11px; min-height:24px; }
      .brand { display:inline-flex; align-items:center; gap:5px; font-weight:600; }
      .dot { width:6px; height:6px; border-radius:50%; background:#819087; }
      .metric { display:inline-flex; gap:5px; align-items:center; white-space:nowrap; }
      .allowance-bar { --fill:#15664d; --track:#dbe5de; appearance:none; width:56px; height:6px; flex:none; border:0; border-radius:999px; overflow:hidden; background:var(--track); accent-color:var(--fill); }
      .allowance-bar.warn { --fill:#98620c; } .allowance-bar.low { --fill:#ba3f3f; }
      .allowance-bar::-webkit-progress-bar { background:var(--track); border-radius:999px; }
      .allowance-bar::-webkit-progress-value { background:var(--fill); border-radius:999px; }
      .allowance-bar::-moz-progress-bar { background:var(--fill); border-radius:999px; }
      strong { color:#15664d; font-weight:650; font-variant-numeric:tabular-nums; }
      .warn { color:#98620c; } .low { color:#ba3f3f; }
      .reset { font-size:11px; opacity:.85; }
      button { font:inherit; color:inherit; border:0; background:transparent; cursor:pointer; border-radius:5px; padding:3px 5px; }
      button:hover { background:rgba(128,128,128,.12); } button:focus-visible { outline:2px solid #2d9679; outline-offset:2px; }
      .age { opacity:.85; font-size:11px; } .stale { color:#98620c; }
      .help { max-width:540px; margin:6px auto; padding:12px 14px; border:1px solid #d4dcd7; border-radius:12px; background:#f7faf8; text-align:left; color:#45584c; box-shadow:0 4px 16px #00000008; }
      .help p { margin:0 0 8px; } .help p:last-child { margin-bottom:0; } .help b { font-weight:650; }
      @media (prefers-color-scheme:dark) { .wrap { color:#a6b4ab; } strong { color:#80d2b3; } .warn,.stale { color:#e4b96a; } .low { color:#ff9999; } .help { background:#232b26; border-color:#3a483e; color:#c2d0c7; } .allowance-bar { --fill:#80d2b3; --track:#3a483e; } .allowance-bar.warn { --fill:#e4b96a; } .allowance-bar.low { --fill:#ff9999; } }
      @media (max-width:520px) { .reset { display:none; } .bar { gap:3px 8px; } .allowance-bar { width:40px; } }
    </style><div class="wrap"><div class="bar" aria-label="ChatGPT usage, read automatically">
      <span class="brand"><span class="dot" aria-hidden="true"></span>Usage</span>
      <span id="metrics" style="display:contents"></span>
      <span id="age" class="age"></span>
      <button id="refresh" type="button">Refresh</button>
      <button id="update" type="button" aria-expanded="false" aria-controls="help">Info</button>
    </div><div id="help" class="help" hidden>
      <p><b>Your Usage is read automatically</b></p>
      <p>A Usage tab stays open in the background and is checked about every 2 minutes while a ChatGPT tab is open. The time shows the last successful read; changes can take a little while to appear.</p>
      <p>No screenshots or copying needed. If numbers don’t appear, click the extension icon and choose Open Usage reader to check whether it needs you to sign in.</p>
      <p>The numbers belong to the account and workspace selected in that Usage tab.</p>
    </div></div>`;
    root.getElementById('refresh').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'REFRESH_USAGE' }).catch(() => {});
    });
    root.getElementById('update').addEventListener('click', () => {
      helpOpen = !helpOpen;
      render();
    });
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && helpOpen) { helpOpen = false; render(); root.getElementById('update').focus(); }
    });
  }
  function render() {
    if (!root) return;
    const snapshot = U.valid(saved);
    const age = snapshot ? U.age(snapshot.capturedAt) : '';
    const stale = snapshot && Date.now() - snapshot.capturedAt >= 5 * 60000;
    const signature = JSON.stringify([snapshot, age, stale, helpOpen, readerStatus, autoEnabled]);
    if (lastRender === signature) return;
    lastRender = signature;
    const metrics = root.getElementById('metrics');
    metrics.replaceChildren();
    for (const [key, label] of [['fiveHour', '5h'], ['weekly', 'Weekly']]) {
      const item = snapshot?.windows[key];
      if (!item) continue;
      const span = document.createElement('span'); span.className = 'metric';
      const name = document.createElement('span'); name.textContent = label;
      const value = document.createElement('strong'); value.textContent = `${item.remaining}% left`;
      if (item.remaining <= 10) value.className = 'low'; else if (item.remaining <= 25) value.className = 'warn';
      const progress = document.createElement('progress');
      progress.className = `allowance-bar ${value.className}`.trim();
      progress.max = 100; progress.value = item.remaining;
      progress.setAttribute('aria-label', `${key === 'fiveHour' ? '5-hour' : 'Weekly'} allowance remaining`);
      progress.setAttribute('aria-valuetext', `${item.remaining}% remaining`);
      progress.textContent = `${item.remaining}%`;
      span.append(name, progress, value);
      if (item.reset) {
        const reset = document.createElement('span'); reset.className = 'reset'; reset.textContent = `↻ ${item.reset}`;
        span.title = `Reset shown at capture: ${item.reset}`; span.append(reset);
      }
      metrics.append(span);
    }
    const status = root.getElementById('age');
    const state = !autoEnabled ? 'Paused' : readerStatus?.state === 'reading' ? 'Checking…' : readerStatus?.state === 'error' ? 'Reader needs attention' : 'Auto';
    status.textContent = snapshot ? `${state} · read ${age}${stale ? ' · may be outdated' : ''}` : readerStatus?.detail || 'Starting automatic reader…';
    status.className = `age${stale ? ' stale' : ''}`;
    status.title = snapshot ? `Last read ${new Date(snapshot.capturedAt).toLocaleString()}. Reset labels are copied from Usage. ${readerStatus?.detail || ''}` : readerStatus?.detail || 'Usage is read automatically in a background tab.';
    const update = root.getElementById('update');
    update.textContent = helpOpen ? 'Close' : 'Info';
    update.setAttribute('aria-expanded', String(helpOpen));
    root.getElementById('help').hidden = !helpOpen;
  }
  function mount() {
    if (!enabled) { host?.remove(); return; }
    const anchor = composerAnchor();
    if (!anchor?.parentElement) { host?.remove(); return; }
    if (!host) makeUI();
    if (anchor.nextElementSibling !== host) anchor.after(host);
    if (!announced) {
      announced = true;
      chrome.runtime.sendMessage({ type: 'CHAT_READY' }).catch(() => { announced = false; });
    }
    render();
  }
  async function tick() {
    timer = null;
    if (stopped) return;
    try { mount(); await capture(); }
    catch { /* Replaced DOM nodes are retried on the next mutation. */ }
  }
  function schedule() {
    if (!timer && !stopped) timer = setTimeout(tick, 350);
  }
  const observer = new MutationObserver(records => {
    if (records.some(record => !host?.contains(record.target) && record.target !== host)) schedule();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.usageSnapshot) saved = changes.usageSnapshot.newValue || null;
    if (changes.overlayEnabled) enabled = changes.overlayEnabled.newValue !== false;
    if (changes.autoEnabled) autoEnabled = changes.autoEnabled.newValue !== false;
    if (changes.readerStatus) readerStatus = changes.readerStatus.newValue || null;
    schedule();
  });
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === 'READER_DIAGNOSTICS') {
      try {
        const panel = document.querySelector('main') || document.body;
        const text = safeSettingsText(panel);
        respond({ usageURL: C.isUsageURL(location.href), headings: panel.querySelectorAll('h1,h2,h3,[role="heading"]').length, size: text.length, parsed: U.parse(text), detected: !!usagePanel() });
      } catch (error) { respond({ error: error.message }); }
      return;
    }
    if (message?.type !== 'READ_USAGE_NOW') return;
    capture(true).then(ok => respond({ ok })).catch(() => respond({ ok: false }));
    return true;
  });
  chrome.storage.local.get(['usageSnapshot', 'overlayEnabled', 'autoEnabled', 'readerStatus']).then(data => {
    saved = data.usageSnapshot || null;
    enabled = data.overlayEnabled !== false;
    autoEnabled = data.autoEnabled !== false;
    readerStatus = data.readerStatus || null;
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'aria-selected'] });
    schedule();
  }).catch(() => { stopped = true; });
  // Update age labels and recover if the app replaces the composer without useful mutations.
  const interval = setInterval(schedule, 15000);
  addEventListener('pageshow', schedule);
  addEventListener('visibilitychange', () => {
    if (!document.hidden && announced) chrome.runtime.sendMessage({ type: 'CHAT_READY' }).catch(() => {});
    schedule();
  });
  addEventListener('pagehide', event => {
    if (event.persisted) return;
    stopped = true; observer.disconnect(); clearInterval(interval); clearTimeout(timer);
  });
})();
