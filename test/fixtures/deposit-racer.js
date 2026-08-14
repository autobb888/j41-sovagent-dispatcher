'use strict';
/**
 * One contender in the deposit-lock race. Spawned as a REAL process by
 * test/deposit-lock-race.test.js — in-process calls cannot reproduce a lost
 * update, because each one sees the previous call's committed file.
 *
 * Does exactly what the daemon and the CLI both do: load the ledger, take a
 * moment (the daemon's moment is a network call), append, save. Without the
 * lock, whichever process saves last erases everyone else's record.
 *
 * argv: <agentId> <marker> <startAtEpochMs>
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const [agentId, marker, startAt] = process.argv.slice(2);

const { withDepositLock } = require('../../src/deposit-watcher.js');

const file = path.join(os.homedir(), '.j41', 'dispatcher', 'agents', agentId, 'deposits.json');

function load() {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { processed: [], pending: [], reversed: [], creditedTxids: [] }; }
}

function save(d) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

(async () => {
  // Spin to a common instant so the contenders genuinely overlap.
  const target = parseInt(startAt, 10);
  while (Date.now() < target) { /* busy-wait: sleeping would smear the start */ }

  try {
    await withDepositLock(agentId, async () => {
      const d = load();
      // The window the lock exists to close.
      await new Promise((r) => setTimeout(r, 30));
      d.processed.push({ txid: `tx_${marker}`, buyerVerusId: 'racer@', amount: 1, confirmations: 1 });
      save(d);
    });
    process.stdout.write('RECORDED\n');
  } catch (e) {
    process.stdout.write(`FAILED:${e.code || e.message}\n`);
  }
})();
