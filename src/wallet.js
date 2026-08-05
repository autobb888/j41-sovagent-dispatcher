'use strict';
/**
 * Fleet wallet — the decision layer behind the manual `wallet` command.
 *
 * `fee-tank.js` is the DAEMON's answer to the two-address problem (payments land
 * at the i-address, fees debit only the R-address, so the tank strictly drains).
 * This module is the OPERATOR's answer to the same problem, for the cases the
 * daemon cannot fix by itself:
 *
 *   - agent-6 hit zero and stopped writing on-chain while holding 27 unswept job
 *     payments. The daemon's sweep now handles that, but an operator still needs
 *     to force one out of band ("sweep now, I am watching the chain").
 *   - agent-11 had never earned anything. Nothing at either address, so there is
 *     nothing to sweep — only a transfer from an agent that HAS earned unsticks
 *     it. That transfer was done by hand; this is that operation, with guards.
 *
 * Two invariants are enforced in code, and together they mean a bug in the CLI
 * cannot move money out of the fleet:
 *
 *   1. `executeFeeSweep` (fee-tank.js) refuses R-address inputs — i-address
 *      earnings move ONLY toward the agent's own R-address.
 *   2. `executeSend` (here) refuses everything that is NOT an R-address input,
 *      address-less UTXOs included — a send spends ONLY tank funds.
 *
 * Deliberately NOT here: sending to an arbitrary address. Every incident settled
 * by hand was fleet-internal, and the one failure mode that actually loses money
 * is a typo'd destination on an irreversible transaction. `send` resolves a
 * fleet agent-id to that agent's own R-address; raw addresses are refused at the
 * CLI layer. Buyer payouts already have a hardened path (`refunds` +
 * `financial-allowlist.json`).
 *
 * Pure over caller-supplied numbers: no fs, no network, no SDK, no clock — `now`
 * is a parameter. The one impure function takes every dependency explicitly, so
 * a free variable is impossible by construction. Nothing here throws.
 */

const {
  FEE_SATS,
  DEFAULT_FLOOR_WRITES,
  SWEEP_PENDING_BACKSTOP_MS,
  summarizeUtxos,
  writesAffordable,
} = require('./fee-tank.js');

/** Satoshis in one coin. Integer, and used only as a BigInt below. */
const SATS_PER_COIN = 100000000n;

/** Money strings are short. Anything longer is malformed, not a big number. */
const MAX_AMOUNT_STRING = 32;

/** Largest amount accepted, in satoshis (2^50 ≈ 11.26M VRSC). See parseVrscAmount. */
const MAX_AMOUNT_SATS = 2 ** 50;

// ---------------------------------------------------------------------------
// Amount parsing — the one place a human string becomes satoshis
// ---------------------------------------------------------------------------

/**
 * Parse a decimal VRSC string into integer satoshis.
 *
 * NEVER `parseFloat(x) * 1e8`. Binary floating point cannot represent most
 * decimal fractions, so that multiplication silently yields a non-integer for
 * ordinary amounts a person would type: `1.1 * 1e8` is 110000000.00000001 and
 * `8.7 * 1e8` is 869999999.9999999. Whichever way the caller then rounds, it is
 * rounding money it was never asked to round. (Many values ARE exact — 0.1349,
 * 2.9999, 0.4999 — which is exactly what makes the bug survive testing.)
 *
 * So: match the string, then do integer math on the digits with BigInt.
 *
 * Strict by design, because this is the input to an irreversible transaction:
 * no exponent notation, no sign, no thousands separators, no bare `.5`, at most
 * 8 decimal places (a 9th would have to be rounded away), and the result must
 * fit in a JS safe integer so every downstream `+` stays exact.
 *
 * Returns { ok: true, sats } | { ok: false, error, sats: 0 }.
 */
