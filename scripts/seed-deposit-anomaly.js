#!/usr/bin/env node
'use strict';
/**
 * Seed a fabricated deposit anomaly so the M4 operator surfaces can be tested
 * end to end without any real money.
 *
 * Writes ONE `reversed` entry carrying `needsOperator` into a chosen agent's
 * deposits.json. That is the exact shape the reconciler produces when it clawed
 * a credit back but could not prove the debit ran — the state that only a human
 * can settle, and the one the whole read-model/verb layer exists for.
 *
 * SAFETY
 *  - Refuses to touch an agent that already has a deposits.json, so it can never
 *    overwrite real deposit history.
 *  - Uses a buyer id and txid that are obviously fake.
 *  - `--undo` removes exactly what it wrote, and refuses if the file has grown
 *    anything else in the meantime.
 *
 * Usage:
 *   node scripts/seed-deposit-anomaly.js <agent-id> [--amount 1.5]
 *   node scripts/seed-deposit-anomaly.js <agent-id> --undo
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_BUYER = 'm4-runbook-test-buyer@';
const FAKE_TXID = 'tx_m4_runbook_fixture_0000000000000000000000000000';

function depositsPath(agentId) {
  return path.join(os.homedir(), '.j41', 'dispatcher', 'agents', agentId, 'deposits.json');
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const [agentId, ...rest] = process.argv.slice(2);
if (!agentId || agentId.startsWith('-')) {
  die('usage: seed-deposit-anomaly.js <agent-id> [--amount 1.5] [--undo]');
}
const undo = rest.includes('--undo');
const amountIdx = rest.indexOf('--amount');
const amount = amountIdx === -1 ? 1.5 : Number(rest[amountIdx + 1]);
if (!Number.isFinite(amount) || amount <= 0) die('--amount must be a positive number');

const p = depositsPath(agentId);
const agentDir = path.dirname(p);
if (!fs.existsSync(agentDir)) die(`no such agent: ${agentId} (${agentDir} does not exist)`);

if (undo) {
  if (!fs.existsSync(p)) die(`nothing to undo — ${p} does not exist`);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const others = (d.reversed || []).filter((r) => r && r.txid !== FAKE_TXID);
  const realActivity = (d.processed || []).length > 0 || (d.pending || []).length > 0 || others.length > 0;
  if (realActivity) {
    die(`${p} contains entries this script did not write — refusing to remove it. ` +
      'Delete the fixture entry by hand so real history is not lost.');
  }
  fs.unlinkSync(p);
  console.log(`removed ${p}`);
  console.log('Re-check: j41-dispatcher deposits list   → should report nothing outstanding');
  process.exit(0);
}

if (fs.existsSync(p)) {
  die(`${p} already exists — refusing to overwrite real deposit history. ` +
    'Pick an agent that has never taken a deposit, or use --undo first.');
}

const doc = {
  processed: [],
  pending: [],
  creditedTxids: [],
  reversed: [{
    txid: FAKE_TXID,
    buyerVerusId: FAKE_BUYER,
    amount,
    creditedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
    reversedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    reason: 'FIXTURE — funding transaction never confirmed and is unknown to the chain',
    // `false` is the point: it means the reversal could not prove it ever debited
    // the buyer, which is precisely why a human has to decide.
    debited: false,
    needsOperator: 'FIXTURE — reversed without a certain debit, and the tx later confirmed — ' +
      `check whether ${FAKE_BUYER} is owed ${amount}`,
  }],
};

fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
console.log(`seeded a fabricated anomaly at ${p}`);
console.log(`  agent:  ${agentId}`);
console.log(`  buyer:  ${FAKE_BUYER}`);
console.log(`  amount: ${amount} VRSC (no real money is involved)`);
console.log('');
console.log('Now run, in order:');
console.log('  j41-dispatcher deposits list');
console.log('  curl -s localhost:9842/health | jq \'{status, open: .summary.deposits_unconfirmed_open, needs: .summary.deposits_needs_operator}\'');
console.log(`  j41-dispatcher deposits dismiss ${agentId} ${FAKE_TXID} --reason "runbook fixture"`);
console.log('');
console.log(`Clean up with:  node scripts/seed-deposit-anomaly.js ${agentId} --undo`);
