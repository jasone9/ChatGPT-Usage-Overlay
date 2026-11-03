'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const U = require('../usage.js');
const payload = () => ({ account_id: 'workspace-fixture', rate_limit: {
  primary_window: { used_percent: 6, limit_window_seconds: 18000, reset_at: 1800003600 },
  secondary_window: { used_percent: 1, limit_window_seconds: 604800, reset_at: 1800604800 }
} });
function setup(options = {}) {
  const calls = [], timers = [];
  const response = (value, status = 200, type = 'application/json', retry = null) => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: name => name === 'content-type' ? type : name === 'retry-after' ? retry : null },
    text: async () => JSON.stringify(value)
  });
  const context = vm.createContext({
    UsageUnderChat: U, AbortController, TextEncoder, Uint8Array, crypto: webcrypto,
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
    fetch: async (path, init) => {
      calls.push({ path, init });
      if (options.fetch) return options.fetch(path, init, response);
      if (path === '/api/auth/session') return response({ accessToken: 'fixture-secret-do-not-persist', user: { id: 'user-fixture' }, account: { id: 'workspace-fixture' } });
      return response(payload());
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../direct.js'), 'utf8'), context);
  return { reader: context.DirectUsageReader, calls, timers, response };
}
test('reads both allowances through exact same-origin GETs without returning credentials', async () => {
  const e = setup(); const result = await e.reader.read();
  assert.equal(result.ok, true);
  assert.equal(result.windows.fiveHour.remaining, 94);
  assert.equal(result.windows.weekly.remaining, 99);
  assert.match(result.scopeKey, /^[a-f0-9]{64}$/);
  assert.deepEqual(e.calls.map(c => c.path), ['/api/auth/session', '/backend-api/wham/usage']);
  for (const { init } of e.calls) {
    assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'same-origin');
    assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
  }
  assert.equal(e.calls[1].init.headers.Authorization, 'Bearer fixture-secret-do-not-persist');
  assert.equal(e.calls[1].init.headers['ChatGPT-Account-Id'], 'workspace-fixture');
  for (const secret of ['fixture-secret', 'workspace-fixture', 'user-fixture', 'accessToken', 'Authorization']) assert.equal(JSON.stringify(result).includes(secret), false);
});
test('coalesces concurrent reads and fetches a fresh session for the next read', async () => {
  const e = setup(); const [a, b] = await Promise.all([e.reader.read(), e.reader.read()]);
  assert.equal(a.ok, true); assert.equal(b.ok, true); assert.equal(e.calls.length, 2);
  await e.reader.read(); assert.equal(e.calls.length, 4);
});
test('401 or a missing session token never sends a usage request', async () => {
  for (const mode of ['401', 'missing']) {
    const e = setup({ fetch: async (_path, _init, reply) => mode === '401' ? reply({}, 401) : reply({}) });
    const result = await e.reader.read(); assert.equal(result.ok, false); assert.equal(result.code, 'sign-in'); assert.equal(e.calls.length, 1);
  }
});
test('returns a bounded retry delay for HTTP 429', async () => {
  const e = setup({ fetch: async (_path, _init, reply) => reply({}, 429, 'application/json', '99999') });
  const result = await e.reader.read(); assert.equal(result.code, 'rate-limited'); assert.equal(result.retryAfter, 1800);
});
test('does not return server bodies or raw exception messages on errors', async () => {
  for (const mode of ['network', 'html', '403']) {
    const e = setup({ fetch: async (_path, _init, reply) => {
      if (mode === 'network') throw Error('fixture-secret-do-not-persist');
      return reply('fixture-secret-do-not-persist', mode === '403' ? 403 : 200, 'text/html');
    } });
    const result = await e.reader.read(); assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  }
});
test('rejects a response for a different account', async () => {
  const e = setup({ fetch: async (path, _init, reply) => path === '/api/auth/session'
    ? reply({ accessToken: 'fixture-secret', account: { id: 'account-a' } })
    : reply({ ...payload(), account_id: 'account-b' }) });
  assert.equal((await e.reader.read()).code, 'account-mismatch');
});
test('cancels pending network work and returns a safe timeout code', async () => {
  const e = setup({ fetch: (_path, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Error('aborted')))) });
  const promise = e.reader.read(); e.reader.cancel();
  assert.equal((await promise).code, 'timeout');
});
test('maps durations rather than assuming primary always means five hours', () => {
  const data = payload();
  [data.rate_limit.primary_window, data.rate_limit.secondary_window] = [data.rate_limit.secondary_window, data.rate_limit.primary_window];
  assert.equal(U.fromAPI(data).fiveHour.remaining, 94); assert.equal(U.fromAPI(data).weekly.remaining, 99);
});
test('accepts zero/full and one window, and excludes unrelated rate limits', () => {
  const data = payload(); data.rate_limit.primary_window.used_percent = 100; data.rate_limit.secondary_window.used_percent = 0;
  assert.equal(U.fromAPI(data).fiveHour.remaining, 0); assert.equal(U.fromAPI(data).weekly.remaining, 100);
  delete data.rate_limit.primary_window; assert.deepEqual(Object.keys(U.fromAPI(data)), ['weekly']);
  assert.equal(U.fromAPI({ additional_rate_limits: [payload().rate_limit] }), null);
});
test('rejects unknown durations, invalid percentages, and duplicate same-duration windows', () => {
  for (const value of [null, '6', -1, 101, NaN]) {
    const data = payload(); data.rate_limit.primary_window.used_percent = value; assert.equal(U.fromAPI(data), null);
  }
  assert.equal(U.fromAPI({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 123 } } }), null);
  const data = payload(); data.rate_limit.secondary_window = data.rate_limit.primary_window; assert.equal(U.fromAPI(data), null);
});
test('formats explicit resets and does not synthesize a reset from missing data', () => {
  const data = payload(); delete data.rate_limit.primary_window.reset_at;
  assert.equal(U.fromAPI(data).fiveHour.reset, null);
  data.rate_limit.primary_window.reset_after_seconds = 60;
  assert.equal(typeof U.fromAPI(data, 1800000000000).fiveHour.reset, 'string');
});
