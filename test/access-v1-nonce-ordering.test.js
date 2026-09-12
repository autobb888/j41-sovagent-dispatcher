/**
 * Task 3 — v1 access must record nonces only after signature verify.
 *
 * Today the v1 branch passes isReplay that calls checkAndRecordNonce (records
 * on first sight). A verify that then fails has already burned the nonce; the
 * v2 path uses checkNonceAfterVerify after verified===true instead.
 *
 * Contract: isReplay is lookup-only; checkNonceAfterVerify(true, …) runs only
 * after verifyAccessRequest returns true. A failed verify leaves the cache
 * free so a second envelope with a new nonce is not treated as replay.
 */
'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const nonceCache = require('../src/nonce-cache');

function v1AccessBranch() {
  const src = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const onAccess = src.indexOf('onAccessRequest: async (wireBody)');
  assert.ok(onAccess > -1, 'onAccessRequest handler must exist');
  // v1 lives in the else of `if (isV2)` after the v2 checkNonceAfterVerify block
  const v2Replay = src.indexOf('checkNonceAfterVerify(verified, wireBody.envelope.nonce', onAccess);
  assert.ok(v2Replay > -1, 'v2 checkNonceAfterVerify must still exist');
  const elseAt = src.indexOf('} else {', v2Replay);
  assert.ok(elseAt > -1, 'v1 else branch must follow v2 nonce check');
  const endAt = src.indexOf('// Mint API key', elseAt);
  assert.ok(endAt > -1, 'mint follows verify');
  return src.slice(elseAt, endAt);
}

test('v1 isReplay must not call checkAndRecordNonce (lookup only)', () => {
  const branch = v1AccessBranch();
  assert.match(branch, /verifyAccessRequest/);
  assert.match(branch, /isReplay:/);
  assert.doesNotMatch(branch, /checkAndRecordNonce/,
    'recording inside isReplay burns the nonce before the overall verify settles');
  assert.match(branch, /hasSeenNonce|seen\.has/,
    'isReplay must be a lookup against the nonce cache');
});

test('v1 records via checkNonceAfterVerify(true) only after verified === true', () => {
  const branch = v1AccessBranch();
  const verifiedAt = branch.indexOf('if (!verified)');
  const recordAt = branch.indexOf('checkNonceAfterVerify(true');
  assert.ok(verifiedAt > -1, 'must gate on verified');
  assert.ok(recordAt > -1, 'must call checkNonceAfterVerify(true, …)');
  assert.ok(recordAt > verifiedAt,
    'nonce must be recorded only after verified === true');
});

test('failed verify leaves cache free so a new nonce is not replay', () => {
  nonceCache._reset();
  const first = 'v1-fail-nonce-' + 'a'.repeat(16);
  const second = 'v1-ok-nonce-' + 'b'.repeat(16);
  const exp = Date.now() + 60_000;

  // Lookup during a request that will fail must not record.
  assert.equal(nonceCache.hasSeenNonce(first), false);
  const failed = nonceCache.checkNonceAfterVerify(false, first, exp);
  assert.equal(failed.ok, false);
  assert.equal(nonceCache._size(), 0, 'failed verify must not consume a cache slot');

  // Second envelope with a NEW nonce must be accepted, not replay.
  assert.equal(nonceCache.hasSeenNonce(second), false);
  const ok = nonceCache.checkNonceAfterVerify(true, second, exp);
  assert.equal(ok.ok, true);
  assert.equal(nonceCache._size(), 1);
  assert.equal(nonceCache.hasSeenNonce(second), true);
});

test('record-inside-isReplay antipattern burns a nonce even when verify then fails', () => {
  // Documents why the source pin above exists: the old callback recorded on sight.
  nonceCache._reset();
  const n = 'burned-by-isReplay-' + 'c'.repeat(8);
  const exp = Date.now() + 60_000;
  const badIsReplay = (nonce) => !nonceCache.checkAndRecordNonce(String(nonce), exp).ok;

  assert.equal(badIsReplay(n), false, 'first sight records and reports not-replay');
  assert.equal(nonceCache._size(), 1, 'nonce already burned');
  // Overall verify "fails" afterward — too late; cache still holds it.
  assert.equal(nonceCache.hasSeenNonce(n), true);
  assert.equal(nonceCache.checkNonceAfterVerify(true, n, exp).ok, false,
    'same nonce is now stuck as replay');
});
