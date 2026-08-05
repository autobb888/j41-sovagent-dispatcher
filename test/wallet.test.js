'use strict';
const test = require('node:test');
const assert = require('node:assert');

const {
  parseVrscAmount,
  formatVrsc,
  resolveOwnRAddress,
  buildWalletRow,
  summarizeFleet,
  planManualSweep,
  planFleetSend,
  executeSend,
} = require('../src/wallet.js');

const {
  FEE_SATS,
  DEFAULT_FLOOR_WRITES,
  SWEEP_PENDING_BACKSTOP_MS,
  summarizeUtxos,
} = require('../src/fee-tank.js');

const R = 'RWoeXSRs4WHQYauzUg6bPowNyBRsz5bW51';
const R2 = 'RDst9jH7kPqTmXbY4vN2wQ8sL6cZ3fA1gE';
const I = 'i9j8RkZcqmdU8gMiTHvggtRAdwv4Q3VWJf';
const iUtxo = (satoshis, n = 0) => ({ txid: `t${n}`, vout: n, address: I, satoshis, script: 'deadbeef' });
const rUtxo = (satoshis, n = 0) => ({ txid: `r${n}`, vout: n, address: R, satoshis });

// ---------------------------------------------------------------------------
// parseVrscAmount — the float-avoidance pin
// ---------------------------------------------------------------------------

test('parses ordinary amounts to exact satoshis', () => {
  assert.deepStrictEqual(parseVrscAmount('0.1349'), { ok: true, sats: 13490000 });
  assert.deepStrictEqual(parseVrscAmount('1'), { ok: true, sats: 100000000 });
  assert.deepStrictEqual(parseVrscAmount('2.99990000'), { ok: true, sats: 299990000 });
  assert.deepStrictEqual(parseVrscAmount('0.00000001'), { ok: true, sats: 1 });
});

// The reason this function exists at all. Most decimal amounts DO survive
// parseFloat*1e8 (0.1349, 2.9999 and 0.4999 are all exact), which is what lets
// the bug live through testing — but plenty do not, and the two below are
// verified failures, not illustrations.
test('is exact where parseFloat(x) * 1e8 is not', () => {
  assert.strictEqual(Number.isInteger(parseFloat('1.1') * 1e8), false, 'premise: 1.1 is a float hazard');
  assert.strictEqual(parseFloat('1.1') * 1e8, 110000000.00000001);
  assert.deepStrictEqual(parseVrscAmount('1.1'), { ok: true, sats: 110000000 });

  assert.strictEqual(Number.isInteger(parseFloat('8.7') * 1e8), false, 'premise: 8.7 is a float hazard');
  assert.strictEqual(parseFloat('8.7') * 1e8, 869999999.9999999);
  assert.deepStrictEqual(parseVrscAmount('8.7'), { ok: true, sats: 870000000 });
});

test('rejects anything that is not a plain positive decimal', () => {
  const bad = ['1.000000001', '1e3', '1E3', '-1', '+1', '0', '0.0', '0.00000000', '',
    '   ', '.', '.5', '1.', 'abc', 'NaN', 'Infinity', '1,5', '1 5', '0x10', '1.2.3'];
  for (const s of bad) {
    const r = parseVrscAmount(s);
    assert.strictEqual(r.ok, false, `${JSON.stringify(s)} must be refused`);
    assert.strictEqual(r.sats, 0, `${JSON.stringify(s)} must not carry a usable amount`);
    assert.strictEqual(typeof r.error, 'string');
  }
});

test('rejects non-string input — a number has already been through the float path', () => {
  for (const bad of [1.1, 100000000, null, undefined, {}, [], NaN, true]) {
    assert.strictEqual(parseVrscAmount(bad).ok, false, `${String(bad)} must be refused`);
  }
});

