(() => {
  'use strict';
  const usageURLs = [
    'https://chatgpt.com/settings/usage',
    'https://chatgpt.com/#settings/Usage',
    'https://chatgpt.com/codex/cloud/settings/analytics#usage'
  ];
  function isChatGPT(value) {
    try { return new URL(value).origin === 'https://chatgpt.com'; } catch { return false; }
  }
  function isUsageURL(value) {
    try {
      const url = new URL(value);
      if (!isChatGPT(value)) return false;
      return /^\/(?:settings\/usage|codex\/(?:cloud\/)?settings\/(?:usage|analytics))\/?$/.test(url.pathname)
        || /^#(?:settings\/usage|usage)(?:[/?&]|$)/i.test(url.hash);
    } catch { return false; }
  }
  const api = Object.freeze({ usageURLs, isChatGPT, isUsageURL, refreshMs: 120000, cooldownMs: 60000, timeoutMs: 30000 });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.UsageReaderConfig = api;
})();
