'use strict';
const test = require('node:test');
const assert = require('node:assert');

const {
  FEE_SATS,
  DEFAULT_FLOOR_WRITES,
  DEFAULT_MIN_SWEEP_SATS,
  SWEEP_PENDING_BACKSTOP_MS,
  summarizeUtxos,
  writesAffordable,
  planFeeSweep,
  executeFeeSweep,
} = require('../src/fee-tank.js');

const R = 'RWoeXSRs4WHQYauzUg6bPowNyBRsz5bW51';
const I = 'i9j8RkZcqmdU8gMiTHvggtRAdwv4Q3VWJf';
const iUtxo = (satoshis, n = 0) => ({ txid: `t${n}`, vout: n, address: I, satoshis, script: 'deadbeef' });
const rUtxo = (satoshis, n = 0) => ({ txid: `r${n}`, vout: n, address: R, satoshis });

// ---------------------------------------------------------------------------
// summarizeUtxos — the R/i split is the whole basis of the decision
// ---------------------------------------------------------------------------

test('splits fee-payable from sweepable by address', () => {
  const s = summarizeUtxos([rUtxo(500000, 1), iUtxo(500000, 2), iUtxo(500000, 3)], R);
  assert.strictEqual(s.feeSats, 500000);
  assert.strictEqual(s.sweepableSats, 1000000);
  assert.strictEqual(s.sweepableUtxos.length, 2);
});

test('a UTXO with no address counts as fee-payable, matching the SDK fee filter', () => {
  const s = summarizeUtxos([{ txid: 'x', vout: 0, satoshis: 700000 }], R);
  assert.strictEqual(s.feeSats, 700000);
  assert.strictEqual(s.sweepableSats, 0);
});

test('zero-value and malformed UTXOs are ignored', () => {
  const s = summarizeUtxos([iUtxo(0, 1), null, undefined, { address: I }, iUtxo(500000, 2)], R);
  assert.strictEqual(s.sweepableSats, 500000);
  assert.strictEqual(s.sweepableUtxos.length, 1);
});

test('writesAffordable is the fee-budget unit reported to the operator', () => {
  assert.strictEqual(writesAffordable(300790000), 30079); // agent-7 after its live sweep
  assert.strictEqual(writesAffordable(800000), 80);       // agent-7 before it
  assert.strictEqual(writesAffordable(0), 0);
});

// ---------------------------------------------------------------------------
// planFeeSweep
// ---------------------------------------------------------------------------

test('does not sweep while the tank is above the floor', () => {
  const p = planFeeSweep({ feeSats: DEFAULT_FLOOR_WRITES * FEE_SATS, sweepableSats: 5_000_000 });
  assert.strictEqual(p.sweep, false);
  assert.strictEqual(p.reason, 'above-floor');
});

test('sweeps when below the floor, netting the tx fee out of the amount', () => {
  const p = planFeeSweep({ feeSats: 0, sweepableSats: 13_500_000 });
  assert.strictEqual(p.sweep, true);
  // Exactly the live agent-6 sweep: 13,500,000 in → 13,490,000 to the R-address.
  assert.strictEqual(p.amountSats, 13_490_000);
});

test('an empty tank with nothing to sweep is an alert, not a silent no-op', () => {
  // agent-11: zero at both addresses. It has never earned, so it cannot self-fund.
  const p = planFeeSweep({ feeSats: 0, sweepableSats: 0 });
  assert.strictEqual(p.sweep, false);
  assert.strictEqual(p.reason, 'needs-external-funding');
});

test('does not burn a whole fee to move dust', () => {
  const p = planFeeSweep({ feeSats: 0, sweepableSats: DEFAULT_MIN_SWEEP_SATS - 1 });
  assert.strictEqual(p.sweep, false);
  assert.strictEqual(p.reason, 'below-min-sweep');
});

test('never proposes a non-positive output even if minSweep is lowered to the fee', () => {
  const p = planFeeSweep({ feeSats: 0, sweepableSats: FEE_SATS, minSweepSats: 1 });
  assert.strictEqual(p.sweep, false);
  assert.strictEqual(p.amountSats, 0);
});

// The double-spend guard. The platform serves the CONFIRMED view, so right after
// a sweep broadcasts it still shows the i-address UTXOs unspent and the tank
// empty — rebuilding from that spends the same inputs twice.
test('does not re-sweep while a broadcast sweep is still pending', () => {
  const pending = { txid: 'abc', at: 1_000_000 };
  const p = planFeeSweep({ feeSats: 0, sweepableSats: 13_500_000, pending, now: 1_000_000 + 60_000 });
  assert.strictEqual(p.sweep, false);
  assert.strictEqual(p.reason, 'sweep-pending');
});

