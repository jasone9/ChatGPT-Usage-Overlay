/* Shared parser. Only normalized percentages/reset labels are retained. */
(() => {
  'use strict';
  const MAX_AGE = 24 * 60 * 60 * 1000;
  function parse(text) {
    if (typeof text !== 'string' || text.length > 24000) return null;
    text = text.replace(/\u00a0/g, ' ').replace(/\r/g, '');
    const labels = [...text.matchAll(/\b(?:5\s*[-–]?\s*(?:hours?|hrs?|h)(?:\s+(?:usage\s+)?limit)?|weekly(?:\s+(?:usage\s+)?limit)?|monthly(?:\s+(?:usage\s+)?limit)?|daily(?:\s+(?:usage\s+)?limit)?|code\s+reviews?(?:\s+(?:usage\s+)?limit)?)\b/gi)];
    const windows = {};
    const invalid = new Set();
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      const key = /^5/.test(label[0]) ? 'fiveHour' : /^weekly/i.test(label[0]) ? 'weekly' : null;
      if (!key) continue;
      const section = text.slice(label.index + label[0].length, labels[i + 1]?.index ?? text.length).slice(0, 260);
      const values = [...section.matchAll(/(?<![\d.,−-])(\d{1,3}(?:[.,]\d{1,2})?)\s*%\s*(left|remaining|used)\b/gi)];
      if (values.length !== 1) { invalid.add(key); continue; }
      const amount = Number(values[0][1].replace(',', '.'));
      if (!Number.isFinite(amount) || amount < 0 || amount > 100) { invalid.add(key); continue; }
      const remaining = Math.round((values[0][2].toLowerCase() === 'used' ? 100 - amount : amount) * 10) / 10;
      const reset = section.match(/\bresets?\s*:?\s*([^\n]+)/i)?.[1]?.trim().slice(0, 100) || null;
      const next = { remaining, reset };
      if (windows[key] && JSON.stringify(windows[key]) !== JSON.stringify(next)) invalid.add(key);
      windows[key] = next;
    }
    for (const key of invalid) delete windows[key];
    return Object.keys(windows).length ? windows : null;
  }
  function valid(snapshot, now = Date.now()) {
    if (!snapshot || snapshot.version !== 1 || !Number.isFinite(snapshot.capturedAt)) return null;
    if (snapshot.capturedAt > now + 60000 || now - snapshot.capturedAt >= MAX_AGE) return null;
    if (!['visible-settings', 'pasted-settings', 'automatic-reader', 'direct-session'].includes(snapshot.source)) return null;
    const windows = {};
    for (const key of ['fiveHour', 'weekly']) {
      const item = snapshot.windows?.[key];
      if (!item || !Number.isFinite(item.remaining) || item.remaining < 0 || item.remaining > 100) continue;
      windows[key] = { remaining: item.remaining, reset: typeof item.reset === 'string' ? item.reset.slice(0, 100) : null };
    }
    return Object.keys(windows).length ? { ...snapshot, windows } : null;
  }
  function age(timestamp, now = Date.now()) {
    const minutes = Math.max(0, Math.floor((now - timestamp) / 60000));
    return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
  }
  function snapshot(windows, source) {
    return { version: 1, capturedAt: Date.now(), source, windows };
  }
  function fromAPI(payload, now = Date.now()) {
    if (!payload || typeof payload !== 'object' || !payload.rate_limit) return null;
    const windows = {};
    for (const item of [payload.rate_limit.primary_window, payload.rate_limit.secondary_window]) {
      if (!item || typeof item !== 'object') continue;
      const key = item.limit_window_seconds === 18000 ? 'fiveHour' : item.limit_window_seconds === 604800 ? 'weekly' : null;
      if (!key) continue;
      if (typeof item.used_percent !== 'number' || !Number.isFinite(item.used_percent) || item.used_percent < 0 || item.used_percent > 100 || windows[key]) return null;
      const remaining = Math.round((100 - item.used_percent) * 10) / 10;
      let timestamp = null;
      if (Number.isSafeInteger(item.reset_at) && item.reset_at > 0 && item.reset_at < 100000000000) timestamp = item.reset_at * 1000;
      else if (Number.isSafeInteger(item.reset_after_seconds) && item.reset_after_seconds >= 0 && item.reset_after_seconds <= 31536000) timestamp = now + item.reset_after_seconds * 1000;
      const reset = timestamp === null ? null : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp));
      windows[key] = { remaining, reset };
    }
    return Object.keys(windows).length ? windows : null;
  }
  const api = Object.freeze({ parse, valid, age, snapshot, fromAPI });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.UsageUnderChat = api;
})();
