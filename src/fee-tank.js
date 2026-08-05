'use strict';
/**
 * Fee-tank maintenance — sweep an agent's earnings into the address that pays
 * its transaction fees.
 *
 * The problem this exists for (found live 2026-08-05, round 4):
 *
 *   - Job payments credit the agent's **i-address**, because paying the VerusID
 *     `name.agentplatform@` resolves there.
 *   - Identity-update fees debit the **R-address** only. `buildIdentityUpdateTx`
 *     filters inputs to `u.address === agentAddress`, and that filter is correct:
 *     an identity output carries a different script that the identity-update path
 *     cannot sign.
 *
 * So the R-address only ever drains — 0.0001 per review, attestation or job
 * record — while every payment lands somewhere it is never drawn from. agent-6
 * reached zero and stopped being able to write anything on-chain while holding
 * 27 job payments it never touched.
 *
 * The funds were never stranded: `buildPayment` DOES spend i-address inputs (the
 * platform returns each UTXO's `script` and the builder passes it to addInput).
 * Nothing was scheduling the transfer. This module schedules it.
 *
 * SELF-FUNDING BY CONSTRUCTION. The sweep spends i-address inputs and pays its
 * own fee out of them, so it works at a ZERO R-address balance — which is
 * precisely when it is needed. It must never take R-address inputs: those are
 * the tank being filled.
 *
 * Decision logic is pure over caller-supplied numbers so it is testable without
 * a wallet, a network or a clock. The executor takes every dependency as an
 * explicit parameter — no module-level state, so a free variable is impossible
 * by construction (the `_usageRecord` lesson from job-agent teardown).
 */

/** Network fee for one transaction, matching SDK DEFAULT_FEE in tx/payment.ts. */
const FEE_SATS = 10000;

/** Sweep when the tank falls below this many writes' worth of fees. */
const DEFAULT_FLOOR_WRITES = 100;

/**
 * Don't spend a whole fee to move a trivial amount. At 20x the fee, a sweep
 * always nets at least 19 writes of headroom.
 */
const DEFAULT_MIN_SWEEP_SATS = FEE_SATS * 20;

/**
 * How long to assume a broadcast sweep is still live before allowing another.
 *
 * Needed because the platform serves the CONFIRMED UTXO view: for a minute or
 * more after a sweep broadcasts, getUtxos still reports the i-address outputs as
 * unspent AND the tank as empty. Rebuilding from that view spends the same
 * inputs twice. Same hazard, and the same reasoning, as the inbox pending-write
 * gate — see shouldDeferForPendingWrite in inbox-deadletter.js.
 */
const SWEEP_PENDING_BACKSTOP_MS = 30 * 60 * 1000; // 30 min >> a few blocks

/**
 * Split a getUtxos() response into "can pay fees" and "can be swept".
 *
 * `rAddress` is the agent's own R-address (getUtxos().address). Anything else
 * holding value — in practice the i-address — is sweepable. A UTXO with no
 * `address` is treated as the R-address's, matching the SDK's own fee filter in
 * identity/update.ts.
 */
function summarizeUtxos(utxos, rAddress) {
  const list = Array.isArray(utxos) ? utxos : [];
  const fee = [];
  const sweepable = [];
  for (const u of list) {
    // typeof check, not just `> 0`: a string "500000" passes a bare comparison
    // and then reduce() CONCATENATES instead of adding, so two 0.005 UTXOs
    // become "0500000500000" and the plan proposes sweeping thousands of coins
    // from a hundredth of one. Nothing is spent (selectUtxos throws) but the
    // agent logs an absurd failed sweep every cycle forever.
    if (!u || typeof u.satoshis !== 'number' || !Number.isFinite(u.satoshis) || u.satoshis <= 0) continue;
    if (!u.address || u.address === rAddress) fee.push(u);
    else sweepable.push(u);
  }
  const sum = (arr) => arr.reduce((n, u) => n + u.satoshis, 0);
  return {
    feeUtxos: fee,
    feeSats: sum(fee),
    sweepableUtxos: sweepable,
    sweepableSats: sum(sweepable),
  };
}

/** Fees-affordable write count for a balance. */
function writesAffordable(sats, feeSats = FEE_SATS) {
  return Math.floor((sats || 0) / feeSats);
}

/**
 * Decide whether to sweep. Pure.
 *
 * Returns { sweep, reason, amountSats } — `amountSats` is what the payment
 * output should carry (everything sweepable, less this tx's own fee).
 *
 * `pending` is the last sweep we broadcast for this agent ({ txid, at }) or null.
 */