test('releases the pending guard after the backstop so a lost tx cannot wedge it forever', () => {
  const pending = { txid: 'abc', at: 0 };
  const p = planFeeSweep({ feeSats: 0, sweepableSats: 13_500_000, pending, now: SWEEP_PENDING_BACKSTOP_MS + 1 });
  assert.strictEqual(p.sweep, true);
});

test('the floor is configurable, not hardcoded', () => {
  const args = { feeSats: 50 * FEE_SATS, sweepableSats: 13_500_000 };
  assert.strictEqual(planFeeSweep({ ...args, floorWrites: 10 }).sweep, false, '50 writes is above a floor of 10');
  assert.strictEqual(planFeeSweep({ ...args, floorWrites: 500 }).sweep, true, '50 writes is below a floor of 500');
});

// ---------------------------------------------------------------------------
// executeFeeSweep — the invariant that makes this work at a zero balance
// ---------------------------------------------------------------------------

const okBuild = () => 'aa00ff';
const okBroadcast = async () => ({ txid: 'swept-txid' });

test('sweeps i-address inputs to the R-address', async () => {
  let seen;
  const r = await executeFeeSweep({
    buildPayment: (p) => { seen = p; return okBuild(); },
    broadcast: okBroadcast,
    wif: 'W', network: 'verustest', rAddress: R,
    sweepableUtxos: [iUtxo(500000, 1), iUtxo(500000, 2)],
    amountSats: 990000,
  });
  assert.strictEqual(r.swept, true);
  assert.strictEqual(r.txid, 'swept-txid');
  assert.strictEqual(seen.toAddress, R, 'must pay INTO the fee tank');
  assert.strictEqual(seen.amount, 0.0099, 'buildPayment takes VRSC, not satoshis');
});

test('REFUSES to spend R-address inputs — those are the tank being filled', async () => {
  const r = await executeFeeSweep({
    buildPayment: okBuild, broadcast: okBroadcast,
    wif: 'W', network: 'verustest', rAddress: R,
    sweepableUtxos: [iUtxo(500000, 1), rUtxo(500000, 2)],
    amountSats: 990000,
  });
  assert.strictEqual(r.swept, false);
  assert.match(r.reason, /R-address inputs/);
});

test('a rejected broadcast is reported, not thrown — one agent must not break the loop', async () => {
  const r = await executeFeeSweep({
    buildPayment: okBuild,
    broadcast: async () => { throw Object.assign(new Error('bad-txns'), { detail: '-26' }); },
    wif: 'W', network: 'verustest', rAddress: R,
    sweepableUtxos: [iUtxo(500000, 1)],
    amountSats: 490000,
  });
  assert.strictEqual(r.swept, false);
  assert.match(r.reason, /broadcast rejected/);
  assert.strictEqual(r.detail, '-26');
});

test('a throwing builder is reported, not thrown', async () => {
  const r = await executeFeeSweep({
    buildPayment: () => { throw new Error('cannot sign'); },
    broadcast: okBroadcast,
    wif: 'W', network: 'verustest', rAddress: R,
    sweepableUtxos: [iUtxo(500000, 1)],
    amountSats: 490000,
  });
  assert.strictEqual(r.swept, false);
  assert.match(r.reason, /build failed/);
});

test('a broadcast that returns no txid is a failure, not a silent success', async () => {
  const r = await executeFeeSweep({
    buildPayment: okBuild, broadcast: async () => ({}),
    wif: 'W', network: 'verustest', rAddress: R,
    sweepableUtxos: [iUtxo(500000, 1)],
    amountSats: 490000,
  });
  assert.strictEqual(r.swept, false);
});

test('missing dependencies fail closed rather than half-executing', async () => {
  const base = {
    buildPayment: okBuild, broadcast: okBroadcast,
    wif: 'W', network: 'verustest', rAddress: R,
    sweepableUtxos: [iUtxo(500000, 1)], amountSats: 490000,
  };
  assert.strictEqual((await executeFeeSweep({ ...base, buildPayment: null })).swept, false);
  assert.strictEqual((await executeFeeSweep({ ...base, wif: null })).swept, false);
  assert.strictEqual((await executeFeeSweep({ ...base, rAddress: null })).swept, false);
  assert.strictEqual((await executeFeeSweep({ ...base, sweepableUtxos: [] })).swept, false);
  assert.strictEqual((await executeFeeSweep({ ...base, amountSats: 0 })).swept, false);
});

