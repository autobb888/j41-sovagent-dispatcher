const test = require('node:test');
const assert = require('node:assert');
const { checkAndRecordNonce, _reset, _size, DEFAULT_TTL_MS } = require('../src/nonce-cache.js');

test('first sighting of a nonce is accepted', () => {
  _reset();
  const r = checkAndRecordNonce('a'.repeat(32), Date.now() + 60_000);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(_size(), 1);
});

test('replayed nonce within window is rejected', () => {
  _reset();
  const n = 'b'.repeat(32);
  const exp = Date.now() + 60_000;
  assert.strictEqual(checkAndRecordNonce(n, exp).ok, true);
  const r = checkAndRecordNonce(n, exp);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'replay');
});

test('expired entry — TTL falls back to DEFAULT_TTL_MS when expiresAt is in the past', () => {
  _reset();
  const n = 'c'.repeat(32);
  // expiresAtMs in the past — first call should still record (the envelope's
  // own expiresAt is past, so signature verification will reject anyway, but
  // nonce-cache shouldn't crash on this input). The recorded TTL should fall
  // back to DEFAULT_TTL_MS, NOT to "now" (which would let immediate replays through).
  const before = Date.now();
  assert.strictEqual(checkAndRecordNonce(n, before - 1000).ok, true);
  // Same nonce within DEFAULT_TTL_MS window must be rejected as replay
  const r = checkAndRecordNonce(n, Date.now() + 1000);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'replay');
});

test('invalid nonce is rejected', () => {
  _reset();
  assert.strictEqual(checkAndRecordNonce(undefined, Date.now() + 60_000).ok, false);
  assert.strictEqual(checkAndRecordNonce('', Date.now() + 60_000).ok, false);
  assert.strictEqual(checkAndRecordNonce(123, Date.now() + 60_000).ok, false);
});