test('caps amounts where the SDK float round-trip stops being exact (audit S3)', () => {
  // The cap is 2^50 sats (~11.26M VRSC), NOT MAX_SAFE_INTEGER. We hand
  // `amountSats / 1e8` to the SDK, which does `Math.round(amount * 1e8)` to get
  // back to satoshis — and near the top of the range that round-trip is lossy:
  // 65,782 of the top 200,000 values below MAX_SAFE_INTEGER come back off by
  // 1-4 satoshis. Accepting them would mean broadcasting an amount the operator
  // never confirmed, defeating all the BigInt care above.
  const MAX = 2 ** 50;
  const atCap = parseVrscAmount('11258999.06842624');
  assert.strictEqual(atCap.ok, true, 'the cap itself is accepted');
  assert.strictEqual(atCap.sats, MAX);

  assert.strictEqual(parseVrscAmount('11258999.06842625').ok, false, 'one satoshi past the cap is refused');
  assert.strictEqual(parseVrscAmount('90071992.54740991').ok, false, 'MAX_SAFE_INTEGER is now past the cap');
  assert.strictEqual(parseVrscAmount('99999999999999999999').ok, false);

  // The property the cap exists to guarantee: everything we accept survives the
  // SDK's float handoff unchanged.
  for (const sats of [1, 13490000, 110000000, 869999999, MAX]) {
    assert.strictEqual(Math.round((sats / 1e8) * 1e8), sats, `${sats} must survive the SDK round-trip`);
  }
});

test('surrounding whitespace is trimmed, absurd lengths are refused outright', () => {
  assert.deepStrictEqual(parseVrscAmount('  1.5\n'), { ok: true, sats: 150000000 });
  assert.strictEqual(parseVrscAmount('1'.repeat(40)).ok, false);
});

// ---------------------------------------------------------------------------
// formatVrsc
// ---------------------------------------------------------------------------

test('formatVrsc pads to 8 decimals and round-trips with parseVrscAmount', () => {
  assert.strictEqual(formatVrsc(13490000), '0.13490000');
  assert.strictEqual(formatVrsc(100000000), '1.00000000');
  assert.strictEqual(formatVrsc(1), '0.00000001');
  assert.strictEqual(formatVrsc(0), '0.00000000');
  assert.strictEqual(formatVrsc(149990000), '1.49990000');

  for (const sats of [1, 13490000, 49990000, 100000000, 110000000, 870000000, 299990000, 2 ** 50]) {
    const round = parseVrscAmount(formatVrsc(sats));
    assert.strictEqual(round.ok, true, `${sats} must format to a parseable string`);
    assert.strictEqual(round.sats, sats, `${sats} must survive format→parse`);
  }
});

test('formatVrsc names an unknown value as unknown rather than as zero', () => {
  // A plausible-looking 0.00000000 for a value we do not actually have is how
  // an operator concludes a funded tank is empty and sends a second transfer.
  for (const bad of [NaN, Infinity, -Infinity, null, undefined, '13490000', 1.5, {}]) {
    assert.strictEqual(formatVrsc(bad), '—', `${String(bad)} must not render as a number`);
  }
});

test('formatVrsc uses integer math, not sats/1e8', () => {
  // 1e8 division is exact for these, but the large end is where a float would
  // start dropping satoshis.
  assert.strictEqual(formatVrsc(Number.MAX_SAFE_INTEGER), '90071992.54740991');
  assert.strictEqual(formatVrsc(-10000), '-0.00010000');
});

// ---------------------------------------------------------------------------
// buildWalletRow / summarizeFleet — the four live archetypes
// ---------------------------------------------------------------------------

test('classifies a healthy tank as ok', () => {
  // agent-2: 2.5 in the tank, nothing waiting at the i-address.
  const row = buildWalletRow({ agentId: 'agent-2', identity: 'codereview@', rAddress: R, iAddress: I, utxos: [rUtxo(250000000, 1)] });
  assert.strictEqual(row.feeSats, 250000000);
  assert.strictEqual(row.writes, 25000);
  assert.strictEqual(row.sweepableSats, 0);
  assert.strictEqual(row.sweepableCount, 0);
  assert.strictEqual(row.status, 'ok');
});

