#!/usr/bin/env node
/**
 * Payment backfill — pay each job's agent (+ platform fee) in one multi-output tx.
 *
 * This used to bypass every money control (raw WIF, float-parsed amounts,
 * arbitrary destinations). It no longer does (P4, C2): amounts are exact integer
 * satoshis via parseVrscAmount, the platform fee address is pinned (not taken
 * per-call), no fee is ever fabricated, and every tx is authorized as a UNIT
 * through the spend-policy gate (caps + hard ceilings + ledger) before it can
 * broadcast.
 *
 * Usage: node scripts/pay-jobs.js <jobId1> <jobId2> ...
 * Env: J41_WIF, J41_IDENTITY, J41_IADDRESS, [J41_PLATFORM_FEE_ADDRESS], [J41_API_URL]
 */
'use strict';

const { parseVrscAmount } = require('../src/wallet.js');

/**
 * Pure planner — build the output set for one job and authorize it as a unit.
 * No SDK, no network, no float. Testable in isolation.
 *
 * @param {object} job - the platform job record ({ amount, payment: { address, feeAmount? } })
 * @param {{ platformFeeAddress?: string|null, expected?: string[] }} opts
 *   platformFeeAddress: the PINNED fee destination (a fixed platform value, not per-call).
 *   expected: the authoritative recipient set; every output address must be a member.
 *             Defaults to [payoutAddress, platformFeeAddress].
 * @returns {{ outputs: Array<{address, amount, amountSats}>, gate: {allowed, reason} }}
 */
function planPayJob(job, opts = {}) {
  const feeAddr = opts.platformFeeAddress || null;
  const payAddr = job && job.payment && job.payment.address;
  const deny = (reason) => ({ outputs: [], gate: { allowed: false, reason } });

  if (!payAddr) return deny('no payment address in the job record');

  const amt = parseVrscAmount(String(job && job.amount));
  if (!amt.ok) return deny(`bad job amount: ${amt.error}`);

  const outputs = [{ address: payAddr, amount: String(job.amount), amountSats: amt.sats }];

  // A fee output exists ONLY when the platform states one. Never a locally computed
  // percentage — the old fallback both floated the math and fabricated a fee.
  const feeRaw = job.payment && job.payment.feeAmount;
  const feeStated = feeRaw !== undefined && feeRaw !== null && String(feeRaw) !== '' && String(feeRaw) !== '0';
  if (feeStated) {
    const fee = parseVrscAmount(String(feeRaw));
    if (!fee.ok) return deny(`bad fee amount: ${fee.error}`);
    if (fee.sats > 0n) {
      if (!feeAddr) return deny('a fee is stated but no platform fee address is configured');
      outputs.push({ address: feeAddr, amount: String(feeRaw), amountSats: fee.sats });
    }
  }

  // Counterparty authorization: every output must be an authoritative recipient.
  const expected = Array.isArray(opts.expected)
    ? opts.expected
    : [payAddr, feeAddr].filter(Boolean);
  for (const o of outputs) {
    if (!expected.includes(o.address)) {
      return { outputs, gate: { allowed: false, reason: `output ${o.address} is not an expected recipient` } };
    }
  }

  return { outputs, gate: { allowed: true, reason: null } };
}

async function main() {
  const { J41Agent } = require('@junction41/sovagent-sdk');
  const { gateExternalSend, recordSendOutcome } = require('../src/spend-policy.js');

  const WIF = process.env.J41_WIF;
  const API_URL = process.env.J41_API_URL || 'https://api.junction41.io';
  const IDENTITY = process.env.J41_IDENTITY;
  const I_ADDRESS = process.env.J41_IADDRESS;
  const PLATFORM_FEE_ADDRESS = process.env.J41_PLATFORM_FEE_ADDRESS || null;
  if (!WIF || !IDENTITY || !I_ADDRESS) {
    console.error('Missing required env vars: J41_WIF, J41_IDENTITY, J41_IADDRESS');
    process.exit(1);
  }
  const jobIds = process.argv.slice(2);
  if (jobIds.length === 0) {
    console.log('Usage: node scripts/pay-jobs.js <jobId1> [jobId2] ...');
    process.exit(1);
  }

  const agent = new J41Agent({ apiUrl: API_URL, wif: WIF, identityName: IDENTITY, iAddress: I_ADDRESS });
  await agent.authenticate();
  console.log(`✅ Authenticated as ${IDENTITY}`);

  for (const jobId of jobIds) {
    try {
      const job = await agent.client.getJob(jobId);
      if (job.payment?.verified) { console.log(`  ${jobId.slice(0, 8)}: already paid — skip`); continue; }
      if (job.status === 'in_progress') { console.log(`  ${jobId.slice(0, 8)}: in_progress — skip`); continue; }

      const expected = [job.payment?.address, PLATFORM_FEE_ADDRESS].filter(Boolean);
      const plan = planPayJob(job, { platformFeeAddress: PLATFORM_FEE_ADDRESS, expected });
      if (!plan.gate.allowed) { console.error(`  ${jobId.slice(0, 8)}: refused — ${plan.gate.reason}`); continue; }

      // Authorize the whole multi-output tx as a UNIT: caps, hard ceilings, ledger.
      const totalVrsc = plan.outputs.reduce((s, o) => s + Number(o.amount), 0);
      const gate = gateExternalSend({
        jobId, toAddress: job.payment.address, amount: totalVrsc,
        jobPrice: Number(job.amount), kind: 'payment', expectedRecipients: expected,
      });
      if (!gate.allowed) { console.error(`  ${jobId.slice(0, 8)}: gate denied — ${gate.reason}`); continue; }

      // Exact decimal strings to the wire — never a float.
      const outputs = plan.outputs.map((o) => ({ address: o.address, amount: o.amount }));
      console.log(`  ${jobId.slice(0, 8)}: sending ${outputs.map((o) => `${o.amount}→${o.address.slice(0, 12)}…`).join(', ')}`);
      const txid = await agent.sendMultiPayment(outputs);
      recordSendOutcome({ kind: 'payment', jobId, toAddress: job.payment.address, amount: totalVrsc, txid });
      await agent.client.recordPaymentCombined(jobId, txid);
      console.log(`  ${jobId.slice(0, 8)}: ✅ ${txid}`);
    } catch (e) {
      console.error(`  ${jobId.slice(0, 8)}: ❌ ${e.message}`);
    }
  }
  agent.stop();
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { planPayJob };
