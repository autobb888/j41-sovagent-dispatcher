// Integration test for the proxy settle-path wiring: maybeNotifyCreditLow ties
// the meter debounce (checkAndFlagLow) to the seller-signed notify, fires ONCE
// per downward crossing, re-arms after a deposit, and resolves the threshold
// default (suggested_topup_vrsc) when credit_low_threshold_vrsc is unset.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-credit-low-wire-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;

const { generateKeypair } = require('@junction41/sovagent-sdk/dist/index.js');
const { maybeNotifyCreditLow, resolveCreditLowThreshold } = require('../src/proxy-handler.js');
const { creditDeposit } = require('../src/credit-meter.js');
const { setNotifyContext } = require('../src/deposit-watcher.js');

const NET = 'verustest';
const AGENT = 'agent-wire';

// Wire a signer context (as the dispatcher does at startup) so the notify can sign.
const seller = generateKeypair(NET);
setNotifyContext(AGENT, { sellerWif: seller.wif, sellerVerusId: 'bob.sovcompute@', network: NET });

function captureFetch() {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, async text() { return ''; } };
  };
  return { calls, restore() { global.fetch = orig; } };
}

// Let the best-effort async notify (catch(()=>{})) settle before asserting.
const flush = () => new Promise((r) => setTimeout(r, 50));

test('resolveCreditLowThreshold defaults to suggested_topup_vrsc when unset', () => {
  assert.equal(resolveCreditLowThreshold({ proxy: { credit_low_threshold_vrsc: null, suggested_topup_vrsc: 10 } }), 10);
  assert.equal(resolveCreditLowThreshold({ proxy: { credit_low_threshold_vrsc: 0, suggested_topup_vrsc: 7 } }), 7);
  assert.equal(resolveCreditLowThreshold({ proxy: { credit_low_threshold_vrsc: 2.5, suggested_topup_vrsc: 10 } }), 2.5);
});

test('maybeNotifyCreditLow fires once per crossing, debounces, and re-arms after deposit', async () => {
  const buyer = 'iWireBuyer';
  const cfg = { proxy: { credit_low_threshold_vrsc: 1.0, suggested_topup_vrsc: 10 } };
  const config = { payAddress: 'RsellerPay' };
  creditDeposit(AGENT, buyer, 10, 'tx-w-1');

  const cap = captureFetch();
  try {
    // Healthy balance → no notify.
    maybeNotifyCreditLow(AGENT, buyer, 5.0, cfg, config);
    await flush();
    assert.equal(cap.calls.length, 0, 'no notify above threshold');

    // Crosses below → exactly one notify.
    maybeNotifyCreditLow(AGENT, buyer, 0.83, cfg, config);
    await flush();
    assert.equal(cap.calls.length, 1, 'one notify on the crossing');
    assert.equal(cap.calls[0].body.balance, '0.83');
    assert.equal(cap.calls[0].body.threshold, '1');
    assert.equal(cap.calls[0].body.suggestedTopup, '10');
    assert.equal(cap.calls[0].body.payAddress, 'RsellerPay');

    // Still low → debounced, no re-fire.
    maybeNotifyCreditLow(AGENT, buyer, 0.4, cfg, config);
    await flush();
    assert.equal(cap.calls.length, 1, 'debounced: still one notify');

    // Deposit re-arms; next crossing fires again.
    creditDeposit(AGENT, buyer, 10, 'tx-w-2');
    maybeNotifyCreditLow(AGENT, buyer, 0.7, cfg, config);
    await flush();
    assert.equal(cap.calls.length, 2, 're-armed: a second notify after deposit + re-cross');
  } finally {
    cap.restore();
  }
});

test('maybeNotifyCreditLow does not throw when no signer context is wired', async () => {
  const buyer = 'iNoCtxBuyer';
  const cfg = { proxy: { credit_low_threshold_vrsc: 1.0, suggested_topup_vrsc: 10 } };
  creditDeposit('agent-no-ctx', buyer, 10, 'tx-noctx-1');
  const cap = captureFetch();
  try {
    // agent-no-ctx has no setNotifyContext → flag set, but no POST, no throw.
    maybeNotifyCreditLow('agent-no-ctx', buyer, 0.5, cfg, { payAddress: 'R' });
    await flush();
    assert.equal(cap.calls.length, 0);
  } finally {
    cap.restore();
  }
});
