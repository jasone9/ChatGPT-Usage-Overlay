'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const U = require('../usage.js');

test('reads the screenshot layout without mixing in monthly credits', () => {
  assert.deepEqual(U.parse(`Usage
General usage limits
Monthly usage limit
0% remaining
0 of 0 credits used
5 hour usage limit
100% left
Resets 6:17 PM
Weekly usage limit
100% left
Resets Nov 9, 2026, 1:17 PM`), {
    fiveHour: { remaining: 100, reset: '6:17 PM' },
    weekly: { remaining: 100, reset: 'Nov 9, 2026, 1:17 PM' }
  });
});
test('keeps different limits and reset times separate', () => {
  assert.deepEqual(U.parse('5-hour limit\n17% remaining\nResets 8:00 PM\nWeekly limit\n64% left\nResets Nov 12'), {
    fiveHour: { remaining: 17, reset: '8:00 PM' }, weekly: { remaining: 64, reset: 'Nov 12' }
  });
});
test('converts explicit used percentages to remaining', () => {
  assert.deepEqual(U.parse('5h\n12.5% used\nWeekly\n80% used'), {
    fiveHour: { remaining: 87.5, reset: null }, weekly: { remaining: 20, reset: null }
  });
});
test('preserves zero remaining instead of treating it as missing', () => {
  assert.equal(U.parse('Weekly usage limit\n0% left').weekly.remaining, 0);
});
test('does not borrow monthly data for a missing weekly percentage', () => {
  assert.equal(U.parse('Weekly limit\nLoading\nMonthly usage limit\n90% remaining'), null);
});
test('accepts one allowance without inventing the other', () => {
  assert.deepEqual(U.parse('Weekly limit\n72% remaining'), { weekly: { remaining: 72, reset: null } });
});
test('rejects percentages without an explicit direction', () => {
  assert.equal(U.parse('5 hour usage limit\n87%'), null);
});
test('rejects invalid and negative percentages', () => {
  for (const value of ['101', '-7', '−7', '1000', '1,000']) {
    assert.equal(U.parse(`Weekly usage limit\n${value}% left`), null, value);
  }
});
test('rejects conflicting values in one section', () => {
  assert.equal(U.parse('Weekly limit\n20% left\n80% left'), null);
});
test('rejects duplicate conflicting cards for the same allowance', () => {
  assert.equal(U.parse('Weekly limit\n20% left\nWeekly limit\n80% left'), null);
});
test('handles nonbreaking spaces and decimal percentages', () => {
  assert.equal(U.parse('5\u00a0hour usage limit\n92,5% left').fiveHour.remaining, 92.5);
});
test('does not use unrelated code-review percentages', () => {
  assert.equal(U.parse('Weekly limit\nLoading\nCode review limit\n80% remaining'), null);
});
test('rejects oversized or non-text input', () => {
  for (const value of [null, {}, 'Weekly limit\n20% left' + 'x'.repeat(24000)]) assert.equal(U.parse(value), null);
});
test('expires snapshots without predicting a reset or refill', () => {
  const now = Date.now();
  const saved = { version: 1, capturedAt: now - 86400000, source: 'visible-settings', windows: { weekly: { remaining: 0, reset: 'yesterday' } } };
  assert.equal(U.valid(saved, now), null);
  saved.capturedAt = now - 3600000;
  assert.equal(U.valid(saved, now).windows.weekly.remaining, 0);
});
test('rejects invalid, future, or unknown-source snapshots', () => {
  const now = Date.now();
  assert.equal(U.valid({}), null);
  assert.equal(U.valid({ version: 1, capturedAt: now + 120000, source: 'visible-settings' }, now), null);
  assert.equal(U.valid({ version: 1, capturedAt: now, source: 'guessed', windows: { weekly: { remaining: 100 } } }, now), null);
});
test('stores normalized values only', () => {
  const windows = U.parse('Email: example@example.invalid\nWeekly usage limit\n90% left\nResets tomorrow');
  const saved = U.snapshot(windows, 'pasted-settings');
  assert.deepEqual(Object.keys(saved).sort(), ['capturedAt', 'source', 'version', 'windows']);
  assert.equal(JSON.stringify(saved).includes('example@'), false);
});
test('age display is explicit and stable', () => {
  const now = 100000000;
  assert.equal(U.age(now, now), 'just now');
  assert.equal(U.age(now - 420000, now), '7m ago');
  assert.equal(U.age(now - 7200000, now), '2h ago');
});
