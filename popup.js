(() => {
  'use strict';
  const U = globalThis.UsageUnderChat;
  const $ = id => document.getElementById(id);
  function status(text) { $('status').textContent = text; }
  async function render() {
    try {
      const data = await chrome.storage.local.get(['usageSnapshot', 'overlayEnabled', 'autoEnabled', 'readerStatus']);
      const reading = U.valid(data.usageSnapshot);
      $('enabled').checked = data.overlayEnabled !== false;
      $('automatic').checked = data.autoEnabled !== false;
      $('summary').replaceChildren();
      if (!reading) {
        const p = document.createElement('p'); p.textContent = 'Waiting for the first automatic read…';
        $('summary').append(p); $('captured').textContent = '';
      } else {
        for (const [key, label] of [['fiveHour', '5-hour allowance'], ['weekly', 'Weekly allowance']]) {
          const item = reading.windows[key]; if (!item) continue;
          const allowance = document.createElement('div'); allowance.className = 'allowance';
          const row = document.createElement('div'); row.className = 'row';
          const text = document.createElement('div'); text.textContent = label;
          if (item.reset) { const reset = document.createElement('div'); reset.className = 'reset'; reset.textContent = `Resets ${item.reset}`; text.append(reset); }
          const value = document.createElement('strong'); value.textContent = `${item.remaining}%`;
          const level = item.remaining <= 10 ? 'low' : item.remaining <= 25 ? 'warn' : '';
          if (level) value.className = level;
          const progress = document.createElement('progress'); progress.className = `allowance-bar ${level}`.trim();
          progress.max = 100; progress.value = item.remaining;
          progress.setAttribute('aria-label', `${label} remaining`);
          progress.setAttribute('aria-valuetext', `${item.remaining}% remaining`);
          progress.textContent = `${item.remaining}%`;
          row.append(text, value); allowance.append(row, progress); $('summary').append(allowance);
        }
        $('captured').textContent = `Last read ${U.age(reading.capturedAt)} · ${new Date(reading.capturedAt).toLocaleString()}`;
      }
      status(data.readerStatus?.detail || 'Open a ChatGPT chat to start the automatic reader.');
    } catch { status('Reload the extension and try again.'); }
  }
  $('refresh').addEventListener('click', async () => {
    $('refresh').disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'REFRESH_USAGE' });
      if (result?.paused) status('Turn on Read Usage automatically first.');
      else if (result?.waiting) status('A check was requested recently. The automatic reader will update shortly.');
      else if (result?.idle) status('Open a ChatGPT chat first.');
      else if (!result?.ok) await render();
    } catch { status('Reload the extension and try again.'); }
    finally { $('refresh').disabled = false; }
  });
  $('open').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_USAGE' }).catch(() => status('Could not open Usage settings.'));
  });
  for (const [id, key] of [['enabled', 'overlayEnabled'], ['automatic', 'autoEnabled']]) {
    $(id).addEventListener('change', async () => {
      try { await chrome.storage.local.set({ [key]: $(id).checked }); }
      catch { status('Could not save that setting.'); }
    });
  }
  chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'local') void render(); });
  void render();
})();