function parseVrscAmount(input) {
  // Only strings. A number argument has ALREADY been through the float path
  // that this function exists to avoid, so accepting one would launder the bug.
  if (typeof input !== 'string') {
    return { ok: false, error: 'amount must be a decimal string', sats: 0 };
  }
  const s = input.trim();
  if (!s) return { ok: false, error: 'amount is empty', sats: 0 };
  if (s.length > MAX_AMOUNT_STRING) {
    return { ok: false, error: 'amount is too long to be a real amount', sats: 0 };
  }

  // Digits, optionally a dot and 1-8 more digits. Rejects '', '.', '1.', '.5',
  // '-1', '+1', '1e3', 'NaN', 'Infinity', '1,5', '0x10' and '1.000000001'.
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(s);
  if (!m) {
    return { ok: false, error: `not a plain decimal amount: ${input}`, sats: 0 };
  }

  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] || '').padEnd(8, '0'));
  const sats = whole * SATS_PER_COIN + frac;

  if (sats === 0n) {
    return { ok: false, error: 'amount must be greater than zero', sats: 0 };
  }
  // Cap well below MAX_SAFE_INTEGER, for two compounding reasons.
  //
  // 1. Past MAX_SAFE_INTEGER plain `+` on satoshis stops being exact, and every
  //    plan function below adds a fee to an amount.
  // 2. More subtly (audit S3): we hand `amountSats / 1e8` to the SDK, which does
  //    `Math.round(amount * 1e8)` to get back to satoshis. That round-trip is NOT
  //    exact near the top of the range — measured, 65,782 of the top 200,000
  //    values below MAX_SAFE_INTEGER come back off by 1-4 satoshis. All the BigInt
  //    care above is defeated if the broadcast amount can differ from the amount
  //    the operator confirmed.
  //
  // 2^50 sats is ~11.26M VRSC — orders of magnitude beyond any agent transfer,
  // and comfortably inside the range where the float round-trip is exact.
  if (sats > MAX_AMOUNT_SATS) {
    return { ok: false, error: `amount exceeds the maximum supported value (${MAX_AMOUNT_SATS} sat)`, sats: 0 };
  }

  return { ok: true, sats: Number(sats) };
}

/**
 * Render integer satoshis as a fixed 8-decimal string.
 *
 * BigInt division and a padded remainder, so the printed number is the stored
 * number — `sats / 1e8` would reintroduce the float on the display side, where
 * an operator reads it and decides whether to press y.
 *
 * A value that is not an integer number of satoshis is NOT money we can name:
 * it returns the em dash the fleet table uses for "unknown", never a plausible
 * looking zero.
 */
