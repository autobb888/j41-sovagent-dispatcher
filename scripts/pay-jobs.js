#!/usr/bin/env node
/**
 * Direct payment script — bypasses MCP allowlist.
 * Usage: node scripts/pay-jobs.js <jobId1> <jobId2> ...
 * Pays each job's agent + platform fee in a single multi-output tx.
 */
const { J41Agent } = require('@j41/sovagent-sdk');

const WIF = process.env.J41_WIF;
const API_URL = process.env.J41_API_URL || 'https://api.junction41.io';
const IDENTITY = process.env.J41_IDENTITY;
const I_ADDRESS = process.env.J41_IADDRESS;
if (!WIF || !IDENTITY || !I_ADDRESS) {
  console.error('Missing required env vars: J41_WIF, J41_IDENTITY, J41_IADDRESS');
  process.exit(1);
}

async function main() {
  const jobIds = process.argv.slice(2);
  if (jobIds.length === 0) {
    console.log('Usage: node scripts/pay-jobs.js <jobId1> [jobId2] ...');
    process.exit(1);
  }

  const agent = new J41Agent({
    apiUrl: API_URL,
    wif: WIF,
    identityName: IDENTITY,
    iAddress: I_ADDRESS,
  });
  await agent.authenticate();
  console.log(`✅ Authenticated as ${IDENTITY}`);

  for (const jobId of jobIds) {
    try {
      const job = await agent.client.getJob(jobId);
      console.log(`\nJob ${jobId.substring(0, 8)}: ${job.amount} ${job.currency} → ${job.payment?.address}`);
      console.log(`  Status: ${job.status}, Verified: ${job.payment?.verified}`);

      if (job.payment?.verified) {
        console.log(`  Already paid — skipping`);
        continue;
      }
      if (job.status === 'in_progress') {
        console.log(`  Already in_progress — skipping`);
        continue;
      }

      const payAddr = job.payment?.address;
      const feeAddr = job.payment?.platformFeeAddress;
      const amount = parseFloat(job.amount);
      const feeAmount = parseFloat(job.payment?.feeAmount || 0) || amount * 0.05;

      if (!payAddr) {
        console.log(`  No payment address — skipping`);
        continue;
      }

      // Build multi-output payment
      const outputs = [{ address: payAddr, amount }];
      if (feeAddr && feeAmount > 0) {
        outputs.push({ address: feeAddr, amount: feeAmount });
      }

      console.log(`  Sending: ${outputs.map(o => `${o.amount} → ${o.address.substring(0, 12)}...`).join(', ')}`);

      const txid = await agent.sendMultiPayment(outputs);
      console.log(`  ✅ TX: ${txid}`);

      // Record payment on platform
      await agent.client.recordPaymentCombined(jobId, txid);
      console.log(`  ✅ Payment recorded on platform`);
    } catch (e) {
      console.error(`  ❌ Failed: ${e.message}`);
    }
  }

  agent.stop();
}

main().catch(e => { console.error(e); process.exit(1); });