test('classifies a below-floor tank with earnings waiting as low', () => {
  // url2: 99 writes left, 0.4999 sitting at the i-address. Fixable by a sweep.
  const row = buildWalletRow({ agentId: 'url2', identity: 'url2@', rAddress: R, iAddress: I, utxos: [rUtxo(990000, 1), iUtxo(49990000, 2)] });
  assert.strictEqual(row.writes, 99);
  assert.strictEqual(row.sweepableSats, 49990000);
  assert.strictEqual(row.sweepableCount, 1);
  assert.strictEqual(row.status, 'low');
});

test('separates an agent that can self-fund from one that cannot', () => {
  // agent-11 has never earned: nothing at either address, so only an external
  // transfer or a `wallet send` unsticks it.
  const unfunded = buildWalletRow({ agentId: 'agent-11', identity: 'newbie@', rAddress: R, iAddress: I, utxos: [] });
  assert.strictEqual(unfunded.feeSats, 0);
  assert.strictEqual(unfunded.writes, 0);
  assert.strictEqual(unfunded.status, 'empty-unfunded');

  // agent-6 at zero while holding 27 unswept job payments: a sweep fixes it.
  const sweepable = buildWalletRow({ agentId: 'agent-6', identity: 'sumbot@', rAddress: R, iAddress: I, utxos: [iUtxo(13500000, 1)] });
  assert.strictEqual(sweepable.feeSats, 0);
  assert.strictEqual(sweepable.sweepableSats, 13500000);
  assert.strictEqual(sweepable.status, 'empty-sweepable');
});

test('an unregistered agent reports null balances, never a confident zero', () => {
  // No identity means no session, means we never called getUtxos. Reporting 0
  // would claim we looked.
  const row = buildWalletRow({ agentId: 'agent-12', registered: false, rAddress: R });
  assert.strictEqual(row.status, 'unregistered');
  assert.strictEqual(row.feeSats, null);
  assert.strictEqual(row.writes, null);
  assert.strictEqual(row.sweepableSats, null);
  assert.strictEqual(row.rAddress, R, 'the R-address is the whole point — it can still be funded');
});

test('the floor used for low/ok is the shared constant and is overridable', () => {
  const utxos = [rUtxo(DEFAULT_FLOOR_WRITES * FEE_SATS, 1)];
  assert.strictEqual(buildWalletRow({ agentId: 'a', rAddress: R, utxos }).status, 'ok', 'exactly at the floor is ok');
  assert.strictEqual(buildWalletRow({ agentId: 'a', rAddress: R, utxos: [rUtxo(DEFAULT_FLOOR_WRITES * FEE_SATS - 1, 1)] }).status, 'low');
  assert.strictEqual(buildWalletRow({ agentId: 'a', rAddress: R, utxos, floorWrites: 500 }).status, 'low');
});

test('string satoshis contribute nothing to a row, end to end', () => {
  // Delegated to summarizeUtxos, but pinned here because this is the layer an
  // operator reads: "0500000500000" printed as a balance is a fleet-wide lie.
  const row = buildWalletRow({
    agentId: 'a', rAddress: R, iAddress: I,
    utxos: [{ txid: 'a', vout: 0, address: I, satoshis: '500000' },
            { txid: 'b', vout: 1, address: R, satoshis: '500000' }],
  });
  assert.strictEqual(row.feeSats, 0);
  assert.strictEqual(row.sweepableSats, 0);
  assert.strictEqual(typeof row.feeSats, 'number');
  assert.strictEqual(row.status, 'empty-unfunded');
});

test('summarizeFleet totals are added as numbers and count every status', () => {
  const rows = [
    buildWalletRow({ agentId: 'agent-2', rAddress: R, utxos: [rUtxo(250000000, 1)] }),
    buildWalletRow({ agentId: 'url2', rAddress: R, iAddress: I, utxos: [rUtxo(990000, 1), iUtxo(49990000, 2)] }),
    buildWalletRow({ agentId: 'agent-11', rAddress: R, utxos: [] }),
    buildWalletRow({ agentId: 'agent-12', registered: false, rAddress: R }),
  ];
  const s = summarizeFleet(rows);
  assert.strictEqual(s.totalFeeSats, 250990000);
  assert.strictEqual(s.totalSweepableSats, 49990000);
  assert.strictEqual(typeof s.totalFeeSats, 'number');
  assert.deepStrictEqual(s.counts, { ok: 1, low: 1, empty: 1, unregistered: 1 });
});

