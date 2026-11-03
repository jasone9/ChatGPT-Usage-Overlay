/* Runs in the isolated content-script world of an existing ChatGPT tab. */
(() => {
  'use strict';
  const U = globalThis.UsageUnderChat;
  let pending = null, controller = null;
  const error = code => Object.assign(new Error(code), { code });
  async function json(path, options, signal) {
    const response = await fetch(path, { ...options, method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal });
    if (response.status === 401) throw error('sign-in');
    if (response.status === 403) throw error('blocked');
    if (response.status === 429) {
      const value = response.headers.get('retry-after');
      const seconds = value && /^\d+$/.test(value) ? Number(value) : 0;
      throw Object.assign(error('rate-limited'), { retryAfter: Math.min(1800, Math.max(0, seconds)) });
    }
    if (!response.ok) throw error('unavailable');
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw error('unsupported');
    const text = await response.text();
    if (text.length > 262144) throw error('unsupported');
    try { return JSON.parse(text); } catch { throw error('unsupported'); }
  }
  async function readOnce() {
    controller = new AbortController();
    const signal = controller.signal;
    const timer = setTimeout(() => controller?.abort(), 20000);
    let session = null, token = null, scopeKey = null;
    try {
      session = await json('/api/auth/session', { headers: { Accept: 'application/json' } }, signal);
      token = session?.accessToken;
      if (typeof token !== 'string' || !token || token.length > 32768 || /[\r\n]/.test(token)) throw error('sign-in');
      const account = typeof session?.account?.id === 'string' ? session.account.id : null;
      const identity = `${typeof session?.user?.id === 'string' ? session.user.id : ''}:${account || ''}`;
      if (identity !== ':') {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
        scopeKey = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
      }
      const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
      if (account) {
        if (account.length > 256 || /[\r\n]/.test(account)) throw error('unsupported');
        headers['ChatGPT-Account-Id'] = account;
      }
      const payload = await json('/backend-api/wham/usage', { headers }, signal);
      if (account && typeof payload?.account_id === 'string' && payload.account_id !== account) throw error('account-mismatch');
      const windows = U.fromAPI(payload);
      if (!windows) throw error('unsupported');
      return { ok: true, windows, scopeKey };
    } catch (failure) {
      const codes = ['sign-in', 'blocked', 'rate-limited', 'unavailable', 'unsupported', 'account-mismatch'];
      const code = signal.aborted ? 'timeout' : codes.includes(failure?.code) ? failure.code : 'network';
      return { ok: false, code, scopeKey, retryAfter: Number.isFinite(failure?.retryAfter) ? failure.retryAfter : 0 };
    } finally {
      clearTimeout(timer);
      // Credentials never enter extension messages, storage, DOM, or logs.
      token = null; session = null; controller = null;
    }
  }
  function read() {
    if (!pending) pending = readOnce().finally(() => { pending = null; });
    return pending;
  }
  globalThis.DirectUsageReader = Object.freeze({ read, cancel: () => controller?.abort() });
})();
