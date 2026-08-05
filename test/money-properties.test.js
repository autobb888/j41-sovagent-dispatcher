'use strict';
/**
 * Property tests for the money layer.
 *
 * The example-based suites pin the cases we thought of. This one attacks the
 * cases we did not: tens of thousands of randomised and adversarial inputs
 * asserting the INVARIANTS rather than specific outputs.
 *
 * Every function here decides whether real, irreversible value moves. The bar
 * is not "handles the happy path" — it is "cannot be made to throw, and cannot
 * be made to authorise something it should refuse, by ANY input".
 *
 * Deterministic: a seeded PRNG, so a failure is reproducible from the seed
 * printed in the assertion message. No Math.random.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseVrscAmount, formatVrsc, resolveOwnRAddress,
  buildWalletRow, summarizeFleet, planManualSweep, planFleetSend, executeSend,
} = require('../src/wallet.js');
const {
  summarizeUtxos, writesAffordable, planFeeSweep, executeFeeSweep, FEE_SATS,
} = require('../src/fee-tank.js');
const { classifyInboxFailure, isFundingFailure } = require('../src/inbox-deadletter.js');

// ── deterministic PRNG (mulberry32) ────────────────────────────────────────
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Values chosen to break naive numeric code. */
const HOSTILE = [
  0, -0, 1, -1, 0.5, -0.5, NaN, Infinity, -Infinity,
  Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Number.MAX_VALUE, Number.EPSILON,
  2 ** 50, 2 ** 53, 1e21, -1e21,
  '0', '1', '1e3', '0x10', '  7  ', '', '.', '-', 'NaN', 'Infinity', 'null',
  null, undefined, true, false, {}, [], [1], { satoshis: 1 }, () => {}, Symbol.iterator,
  '9007199254740993', '00000001', '1_000',
];

const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const R = 'RWoeXSRs4WHQYauzUg6bPowNyBRsz5bW51';
const I = 'i9j8RkZcqmdU8gMiTHvggtRAdwv4Q3VWJf';
const ADDRS = [R, I, 'RSomeOther', '', null, undefined, 0, {}, R.toLowerCase()];

function randomUtxo(r) {
  return {
    txid: pick(r, ['a'.repeat(64), '', null, 42]),
    vout: pick(r, [0, 1, -1, null, '0']),
    address: pick(r, ADDRS),
    satoshis: pick(r, HOSTILE.concat([500000, 10000, 13490000])),
    script: pick(r, ['aa', '', null, undefined]),
  };
}

// ---------------------------------------------------------------------------
// parseVrscAmount / formatVrsc
// ---------------------------------------------------------------------------

test('property: parseVrscAmount never throws, and an accepted amount is always a safe positive integer', () => {
  const r = rng(0xC0FFEE);
  for (let i = 0; i < 20000; i++) {
    const input = i < HOSTILE.length ? HOSTILE[i]
      : pick(r, [
        String(Math.floor(r() * 1e9)),
        `${Math.floor(r() * 1e6)}.${Math.floor(r() * 1e8)}`,
        `${'9'.repeat(1 + Math.floor(r() * 25))}`,
        String.fromCharCode(...Array.from({ length: 1 + Math.floor(r() * 6) }, () => 32 + Math.floor(r() * 95))),
      ]);
    let out;
    assert.doesNotThrow(() => { out = parseVrscAmount(input); }, `threw on ${JSON.stringify(String(input))}`);
    assert.equal(typeof out.ok, 'boolean');
    if (out.ok) {
      assert.ok(Number.isSafeInteger(out.sats), `sats not a safe integer for ${JSON.stringify(input)}`);
      assert.ok(out.sats > 0, `accepted a non-positive amount for ${JSON.stringify(input)}`);
      // The property the whole module exists for: what we accept survives the
      // SDK's float handoff (amountSats/1e8 -> Math.round(x*1e8)) unchanged.
      assert.equal(Math.round((out.sats / 1e8) * 1e8), out.sats,
        `accepted ${JSON.stringify(input)} (${out.sats} sat) that the SDK round-trip would alter`);
    } else {
      assert.equal(out.sats, 0, 'a refusal must not carry an amount');
    }
  }
});