function formatVrsc(sats) {
  if (typeof sats !== 'number' || !Number.isFinite(sats) || !Number.isInteger(sats)) return '—';
  const neg = sats < 0;
  const v = BigInt(Math.abs(sats));
  const whole = v / SATS_PER_COIN;
  const frac = (v % SATS_PER_COIN).toString().padStart(8, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

// ---------------------------------------------------------------------------
// Fleet view
// ---------------------------------------------------------------------------

/**
 * One row of `wallet list`, derived entirely from `summarizeUtxos`.
 *
 * `registered: false` means the agent has no identity, so it cannot
 * authenticate and we never got a UTXO view for it. Its balances are `null`,
 * not `0`: zero is "we looked and the tank is empty", null is "we could not
 * look", and telling an operator a funded agent is empty is how a second
 * transfer gets sent.
 *
 * status:
 *   'unregistered'    — no identity; fund the R-address externally
 *   'empty-unfunded'  — nothing at either address; only an external transfer helps
 *   'empty-sweepable' — tank at zero but earnings are sitting at the i-address
 *   'low'             — below the floor; still able to write, for now
 *   'ok'              — at or above the floor
 */
function buildWalletRow({
  agentId,
  identity = null,
  registered = true,
  rAddress = null,
  iAddress = null,
  utxos = [],
  floorWrites = DEFAULT_FLOOR_WRITES,
  txFeeSats = FEE_SATS,
} = {}) {
  const base = { agentId: agentId || null, identity: identity || null, rAddress: rAddress || null, iAddress: iAddress || null };

  if (!registered) {
    return {
      ...base,
      feeSats: null,
      writes: null,
      sweepableSats: null,
      sweepableCount: null,
      status: 'unregistered',
    };
  }

  const s = summarizeUtxos(utxos, rAddress);
  const writes = writesAffordable(s.feeSats, txFeeSats);

  let status;
  if (s.feeSats <= 0) {
    // Cannot write at all right now. Which of the two fixes applies depends on
    // whether the agent has ever earned, so they are separate statuses.
    status = s.sweepableSats > 0 ? 'empty-sweepable' : 'empty-unfunded';
  } else if (writes < floorWrites) {
    status = 'low';
  } else {
    status = 'ok';
  }

  return {
    ...base,
    feeSats: s.feeSats,
    writes,
    sweepableSats: s.sweepableSats,
    sweepableCount: s.sweepableUtxos.length,
    status,
  };
}

/**
 * Fleet totals. Adds only values that are actually numbers — a string satoshi
 * that reached a row would otherwise turn `+` into concatenation and report a
 * hundredth of a coin as thousands (the `summarizeUtxos` lesson, one layer up).
 * Unregistered rows carry null balances and contribute nothing.
 */
function summarizeFleet(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const counts = { ok: 0, low: 0, empty: 0, unregistered: 0 };
  let totalFeeSats = 0;
  let totalSweepableSats = 0;

  for (const r of list) {
    if (!r) continue;
    if (typeof r.feeSats === 'number' && Number.isFinite(r.feeSats)) totalFeeSats += r.feeSats;
    if (typeof r.sweepableSats === 'number' && Number.isFinite(r.sweepableSats)) totalSweepableSats += r.sweepableSats;

    if (r.status === 'ok') counts.ok += 1;
    else if (r.status === 'low') counts.low += 1;
    else if (r.status === 'empty-sweepable' || r.status === 'empty-unfunded') counts.empty += 1;
    else if (r.status === 'unregistered') counts.unregistered += 1;
  }

  return { totalFeeSats, totalSweepableSats, counts };
}

// ---------------------------------------------------------------------------
// Pending-broadcast gate, shared by both money verbs
// ---------------------------------------------------------------------------

/**
 * Should we defer because a transaction we broadcast is probably still
 * unconfirmed? Same hazard as the daemon's `_feeSweepPending` map: the platform
 * serves the CONFIRMED UTXO view, so for a minute or more after a broadcast the
 * inputs we just spent still look unspent, and building from that view spends
 * them twice.
 *
 * Fails CLOSED on a malformed record: "something was broadcast but we cannot
 * tell when" is the single worst state in which to broadcast again.
 */
function isPendingBlocked(pending, now, backstopMs) {
  if (!pending) return false;
  if (typeof pending.at !== 'number' || !Number.isFinite(pending.at)) return true;
  if (typeof now !== 'number' || !Number.isFinite(now)) return true;
  return (now - pending.at) < backstopMs;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/**
 * Decide a MANUAL i→R sweep. Pure.
 *
 * Differs from `planFeeSweep` in exactly one way: there is no floor gate. The
 * daemon only sweeps a tank that is running out; an operator typing
 * `wallet sweep agent-6` has already decided, and refusing with 'above-floor'
 * would just teach them to work around the tool.
 *
 * Everything that protects money is KEPT: fail-closed numbers, the pending
 * gate, and a dust gate. `minSweepSats` defaults to twice the fee because a
 * sweep of exactly 2x nets one write while spending one write — it costs a
 * confirmation and gains nothing.
 */
function planManualSweep({
  feeSats,
  sweepableSats,
  txFeeSats = FEE_SATS,
  minSweepSats = null,
  pending = null,
  now = 0,
  backstopMs = SWEEP_PENDING_BACKSTOP_MS,
} = {}) {
  if (!Number.isFinite(feeSats) || !Number.isFinite(sweepableSats) || !Number.isFinite(txFeeSats)) {
    return { ok: false, reason: 'invalid-balances', amountSats: 0 };
  }

  if (isPendingBlocked(pending, now, backstopMs)) {
    return { ok: false, reason: 'sweep-pending', amountSats: 0 };
  }

  if (sweepableSats <= 0) {
    // Nothing at the i-address. If the tank is also empty only an external
    // transfer (or `wallet send` from another agent) unsticks this agent.
    return { ok: false, reason: 'needs-external-funding', amountSats: 0 };
  }

  const floor = Number.isFinite(minSweepSats) ? minSweepSats : txFeeSats * 2;
  if (sweepableSats <= floor) {
    return { ok: false, reason: 'below-min-sweep', amountSats: 0 };
  }

  const amountSats = sweepableSats - txFeeSats;
  if (amountSats <= 0) {
    return { ok: false, reason: 'below-min-sweep', amountSats: 0 };
  }

  return { ok: true, reason: 'manual-sweep', amountSats };
}

/**
 * Decide an R→R transfer between two fleet agents. Pure.
 *
 * The reserve is the point of this function. Refilling agent-11 by draining
 * agent-2 to zero does not fix the fleet — it moves the outage. So a send that
 * would leave the SOURCE below `reserveWrites` (the same 100-write floor the
 * daemon sweeps at, not a new number) is refused unless the operator passes
 * --allow-drain, and even then it can never spend more than exists.
 *
 * Returns { ok, reason, sendSats, remainingSats, remainingWrites }. On any
 * refusal every number is 0, so a caller that ignores `ok` still cannot build a
 * transaction out of the result.
 */
function planFleetSend({
  feeSats,
  amountSats,
  reserveWrites = DEFAULT_FLOOR_WRITES,
  allowDrain = false,
  fromAgentId = null,
  toAgentId = null,
  pending = null,
  now = 0,
  txFeeSats = FEE_SATS,
  backstopMs = SWEEP_PENDING_BACKSTOP_MS,
} = {}) {
  const no = (reason) => ({ ok: false, reason, sendSats: 0, remainingSats: 0, remainingWrites: 0 });

  if (!Number.isFinite(feeSats) || !Number.isFinite(txFeeSats) || !Number.isFinite(reserveWrites)) {
    return no('invalid-balances');
  }
  // Must be a whole number of satoshis: `parseVrscAmount` is the only supported
  // producer and it returns integers, so a fraction here means someone did the
  // float multiplication this module refuses to do.
  if (!Number.isFinite(amountSats) || !Number.isInteger(amountSats) || amountSats <= 0) {
    return no('invalid-amount');
  }

  if (!fromAgentId || !toAgentId) return no('missing-agent-id');
  // Exact match only. A send must never resolve its destination loosely.
  if (fromAgentId === toAgentId) return no('self-send');

  if (isPendingBlocked(pending, now, backstopMs)) return no('send-pending');

  const total = amountSats + txFeeSats;
  if (total > feeSats) return no('insufficient-funds');

  const remainingSats = feeSats - total;
  const remainingWrites = writesAffordable(remainingSats, txFeeSats);

  if (!allowDrain && remainingWrites < reserveWrites) return no('below-reserve');

  return { ok: true, reason: 'ok', sendSats: amountSats, remainingSats, remainingWrites };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Broadcast one R→R transfer. Impure, but every dependency is a parameter, and
 * it NEVER throws — `wallet sweep --all` loops the fleet and one agent's failure
 * must not abort the rest.
 *
 * The mirror image of `executeFeeSweep`'s invariant: that one refuses R-address
 * inputs (they are the tank it is filling); this one refuses everything that is
 * not an R-address input. An i-address UTXO must reach the R-address only via a
 * sweep, and an address-less UTXO is refused outright rather than assumed —
 * `summarizeUtxos` treats a missing address as fee-payable for COUNTING, which
 * is safe, but assuming it here would be spending on a guess.
 */
async function executeSend({
  buildPayment,
  broadcast,
  wif,
  network,
  rAddress,
  toAddress,
  utxos,
  amountSats,
  txFeeSats = FEE_SATS,
}) {
  if (typeof buildPayment !== 'function' || typeof broadcast !== 'function') {
    return { sent: false, reason: 'missing buildPayment/broadcast' };
  }
  if (!wif || !rAddress || !toAddress) return { sent: false, reason: 'missing wif/rAddress/toAddress' };
  if (!Array.isArray(utxos) || utxos.length === 0) return { sent: false, reason: 'no spendable inputs' };
  if (!(amountSats > 0)) return { sent: false, reason: 'non-positive amount' };

  // Paying our own address burns a fee to accomplish nothing. planFleetSend
  // catches this by agent-id; catch it again by address, because the id → key
  // lookup is the step that could go wrong.
  if (toAddress === rAddress) return { sent: false, reason: 'refusing to send to the source address' };

  // THE INVARIANT. Anything that is not this agent's R-address — an i-address
  // input, or one with no address at all — is refused.
  if (utxos.some(u => !u || !u.address || u.address !== rAddress)) {
    return { sent: false, reason: 'refusing to spend non-R-address inputs' };
  }

  let hex;
  try {
    hex = buildPayment({
      wif,
      toAddress,
      amount: amountSats / 1e8, // buildPayment takes VRSC, not satoshis
      utxos,
      fee: txFeeSats,
      network,
    });
  } catch (e) {
    return { sent: false, reason: `build failed: ${e && e.message}` };
  }

  try {
    const res = await broadcast(hex);
    const txid = (res && res.txid) || null;
    if (!txid) return { sent: false, reason: 'broadcast returned no txid' };
    return { sent: true, txid, amountSats, toAddress, inputs: utxos.length };
  } catch (e) {
    // A rejection costs nothing — the tx never entered a block.
    return { sent: false, reason: `broadcast rejected: ${e && e.message}`, detail: (e && e.detail) || null };
  }
}

/**
 * Establish an agent's true R-address without trusting the platform.
 *
 * SECURITY (audit B1, 2026-08-05). Sweep destinations were previously taken as
 * `u.address || keys.address` — i.e. the platform's `getUtxos()` response was
 * PREFERRED over the key material we hold. That is backwards, and it is not a
 * theoretical concern:
 *
 *   summarizeUtxos() decides what is sweepable by comparing each UTXO's address
 *   against this value. Hand it an address the agent does not own and EVERY utxo
 *   — R-address and i-address alike — is reclassified as "sweepable", the
 *   executor's address-class guard passes (nothing matches), and the whole
 *   balance is signed away to the supplied address. The daemon's auto-sweep
 *   broadcasts that every 30 minutes with no operator prompt.
 *
 * The benign variant is just as bad operationally: if the platform ever returns
 * the i-address here, every sweep runs BACKWARDS, draining the fee tank into the
 * i-address and recreating the exact outage the sweep exists to prevent.
 *
 * So: the caller derives the address from the WIF (`wifToAddress`) and passes it
 * as `derived` — that is authoritative, because it is the key that will sign.
 * The platform's value is accepted only as CORROBORATION. Any disagreement is a
 * hard refusal, never a silent preference.
 *
 * Mirrors the SDK's existing rule in identity/update.ts, which refuses to sign
 * unless the signing key is a primary address of the identity the (semi-trusted)
 * API returned.
 *
 * Pure: no I/O, no SDK import. Returns a result; never throws.
 */
function resolveOwnRAddress({ derived, platformAddress, agentId }) {
  if (typeof derived !== 'string' || !derived) {
    return { ok: false, error: `${agentId || 'agent'}: cannot derive an R-address from its key — refusing to move funds` };
  }
  if (platformAddress && platformAddress !== derived) {
    return {
      ok: false,
      error:
        `${agentId || 'agent'}: platform reported R-address ${platformAddress} but this agent's key derives ` +
        `${derived}. Refusing to move funds against a disputed address.`,
    };
  }
  return { ok: true, rAddress: derived };
}

module.exports = {
  parseVrscAmount,
  formatVrsc,
  resolveOwnRAddress,
  buildWalletRow,
  summarizeFleet,
  planManualSweep,
  planFleetSend,
  executeSend,
};