test('summarizeFleet survives junk rows rather than producing a junk total', () => {
  const s = summarizeFleet([null, undefined, { status: 'ok', feeSats: '100', sweepableSats: NaN }, { status: 'ok', feeSats: 10000 }]);
  assert.strictEqual(s.totalFeeSats, 10000, 'a string balance must not be concatenated in');
  assert.strictEqual(s.totalSweepableSats, 0);
  assert.deepStrictEqual(summarizeFleet(null), { totalFeeSats: 0, totalSweepableSats: 0, counts: { ok: 0, low: 0, empty: 0, unregistered: 0 } });
});

// ---------------------------------------------------------------------------
// planManualSweep
// ---------------------------------------------------------------------------

test('sweeps a tank that is ABOVE the daemon floor — the operator asked', () => {
  // The one behavioural difference from planFeeSweep, which answers
  // 'above-floor' here. A manual command must not second-guess the operator.
  const p = planManualSweep({ feeSats: 250000000, sweepableSats: 13_500_000 });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.reason, 'manual-sweep');
  assert.strictEqual(p.amountSats, 13_490_000);
});

test('nets the tx fee out of the swept amount (live agent-6 sweep 4e4f3bf7)', () => {
  const p = planManualSweep({ feeSats: 0, sweepableSats: 13_500_000 });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.amountSats, 13_490_000);
});

test('nothing at the i-address is an external-funding alert, not a no-op', () => {
  const p = planManualSweep({ feeSats: 0, sweepableSats: 0 });
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, 'needs-external-funding');
  assert.strictEqual(p.amountSats, 0);
});

test('refuses a sweep that would spend a whole write to gain a whole write', () => {
  // At exactly 2x the fee the sweep nets one write and costs one: pointless.
  const at = planManualSweep({ feeSats: 0, sweepableSats: 2 * FEE_SATS });
  assert.strictEqual(at.ok, false);
  assert.strictEqual(at.reason, 'below-min-sweep');
  assert.strictEqual(planManualSweep({ feeSats: 0, sweepableSats: 2 * FEE_SATS - 1 }).ok, false);
  assert.strictEqual(planManualSweep({ feeSats: 0, sweepableSats: 2 * FEE_SATS + 1 }).ok, true, 'one satoshi of profit is enough');
});

test('never proposes a non-positive output even with the dust gate lowered', () => {
  const p = planManualSweep({ feeSats: 0, sweepableSats: FEE_SATS, minSweepSats: 1 });
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.amountSats, 0);
});

test('defers a manual sweep while a broadcast tx is still pending', () => {
  const pending = { txid: 'abc', at: 1_000_000 };
  const p = planManualSweep({ feeSats: 0, sweepableSats: 13_500_000, pending, now: 1_000_000 + 60_000 });
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, 'sweep-pending');
});

test('the pending gate releases exactly at the backstop boundary', () => {
  const at = 1_000_000;
  const args = { feeSats: 0, sweepableSats: 13_500_000, pending: { txid: 'x', at } };
  assert.strictEqual(planManualSweep({ ...args, now: at + SWEEP_PENDING_BACKSTOP_MS - 1 }).ok, false);
  assert.strictEqual(planManualSweep({ ...args, now: at + SWEEP_PENDING_BACKSTOP_MS }).ok, true);
});

test('a pending record with no usable timestamp fails CLOSED', () => {
  for (const bad of [{}, { txid: 'x' }, { txid: 'x', at: 'soon' }, { txid: 'x', at: NaN }, { txid: 'x', at: Infinity }]) {
    const p = planManualSweep({ feeSats: 0, sweepableSats: 13_500_000, pending: bad, now: 5_000_000 });
    assert.strictEqual(p.ok, false, `pending=${JSON.stringify(bad)} must defer`);
    assert.strictEqual(p.reason, 'sweep-pending');
  }
});