// ---------------------------------------------------------------------------
// Fail-closed on unusable inputs (audit findings #4, #5).
//
// planFeeSweep compares its way down a ladder of guards. With a NaN balance
// EVERY comparison is false, so it fell through all of them and answered
// "yes, sweep" for a tank whose level it did not know.
// ---------------------------------------------------------------------------

test('refuses to decide on non-finite balances instead of falling through to sweep', () => {
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '100']) {
    const a = planFeeSweep({ feeSats: bad, sweepableSats: 13_500_000 });
    assert.strictEqual(a.sweep, false, `feeSats=${String(bad)} must not sweep`);
    assert.strictEqual(a.reason, 'invalid-balances');

    const b = planFeeSweep({ feeSats: 0, sweepableSats: bad });
    assert.strictEqual(b.sweep, false, `sweepableSats=${String(bad)} must not sweep`);
  }
});

test('string satoshis are rejected, not string-concatenated into a giant total', () => {
  // "500000" passes a bare `> 0`, then reduce() concatenates: two 0.005 UTXOs
  // become "0500000500000" and the plan proposes sweeping ~5000 coins.
  const s = summarizeUtxos(
    [{ txid: 'a', vout: 0, address: I, satoshis: '500000' },
     { txid: 'b', vout: 1, address: I, satoshis: '500000' }], R);
  assert.strictEqual(s.sweepableSats, 0);
  assert.strictEqual(s.sweepableUtxos.length, 0);
  assert.strictEqual(typeof s.sweepableSats, 'number');
});

test('NaN/Infinity satoshis cannot enter either bucket', () => {
  const s = summarizeUtxos(
    [{ txid: 'a', vout: 0, address: I, satoshis: NaN },
     { txid: 'b', vout: 1, address: R, satoshis: Infinity },
     iUtxo(500000, 2)], R);
  assert.strictEqual(s.sweepableSats, 500000);
  assert.strictEqual(s.feeSats, 0);
});

test('a pending record with no usable timestamp fails CLOSED', () => {
  // "A sweep was broadcast but we cannot tell when" is the worst case to
  // re-sweep on, so it must defer rather than fall through the guard.
  for (const bad of [{}, { txid: 'x' }, { txid: 'x', at: 'soon' }, { txid: 'x', at: NaN }]) {
    const p = planFeeSweep({ feeSats: 0, sweepableSats: 13_500_000, pending: bad, now: 5_000_000 });
    assert.strictEqual(p.sweep, false, `pending=${JSON.stringify(bad)} must defer`);
    assert.strictEqual(p.reason, 'sweep-pending');
  }
});

test('the backstop releases exactly at the boundary, not one tick later', () => {
  const at = 1_000_000;
  const args = { feeSats: 0, sweepableSats: 13_500_000, pending: { txid: 'x', at } };
  assert.strictEqual(planFeeSweep({ ...args, now: at + SWEEP_PENDING_BACKSTOP_MS - 1 }).sweep, false);
  assert.strictEqual(planFeeSweep({ ...args, now: at + SWEEP_PENDING_BACKSTOP_MS }).sweep, true);
});

test('executeFeeSweep forwards the fee and utxo set, not just address and amount', () => {
  let seen;
  return executeFeeSweep({
    buildPayment: (p) => { seen = p; return 'aa'; },
    broadcast: okBroadcast,
    wif: 'W', network: 'verustest', rAddress: R,
    sweepableUtxos: [iUtxo(500000, 1), iUtxo(500000, 2)],
    amountSats: 990000,
  }).then(() => {
    assert.strictEqual(seen.fee, FEE_SATS, 'fee must be passed in satoshis');
    assert.strictEqual(seen.utxos.length, 2, 'must spend exactly the sweepable set');
    assert.strictEqual(seen.network, 'verustest');
    assert.strictEqual(seen.wif, 'W');
  });
});

test('an address-less UTXO is refused by the executor rather than spent', () => {
  // If the platform ever omitted `address`, summarizeUtxos would classify
  // everything as fee-payable — but should a caller hand one straight to the
  // executor, it must not spend it: it could be the tank itself.
  return executeFeeSweep({
    buildPayment: okBuild, broadcast: okBroadcast,
    wif: 'W', network: 'verustest', rAddress: R,
    sweepableUtxos: [{ txid: 'a', vout: 0, satoshis: 500000 }],
    amountSats: 490000,
  }).then((r) => {
    assert.strictEqual(r.swept, false);
    assert.match(r.reason, /R-address inputs/);
  });
});