function planFeeSweep({
  feeSats,
  sweepableSats,
  floorWrites = DEFAULT_FLOOR_WRITES,
  minSweepSats = DEFAULT_MIN_SWEEP_SATS,
  txFeeSats = FEE_SATS,
  pending = null,
  now = 0,
  backstopMs = SWEEP_PENDING_BACKSTOP_MS,
}) {
  // Fail closed on unusable numbers. Without this, feeSats=NaN makes every
  // comparison below false, so the function falls through ALL its guards and
  // answers "yes, sweep" for a tank whose level it does not know.
  if (!Number.isFinite(feeSats) || !Number.isFinite(sweepableSats)) {
    return { sweep: false, reason: 'invalid-balances', amountSats: 0 };
  }

  const floorSats = floorWrites * txFeeSats;

  if (feeSats >= floorSats) {
    return { sweep: false, reason: 'above-floor', amountSats: 0 };
  }

  // A broadcast sweep is probably still unconfirmed; the confirmed view we are
  // reading cannot show it yet. Rebuilding now double-spends its inputs.
  //
  // Fails CLOSED on a malformed `pending`: an object without a usable timestamp
  // means a sweep was recorded but we cannot tell how long ago, and re-sweeping
  // on that basis is the thing this guard exists to prevent.
  if (pending) {
    if (typeof pending.at !== 'number' || !Number.isFinite(pending.at)) {
      return { sweep: false, reason: 'sweep-pending', amountSats: 0 };
    }
    if ((now - pending.at) < backstopMs) {
      return { sweep: false, reason: 'sweep-pending', amountSats: 0 };
    }
  }

  if (sweepableSats <= 0) {
    // Below the floor with nothing of its own to draw on. Only an external
    // transfer fixes this, so it is an alert rather than a no-op.
    return { sweep: false, reason: 'needs-external-funding', amountSats: 0 };
  }

  if (sweepableSats < minSweepSats) {
    return { sweep: false, reason: 'below-min-sweep', amountSats: 0 };
  }

  const amountSats = sweepableSats - txFeeSats;
  if (amountSats <= 0) {
    return { sweep: false, reason: 'below-min-sweep', amountSats: 0 };
  }

  return { sweep: true, reason: 'below-floor', amountSats };
}

/**
 * Execute one agent's sweep. Impure, but every dependency is a parameter.
 *
 * `buildPayment` and `broadcast` are injected so this is testable with fakes and
 * so the SDK stays a lazy require at the call site (repo convention).
 *
 * Never throws — returns a result object. A sweep failure must not break the
 * caller's loop over the other agents.
 */
async function executeFeeSweep({
  buildPayment,
  broadcast,
  wif,
  network,
  rAddress,
  sweepableUtxos,
  amountSats,
  txFeeSats = FEE_SATS,
}) {
  if (typeof buildPayment !== 'function' || typeof broadcast !== 'function') {
    return { swept: false, reason: 'missing buildPayment/broadcast' };
  }
  if (!wif || !rAddress) return { swept: false, reason: 'missing wif/rAddress' };
  if (!Array.isArray(sweepableUtxos) || sweepableUtxos.length === 0) {
    return { swept: false, reason: 'nothing to sweep' };
  }
  if (!(amountSats > 0)) return { swept: false, reason: 'non-positive amount' };

  // Guard the invariant the whole design rests on: only i-address inputs. An
  // R-address input here would spend the tank we are trying to fill.
  if (sweepableUtxos.some(u => !u.address || u.address === rAddress)) {
    return { swept: false, reason: 'refusing to spend R-address inputs' };
  }

  let hex;
  try {
    hex = buildPayment({
      wif,
      toAddress: rAddress,
      amount: amountSats / 1e8, // buildPayment takes VRSC, not satoshis
      utxos: sweepableUtxos,
      fee: txFeeSats,
      network,
    });
  } catch (e) {
    return { swept: false, reason: `build failed: ${e && e.message}` };
  }

  try {
    const res = await broadcast(hex);
    const txid = (res && res.txid) || null;
    if (!txid) return { swept: false, reason: 'broadcast returned no txid' };
    return { swept: true, txid, amountSats, inputs: sweepableUtxos.length };
  } catch (e) {
    // A rejection costs nothing — the tx never entered a block.
    return { swept: false, reason: `broadcast rejected: ${e && e.message}`, detail: (e && e.detail) || null };
  }
}

module.exports = {
  FEE_SATS,
  DEFAULT_FLOOR_WRITES,
  DEFAULT_MIN_SWEEP_SATS,
  SWEEP_PENDING_BACKSTOP_MS,
  summarizeUtxos,
  writesAffordable,
  planFeeSweep,
  executeFeeSweep,
};