test('an unusable `now` against a real pending record also fails closed', () => {
  const p = planManualSweep({ feeSats: 0, sweepableSats: 13_500_000, pending: { txid: 'x', at: 1000 }, now: NaN });
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, 'sweep-pending');
});

test('refuses to decide a manual sweep on non-finite balances', () => {
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '100']) {
    const a = planManualSweep({ feeSats: bad, sweepableSats: 13_500_000 });
    assert.strictEqual(a.ok, false, `feeSats=${String(bad)} must not sweep`);
    assert.strictEqual(a.reason, 'invalid-balances');
    assert.strictEqual(planManualSweep({ feeSats: 0, sweepableSats: bad }).ok, false, `sweepableSats=${String(bad)}`);
  }
  assert.strictEqual(planManualSweep().ok, false, 'no arguments at all must not sweep');
});

// ---------------------------------------------------------------------------
// planFleetSend
// ---------------------------------------------------------------------------

const send = (over) => planFleetSend({ fromAgentId: 'agent-2', toAgentId: 'agent-11', ...over });

test('plans the live agent-2 → agent-11 transfer (tx aee19739 shape)', () => {
  const p = send({ feeSats: 250000000, amountSats: 100000000 });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.reason, 'ok');
  assert.strictEqual(p.sendSats, 100000000);
  assert.strictEqual(p.remainingSats, 149990000);
  assert.strictEqual(p.remainingWrites, 14999);
});

test('refuses a send the tank cannot cover, fee included', () => {
  assert.strictEqual(send({ feeSats: 100000000, amountSats: 100000000 }).reason, 'insufficient-funds',
    'the fee comes out of the source too');
  assert.strictEqual(send({ feeSats: 100000000 + FEE_SATS - 1, amountSats: 100000000 }).reason, 'insufficient-funds');
});

test('refuses to move the outage — a send may not drain the source below the reserve', () => {
  const p = send({ feeSats: 200 * FEE_SATS, amountSats: 150 * FEE_SATS });
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, 'below-reserve');
  assert.strictEqual(p.sendSats, 0, 'a refusal must carry no usable amount');
  assert.strictEqual(p.remainingSats, 0);
});

test('the reserve boundary allows exactly the reserve, refuses one write less', () => {
  // remaining = feeSats - amount - fee. Aim for exactly DEFAULT_FLOOR_WRITES.
  const reserveSats = DEFAULT_FLOOR_WRITES * FEE_SATS;
  const amount = 100000000;
  const atBoundary = send({ feeSats: amount + FEE_SATS + reserveSats, amountSats: amount });
  assert.strictEqual(atBoundary.ok, true, 'remaining === reserve is allowed');
  assert.strictEqual(atBoundary.remainingWrites, DEFAULT_FLOOR_WRITES);

  const under = send({ feeSats: amount + FEE_SATS + reserveSats - FEE_SATS, amountSats: amount });
  assert.strictEqual(under.ok, false);
  assert.strictEqual(under.reason, 'below-reserve');
});

test('--allow-drain overrides the reserve but never the balance', () => {
  const drained = send({ feeSats: 200 * FEE_SATS, amountSats: 150 * FEE_SATS, allowDrain: true });
  assert.strictEqual(drained.ok, true);
  assert.strictEqual(drained.remainingWrites, 49);

  // Exactly amount + fee === feeSats: allowed, leaves zero.
  const toZero = send({ feeSats: 100000000 + FEE_SATS, amountSats: 100000000, allowDrain: true });
  assert.strictEqual(toZero.ok, true);
  assert.strictEqual(toZero.remainingSats, 0);
  assert.strictEqual(toZero.remainingWrites, 0);

  // One satoshi past it: still refused. allowDrain is not a balance override.
  assert.strictEqual(send({ feeSats: 100000000 + FEE_SATS - 1, amountSats: 100000000, allowDrain: true }).ok, false);
});

test('the reserve is the shared floor constant and is overridable', () => {
  const args = { feeSats: 200 * FEE_SATS, amountSats: 150 * FEE_SATS };
  assert.strictEqual(send({ ...args }).ok, false, `default reserve is ${DEFAULT_FLOOR_WRITES} writes`);
  assert.strictEqual(send({ ...args, reserveWrites: 10 }).ok, true);
  assert.strictEqual(send({ ...args, reserveWrites: 1000 }).ok, false);
});