test('property: formatVrsc never throws and always round-trips through parseVrscAmount', () => {
  const r = rng(0xBEEF);
  for (let i = 0; i < 10000; i++) {
    const sats = i < HOSTILE.length ? HOSTILE[i] : Math.floor(r() * 2 ** 50);
    let s;
    assert.doesNotThrow(() => { s = formatVrsc(sats); }, `threw on ${String(sats)}`);
    assert.equal(typeof s, 'string');
    if (Number.isSafeInteger(sats) && sats > 0 && sats <= 2 ** 50) {
      const back = parseVrscAmount(s);
      assert.ok(back.ok, `formatVrsc(${sats}) -> ${s} did not re-parse`);
      assert.equal(back.sats, sats, `round-trip changed ${sats} -> ${back.sats}`);
    }
    if (!Number.isInteger(sats)) {
      assert.equal(s, '—', `non-integer ${String(sats)} must render as unknown, not a plausible number`);
    }
  }
});

// ---------------------------------------------------------------------------
// summarizeUtxos — the R/i split everything else trusts
// ---------------------------------------------------------------------------

test('property: summarizeUtxos never throws and produces finite, non-negative, disjoint buckets', () => {
  const r = rng(0xD15EA5E);
  for (let i = 0; i < 8000; i++) {
    const utxos = Array.from({ length: Math.floor(r() * 6) }, () => randomUtxo(r));
    const rAddr = pick(r, ADDRS);
    let s;
    assert.doesNotThrow(() => { s = summarizeUtxos(utxos, rAddr); }, 'summarizeUtxos threw');
    for (const k of ['feeSats', 'sweepableSats']) {
      assert.ok(Number.isFinite(s[k]) && s[k] >= 0 && Number.isInteger(s[k]),
        `${k} must be a finite non-negative integer, got ${s[k]}`);
    }
    // No UTXO may be counted in both buckets — that would double-spend on paper.
    const both = s.feeUtxos.filter(u => s.sweepableUtxos.includes(u));
    assert.equal(both.length, 0, 'a UTXO appeared in both buckets');
    // Totals must equal the sum of their own bucket, never a string concatenation.
    const sum = (arr) => arr.reduce((n, u) => n + u.satoshis, 0);
    assert.equal(s.feeSats, sum(s.feeUtxos));
    assert.equal(s.sweepableSats, sum(s.sweepableUtxos));
  }
});

test('property: writesAffordable is never negative or fractional', () => {
  const r = rng(0x5EED);
  for (let i = 0; i < 5000; i++) {
    const sats = i < HOSTILE.length ? HOSTILE[i] : Math.floor(r() * 1e12) * (r() < 0.1 ? -1 : 1);
    const w = writesAffordable(sats);
    assert.ok(Number.isInteger(w) || Number.isNaN(w), `non-integer writes for ${String(sats)}`);
    if (Number.isFinite(sats) && sats >= 0) assert.ok(w >= 0, `negative writes for ${sats}`);
  }
});

// ---------------------------------------------------------------------------
// The planners — an approval must always be arithmetically safe
// ---------------------------------------------------------------------------

test('property: planFleetSend never approves a send it cannot fund, and never overspends the reserve', () => {
  const r = rng(0xFEE15);
  for (let i = 0; i < 20000; i++) {
    const feeSats = pick(r, HOSTILE.concat([0, 10000, 1e8, Math.floor(r() * 1e10)]));
    const amountSats = pick(r, HOSTILE.concat([1, 10000, Math.floor(r() * 1e10)]));
    const reserveWrites = pick(r, [undefined, 0, 100, -5, NaN, Math.floor(r() * 1000)]);
    const allowDrain = r() < 0.5;
    let p;
    assert.doesNotThrow(() => {
      p = planFleetSend({
        feeSats, amountSats, reserveWrites, allowDrain,
        fromAgentId: 'a', toAgentId: pick(r, ['a', 'b']),
        pending: pick(r, [null, {}, { txid: 'x', at: 0 }, { txid: 'x', at: NaN }]),
        now: pick(r, [0, 1e12, NaN]),
      });
    }, 'planFleetSend threw');
    assert.equal(typeof p.ok, 'boolean');
    if (!p.ok) continue;
    // Everything below only applies to an APPROVAL.
    assert.ok(Number.isSafeInteger(p.sendSats) && p.sendSats > 0, `approved a bad amount ${p.sendSats}`);
    assert.ok(Number.isSafeInteger(feeSats), 'approved against a non-integer balance');
    assert.ok(p.sendSats + FEE_SATS <= feeSats, 'approved a send the tank cannot fund');
    assert.ok(Number.isSafeInteger(p.remainingSats) && p.remainingSats >= 0, 'approved a negative remainder');
    assert.equal(p.remainingSats, feeSats - p.sendSats - FEE_SATS, 'remainder arithmetic disagrees');
    assert.notEqual('a', p.toAgentId, 'approved a self-send');
  }
});

