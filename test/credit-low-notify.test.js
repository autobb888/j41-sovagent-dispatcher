// Wire-contract tests for the dispatcher → J41 credit-low notify.
//
// Verifies notifyJ41CreditLow POSTs to the spec §2a endpoint with the exact
// field names, string-typed amounts, and a dispatcherSig that re-verifies
// against the seller key over the SAME canonical bytes J41 will reconstruct.
// (If these drift, the J41 handler's verifyVerusSignature would reject it.)

const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalize } = require('json-canonicalize');
const { generateKeypair, verifyMessage } = require('@junction41/sovagent-sdk/dist/index.js');
const { notifyJ41CreditLow } = require('../src/deposit-watcher.js');

const NET = 'verustest';

// Capture the single fetch a notify performs.
function captureFetch(responseOk = true) {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    return { ok: responseOk, status: responseOk ? 200 : 401, async text() { return ''; } };
  };
  return { calls, restore() { global.fetch = orig; } };
}

test('notifyJ41CreditLow posts the §2a contract with a verifiable dispatcherSig', async () => {
  const seller = generateKeypair(NET);
  const cap = captureFetch();
  try {
    await notifyJ41CreditLow(
      seller.wif, 'bob.sovcompute@', 'alice.sovagent@',
      0.83, 1.0, 10, 'RsellerPayAddr', NET,
    );
  } finally {
    cap.restore();
  }

  assert.equal(cap.calls.length, 1, 'exactly one POST');
  const { url, opts, body } = cap.calls[0];
  assert.match(url, /\/v1\/webhooks\/dispatcher\/credit-low$/);
  assert.equal(opts.method, 'POST');

  // Field names + string typing per spec §2a.
  assert.equal(body.action, 'dispatcher.credit-low');
  assert.equal(body.sellerVerusId, 'bob.sovcompute@');
  assert.equal(body.buyerVerusId, 'alice.sovagent@');
  assert.equal(body.balance, '0.83');
  assert.equal(body.threshold, '1');
  assert.equal(body.suggestedTopup, '10');
  assert.equal(body.payAddress, 'RsellerPayAddr');
  assert.equal(typeof body.observedAt, 'number');
  assert.ok(Number.isInteger(body.observedAt));
  assert.ok(body.nonce && typeof body.nonce === 'string');
  assert.ok(body.dispatcherSig && typeof body.dispatcherSig === 'string');

  // The signature must re-verify against the seller key over the canonical
  // payload WITHOUT dispatcherSig — exactly what the J41 handler reconstructs.
  const { dispatcherSig, ...signed } = body;
  const canonical = canonicalize(signed);
  assert.equal(verifyMessage(canonical, seller.address, dispatcherSig, NET), true,
    'dispatcherSig must verify over canonicalize(payload-without-sig)');
});

test('notifyJ41CreditLow is non-fatal when fetch rejects (best-effort)', async () => {
  const seller = generateKeypair(NET);
  const orig = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  try {
    // Must resolve, not throw — the proxy response must never break on this.
    await notifyJ41CreditLow(seller.wif, 'bob@', 'alice@', 0.5, 1.0, 10, 'R', NET);
  } finally {
    global.fetch = orig;
  }
});