test('refuses a send to itself, and a send with a missing endpoint', () => {
  const self = planFleetSend({ fromAgentId: 'agent-2', toAgentId: 'agent-2', feeSats: 250000000, amountSats: 100000000 });
  assert.strictEqual(self.ok, false);
  assert.strictEqual(self.reason, 'self-send');

  for (const ids of [{ fromAgentId: null, toAgentId: 'agent-11' }, { fromAgentId: 'agent-2', toAgentId: '' }, {}]) {
    const p = planFleetSend({ feeSats: 250000000, amountSats: 100000000, ...ids });
    assert.strictEqual(p.ok, false, `${JSON.stringify(ids)} must be refused`);
    assert.strictEqual(p.reason, 'missing-agent-id');
  }
});

test('defers a send while a broadcast tx for the source is still pending', () => {
  const p = send({ feeSats: 250000000, amountSats: 100000000, pending: { txid: 'x', at: 1_000_000 }, now: 1_000_000 + 60_000 });
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, 'send-pending');

  // Malformed record fails closed, same as the sweep path.
  assert.strictEqual(send({ feeSats: 250000000, amountSats: 100000000, pending: { txid: 'x' }, now: 5_000_000 }).reason, 'send-pending');

  // And releases at the boundary.
  assert.strictEqual(send({ feeSats: 250000000, amountSats: 100000000, pending: { txid: 'x', at: 0 }, now: SWEEP_PENDING_BACKSTOP_MS }).ok, true);
});

test('a send fails closed on unusable numbers instead of falling through', () => {
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '250000000']) {
    const p = send({ feeSats: bad, amountSats: 100000000 });
    assert.strictEqual(p.ok, false, `feeSats=${String(bad)}`);
    assert.strictEqual(p.reason, 'invalid-balances');
  }
  for (const bad of [NaN, Infinity, undefined, null, '100000000', 0, -1, 1.5, 110000000.00000001]) {
    const p = send({ feeSats: 250000000, amountSats: bad });
    assert.strictEqual(p.ok, false, `amountSats=${String(bad)}`);
    assert.strictEqual(p.reason, 'invalid-amount');
  }
  assert.strictEqual(planFleetSend().ok, false, 'no arguments at all must not send');
});

test('parseVrscAmount feeds planFleetSend without a float in between', () => {
  const parsed = parseVrscAmount('1.1'); // the float-hazard value, end to end
  assert.strictEqual(parsed.ok, true);
  const p = send({ feeSats: 250000000, amountSats: parsed.sats });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.sendSats, 110000000);
  assert.strictEqual(p.remainingSats, 250000000 - 110000000 - FEE_SATS);
  assert.strictEqual(formatVrsc(p.sendSats), '1.10000000');
});

// ---------------------------------------------------------------------------
// executeSend — the inverse invariant
// ---------------------------------------------------------------------------

const okBuild = () => 'aa00ff';
const okBroadcast = async () => ({ txid: 'sent-txid' });
const baseSend = () => ({
  buildPayment: okBuild, broadcast: okBroadcast,
  wif: 'W', network: 'verustest', rAddress: R, toAddress: R2,
  utxos: [rUtxo(250000000, 1)], amountSats: 100000000,
});

test('sends R-address inputs to the destination R-address', async () => {
  let seen;
  const r = await executeSend({ ...baseSend(), buildPayment: (p) => { seen = p; return okBuild(); } });
  assert.strictEqual(r.sent, true);
  assert.strictEqual(r.txid, 'sent-txid');
  assert.strictEqual(r.amountSats, 100000000);
  assert.strictEqual(r.inputs, 1);
  assert.strictEqual(seen.toAddress, R2, 'toAddress must be exactly what was passed');
  assert.strictEqual(seen.amount, 1, 'buildPayment takes VRSC, not satoshis');
});