test('property: planManualSweep never approves more than the sweepable set can cover', () => {
  const r = rng(0x5EE9);
  for (let i = 0; i < 20000; i++) {
    const feeSats = pick(r, HOSTILE.concat([0, Math.floor(r() * 1e10)]));
    const sweepableSats = pick(r, HOSTILE.concat([0, 10000, 13500000, Math.floor(r() * 1e10)]));
    let p;
    assert.doesNotThrow(() => {
      p = planManualSweep({
        feeSats, sweepableSats,
        pending: pick(r, [null, {}, { txid: 'x', at: 0 }]),
        now: pick(r, [0, 1e12, NaN]),
      });
    }, 'planManualSweep threw');
    if (!p.ok) continue;
    assert.ok(Number.isSafeInteger(p.amountSats) && p.amountSats > 0, `approved a bad amount ${p.amountSats}`);
    assert.ok(p.amountSats <= sweepableSats - FEE_SATS, 'approved sweeping more than exists');
  }
});

test('property: planFeeSweep (the unattended daemon path) is equally unbreakable', () => {
  const r = rng(0xDA3E01);
  for (let i = 0; i < 20000; i++) {
    const feeSats = pick(r, HOSTILE.concat([0, Math.floor(r() * 1e10)]));
    const sweepableSats = pick(r, HOSTILE.concat([0, Math.floor(r() * 1e10)]));
    let p;
    assert.doesNotThrow(() => {
      p = planFeeSweep({
        feeSats, sweepableSats,
        floorWrites: pick(r, [undefined, 0, 100, NaN]),
        pending: pick(r, [null, {}, { txid: 'x', at: 0 }]),
        now: pick(r, [0, 1e12, NaN]),
      });
    }, 'planFeeSweep threw');
    if (!p.sweep) continue;
    assert.ok(Number.isSafeInteger(p.amountSats) && p.amountSats > 0);
    assert.ok(p.amountSats <= sweepableSats - FEE_SATS, 'daemon approved sweeping more than exists');
  }
});

// ---------------------------------------------------------------------------
// The executors — the address-class invariant under ANY input
// ---------------------------------------------------------------------------

test('property: executeSend NEVER signs or broadcasts a non-R-address input', async () => {
  const r = rng(0x5AFE);
  for (let i = 0; i < 3000; i++) {
    const utxos = Array.from({ length: 1 + Math.floor(r() * 4) }, () => randomUtxo(r));
    let built = false, cast = false;
    const res = await executeSend({
      buildPayment: () => { built = true; return 'aa'; },
      broadcast: async () => { cast = true; return { txid: 'x' }; },
      wif: 'W', network: 'verustest', rAddress: R,
      toAddress: pick(r, [R, 'RDest', null]),
      utxos, amountSats: pick(r, [1, 100000, NaN, -1]),
    });
    const hasForeign = utxos.some(u => !u || !u.address || u.address !== R);
    if (hasForeign) {
      assert.equal(res.sent, false, 'sent despite a foreign input');
      assert.equal(built, false, 'SIGNED a transaction containing a foreign input');
      assert.equal(cast, false, 'BROADCAST a transaction containing a foreign input');
    }
  }
});

