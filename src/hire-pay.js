'use strict';

const { SWEEP_PENDING_BACKSTOP_MS } = require('./fee-tank');

function planHirePayment({ pending, now, force, backstopMs } = {}) {
  if (force) return { ok: true, code: null, reason: null };
  const ms = Number.isFinite(Number(backstopMs)) ? Number(backstopMs) : SWEEP_PENDING_BACKSTOP_MS;
  const t = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  if (!pending) return { ok: true, code: null, reason: null };
  if (typeof pending.at !== 'number' || !Number.isFinite(pending.at) || typeof t !== 'number' || !Number.isFinite(t)) {
    return {
      ok: false,
      code: 'PAY_PENDING',
      reason: 'wallet-pending.json is unreadable — refusing another spend (fail closed)',
    };
  }
  if ((t - pending.at) < ms) {
    const tx = pending.txid ? String(pending.txid) : '';
    return {
      ok: false,
      code: 'PAY_PENDING',
      reason: `Previous spend ${tx} still in flight. Wait for wallet show to drop the spent UTXO, then retry.`,
    };
  }
  return { ok: true, code: null, reason: null };
}

function buyerOwnsJob(keys, job) {
  if (!keys || !job) return false;
  const buyer = String(job.buyerVerusId || '').replace(/@$/, '').toLowerCase();
  const ids = [keys.identity, keys.iAddress]
    .filter(Boolean)
    .map((s) => String(s).replace(/@$/, '').toLowerCase());
  return ids.includes(buyer);
}

function jobAlreadyPaid(job) {
  if (!job) return false;
  const p = job.payment;
  if (p && p.verified === true) return true;
  if (p && (p.status === 'confirmed' || p.status === 'completed')) return true;
  return false;
}

module.exports = { planHirePayment, buyerOwnsJob, jobAlreadyPaid };