// The mirror of fee-tank.test.js:130 — that executor refuses R-address inputs,
// this one refuses everything else. Together: i-address earnings reach the
// R-address only via a sweep, and a send spends only the tank.
test('REFUSES an i-address input — earnings leave the i-address only by sweep', async () => {
  const r = await executeSend({ ...baseSend(), utxos: [rUtxo(250000000, 1), iUtxo(13500000, 2)] });
  assert.strictEqual(r.sent, false);
  assert.match(r.reason, /non-R|R-address/);
});

test('REFUSES an address-less input rather than assuming it is the tank', async () => {
  // summarizeUtxos counts a missing address as fee-payable, which is safe for
  // COUNTING. Spending on that assumption is not.
  const r = await executeSend({ ...baseSend(), utxos: [{ txid: 'a', vout: 0, satoshis: 250000000 }] });
  assert.strictEqual(r.sent, false);
  assert.match(r.reason, /non-R|R-address/);
});

test('refuses a null entry in the utxo set', async () => {
  const r = await executeSend({ ...baseSend(), utxos: [rUtxo(250000000, 1), null] });
  assert.strictEqual(r.sent, false);
  assert.match(r.reason, /non-R|R-address/);
});

test('refuses to pay a fee to send to itself', async () => {
  const r = await executeSend({ ...baseSend(), toAddress: R });
  assert.strictEqual(r.sent, false);
  assert.match(r.reason, /source address/);
});

test('forwards wif, network, fee and the exact utxo set to the builder', async () => {
  let seen;
  await executeSend({
    ...baseSend(),
    buildPayment: (p) => { seen = p; return 'aa'; },
    utxos: [rUtxo(150000000, 1), rUtxo(100000000, 2)],
  });
  assert.strictEqual(seen.wif, 'W');
  assert.strictEqual(seen.network, 'verustest');
  assert.strictEqual(seen.fee, FEE_SATS, 'fee must be passed in satoshis');
  assert.strictEqual(seen.utxos.length, 2, 'must spend exactly the set it was given');
});

test('an overridden tx fee reaches the builder', async () => {
  let seen;
  await executeSend({ ...baseSend(), buildPayment: (p) => { seen = p; return 'aa'; }, txFeeSats: 20000 });
  assert.strictEqual(seen.fee, 20000);
});

test('a rejected broadcast is reported, not thrown — one agent must not break the loop', async () => {
  const r = await executeSend({
    ...baseSend(),
    broadcast: async () => { throw Object.assign(new Error('bad-txns'), { detail: '-26' }); },
  });
  assert.strictEqual(r.sent, false);
  assert.match(r.reason, /broadcast rejected/);
  assert.strictEqual(r.detail, '-26', 'the daemon\'s reason is the only clue an operator gets');
});

test('a throwing builder is reported, not thrown', async () => {
  const r = await executeSend({ ...baseSend(), buildPayment: () => { throw new Error('cannot sign'); } });
  assert.strictEqual(r.sent, false);
  assert.match(r.reason, /build failed/);
});

test('a broadcast that returns no txid is a failure, not a silent success', async () => {
  for (const res of [{}, null, { txid: null }, { txid: '' }]) {
    const r = await executeSend({ ...baseSend(), broadcast: async () => res });
    assert.strictEqual(r.sent, false, `broadcast → ${JSON.stringify(res)} must not report success`);
  }
});

test('missing dependencies fail closed rather than half-executing', async () => {
  const base = baseSend();
  assert.strictEqual((await executeSend({ ...base, buildPayment: null })).sent, false);
  assert.strictEqual((await executeSend({ ...base, broadcast: null })).sent, false);
  assert.strictEqual((await executeSend({ ...base, wif: null })).sent, false);
  assert.strictEqual((await executeSend({ ...base, rAddress: null })).sent, false);
  assert.strictEqual((await executeSend({ ...base, toAddress: null })).sent, false);
  assert.strictEqual((await executeSend({ ...base, utxos: [] })).sent, false);
  assert.strictEqual((await executeSend({ ...base, utxos: null })).sent, false);
  assert.strictEqual((await executeSend({ ...base, amountSats: 0 })).sent, false);
  assert.strictEqual((await executeSend({ ...base, amountSats: NaN })).sent, false);
});