test('property: executeFeeSweep NEVER signs or broadcasts an R-address input', async () => {
  const r = rng(0x7A2C);
  for (let i = 0; i < 3000; i++) {
    const utxos = Array.from({ length: 1 + Math.floor(r() * 4) }, () => randomUtxo(r));
    let built = false, cast = false;
    await executeFeeSweep({
      buildPayment: () => { built = true; return 'aa'; },
      broadcast: async () => { cast = true; return { txid: 'x' }; },
      wif: 'W', network: 'verustest', rAddress: R,
      sweepableUtxos: utxos, amountSats: pick(r, [1, 100000, NaN]),
    });
    const hasTankInput = utxos.some(u => !u || !u.address || u.address === R);
    if (hasTankInput) {
      assert.equal(built, false, 'SIGNED a sweep that spends the fee tank');
      assert.equal(cast, false, 'BROADCAST a sweep that spends the fee tank');
    }
  }
});

test('property: resolveOwnRAddress only ever returns an address we derived ourselves', () => {
  const r = rng(0xADD8);
  for (let i = 0; i < 8000; i++) {
    const derived = pick(r, ADDRS);
    const platformAddress = pick(r, ADDRS);
    let out;
    assert.doesNotThrow(() => { out = resolveOwnRAddress({ derived, platformAddress, agentId: 'a' }); });
    if (!out.ok) { assert.equal(out.rAddress, undefined); continue; }
    assert.equal(out.rAddress, derived, 'returned an address that was not the derived one');
    assert.ok(typeof derived === 'string' && derived.length > 0);
    if (platformAddress) assert.equal(platformAddress, derived, 'accepted a disputed address');
  }
});

// ---------------------------------------------------------------------------
// Fleet rendering — null must never become zero
// ---------------------------------------------------------------------------

test('property: buildWalletRow/summarizeFleet never turn "unknown" into a number', () => {
  const r = rng(0xB0A5);
  for (let i = 0; i < 5000; i++) {
    const registered = r() < 0.5;
    let row;
    assert.doesNotThrow(() => {
      row = buildWalletRow({
        agentId: 'a', identity: pick(r, ['x@', null]), registered,
        rAddress: pick(r, ADDRS), iAddress: pick(r, ADDRS),
        utxos: Array.from({ length: Math.floor(r() * 4) }, () => randomUtxo(r)),
        floorWrites: pick(r, [undefined, 0, 100, NaN]),
      });
    }, 'buildWalletRow threw');
    if (!registered) {
      for (const k of ['feeSats', 'writes', 'sweepableSats']) {
        assert.equal(row[k], null, `${k} must be null for an unqueried agent, got ${row[k]}`);
      }
    }
    let fleet;
    assert.doesNotThrow(() => { fleet = summarizeFleet([row, row]); }, 'summarizeFleet threw');
    assert.ok(Number.isFinite(fleet.totalFeeSats) && fleet.totalFeeSats >= 0);
    assert.ok(Number.isFinite(fleet.totalSweepableSats) && fleet.totalSweepableSats >= 0);
  }
});

// ---------------------------------------------------------------------------
// Failure classification — the gate on the dead-letter budget
// ---------------------------------------------------------------------------

test('property: classifyInboxFailure always returns one of three classes and never throws', () => {
  const r = rng(0xC1A55);
  const WORDS = ['no spendable', 'insufficient funds', 'failed-precheck', 'timed out', 'already spent',
    'bad-txns-inputs', 'ECONNRESET', 'signature', 'nope', ''];
  for (let i = 0; i < 10000; i++) {
    const e = pick(r, [
      null, undefined, 'a string', 42, {},
      new Error(pick(r, WORDS)),
      Object.assign(new Error(pick(r, WORDS)), { code: pick(r, ['TX_REJECTED', undefined, 42]) }),
      Object.assign(new Error(pick(r, WORDS)), { statusCode: pick(r, [400, 429, 500, 503, NaN, '500']) }),
      Object.assign(new Error(pick(r, WORDS)), { code: 'TX_REJECTED', detail: pick(r, WORDS.concat([null, 42])) }),
    ]);
    let c;
    assert.doesNotThrow(() => { c = classifyInboxFailure(e); }, 'classifyInboxFailure threw');
    assert.ok(['contention', 'transient', 'hard'].includes(c), `bad class ${c}`);
    assert.doesNotThrow(() => { isFundingFailure(e); }, 'isFundingFailure threw');
    // A funding failure must never be allowed to strike an item.
    if (isFundingFailure(e)) assert.notEqual(c, 'hard', 'a dry wallet was classified as the item\'s fault');
  }
});