test('a refused send never reaches the builder or the network', async () => {
  let built = 0;
  let broadcast = 0;
  const spy = { buildPayment: () => { built += 1; return 'aa'; }, broadcast: async () => { broadcast += 1; return { txid: 't' }; } };
  await executeSend({ ...baseSend(), ...spy, utxos: [iUtxo(13500000, 1)] });
  await executeSend({ ...baseSend(), ...spy, toAddress: R });
  await executeSend({ ...baseSend(), ...spy, amountSats: -1 });
  assert.strictEqual(built, 0, 'nothing may be signed');
  assert.strictEqual(broadcast, 0, 'nothing may be broadcast');
});


// ---------------------------------------------------------------------------
// resolveOwnRAddress — the destination must come from OUR key (audit B1).
//
// The sweep previously took its destination as `u.address || keys.address`,
// PREFERRING the platform's getUtxos() response over the key material we hold.
// summarizeUtxos decides what is sweepable by comparing against that value, so a
// wrong address reclassifies EVERY utxo — R and i alike — as sweepable, the
// executor's guard passes because nothing matches, and the whole balance is
// signed away. The daemon auto-broadcasts that with no prompt.
//
// The existing tests could not catch it: their stub returned the same address the
// keys held, so key-derived and platform-supplied were indistinguishable. These
// deliberately make them DIFFER.
// ---------------------------------------------------------------------------

const OTHER = 'RAttackerAddressXXXXXXXXXXXXXXXXXX';

test('accepts when the platform corroborates our derived address', () => {
  const r = resolveOwnRAddress({ derived: R, platformAddress: R, agentId: 'agent-6' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.rAddress, R);
});

test('accepts when the platform says nothing — our key is authoritative', () => {
  for (const absent of [null, undefined, '']) {
    const r = resolveOwnRAddress({ derived: R, platformAddress: absent, agentId: 'agent-6' });
    assert.strictEqual(r.ok, true, `platformAddress=${String(absent)}`);
    assert.strictEqual(r.rAddress, R, 'must use the derived address, never the absent one');
  }
});

test('REFUSES when the platform disputes our derived address', () => {
  const r = resolveOwnRAddress({ derived: R, platformAddress: OTHER, agentId: 'agent-6' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /disputed address/);
  assert.match(r.error, /agent-6/);
  assert.ok(r.rAddress === undefined, 'must not hand back an address it refused');
});

test('REFUSES the reverse-sweep case: platform returns the i-address', () => {
  // The benign-bug variant. Without this the sweep runs backwards, draining the
  // fee tank into the i-address and recreating the outage the sweep prevents.
  const r = resolveOwnRAddress({ derived: R, platformAddress: I, agentId: 'agent-6' });
  assert.strictEqual(r.ok, false);
});

test('REFUSES when we cannot derive an address at all', () => {
  for (const bad of [null, undefined, '', 0, {}]) {
    const r = resolveOwnRAddress({ derived: bad, platformAddress: R, agentId: 'agent-6' });
    assert.strictEqual(r.ok, false, `derived=${JSON.stringify(bad)}`);
    assert.match(r.error, /cannot derive/);
  }
});

test('the refusal is what stops the drain: a disputed address never reaches summarizeUtxos', () => {
  // Demonstrates the actual exploit this guard blocks. With the attacker address,
  // summarizeUtxos reclassifies the ENTIRE balance as sweepable.
  const utxos = [
    { txid: 'a', vout: 0, address: R, satoshis: 1_099_320_000 },
    { txid: 'b', vout: 1, address: I, satoshis: 50_000_000 },
  ];
  const honest = summarizeUtxos(utxos, R);
  assert.strictEqual(honest.sweepableSats, 50_000_000, 'only the i-address output is sweepable');

  const spoofed = summarizeUtxos(utxos, OTHER);
  assert.strictEqual(spoofed.sweepableSats, 1_149_320_000, 'proof of the hazard: everything becomes sweepable');

  // ...which is exactly why the address must never get that far.
  assert.strictEqual(resolveOwnRAddress({ derived: R, platformAddress: OTHER }).ok, false);
});
