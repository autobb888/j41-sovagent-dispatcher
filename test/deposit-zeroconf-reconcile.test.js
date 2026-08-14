'use strict';
/**
 * M4 chunk 2 — the 0-conf reconciler and the gate that decides when it may
 * take money back.
 *
 * Deposits under 2 VRSC are credited straight from the mempool. A mempool
 * transaction is not money: it can be evicted, replaced, or never mined, and
 * before this the buyer kept the credit either way — repeatable with a fresh
 * txid each time, for free. The reconciler claws it back.
 *
 * Which makes the interesting question not "does it reverse" but "when does it
 * REFUSE to". A node behind the tip answers TX_NOT_FOUND for a transaction that
 * really landed, so a naive reconciler debits buyers who genuinely paid. Most
 * of what follows pins the refusals.
 *
 * Scenarios marked [MUT-n] exist because an adversarial review named a mutation
 * of the implementation that the originally-planned test set could not catch.
 * Deleting the flag gate, deleting the `connections` conjunct, and shrinking the
 * block grace from 30 to 1 all left the planned suite green.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-reconcile-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;

const {
  reconcileUnconfirmedDeposits,
  RECONCILE_MIN_ADVANCE_BLOCKS,
  REVERSAL_BUDGET_MAX,
} = require('../src/deposit-watcher.js');
const { creditDeposit, getBalance } = require('../src/credit-meter.js');

const MINUTE = 60_000;
const BASE_HEIGHT = 1_000_000;

// The reversal budget is fleet-wide and rolling, which means it is also
// MODULE-wide: tests sharing a time base starve each other, and the second one
// to run mysteriously stops reversing. Rather than paper over that with a reset
// hook, every test gets its own hour — which is what separate agents doing this
// on separate days actually looks like, and it exercises the window's expiry
// instead of hiding it.
let _epoch = 1_700_000_000_000;
function epoch() {
  _epoch += 6 * 60 * MINUTE;
  return _epoch;
}

// ── backend feature flag ────────────────────────────────────────────────────
// The reconciler asks the SDK's cached hasFeature() whether the backend
// advertises `tx.status-notfound-code`. The cache is module-level with a 5-min
// TTL, so varying the flag between tests means dropping that module too.
const SDK_FEATURES = require.resolve('@junction41/sovagent-sdk/dist/backend-features.js');

function setBackendFeatures(features) {
  delete require.cache[SDK_FEATURES];
  global.fetch = async () => ({
    ok: true,
    status: 200,
    async json() { return { version: 'test', features }; },
    async text() { return JSON.stringify({ version: 'test', features }); },
  });
}

const FLAG_ON = ['tx.status-notfound-code'];
const FLAG_OFF = ['agent.platform-status-v1'];

// ── fakes ───────────────────────────────────────────────────────────────────

/** A synced, healthy node on the expected chain (config default is verustest). */
function syncedChain(height = BASE_HEIGHT) {
  return { chain: 'VRSCTEST', testnet: true, blockHeight: height, longestChain: height, connections: 4 };
}

function txNotFound() {
  return Object.assign(new Error('Transaction not found'), { code: 'TX_NOT_FOUND', statusCode: 404 });
}

function bareNotFound() {
  return Object.assign(new Error('Not Found'), { code: 'NOT_FOUND', statusCode: 404 });
}

/**
 * `state.chain` may be one value or a queue of samples consumed in order —
 * the reconciler takes TWO chain-info samples per pass (before and after the
 * lookups), so a queue is how a test makes the node change mid-pass.
 */
function makeClient(state) {
  return {
    async getChainInfo() {
      if (state.chainThrows) throw new Error('platform unreachable');
      const c = Array.isArray(state.chainQueue) && state.chainQueue.length
        ? state.chainQueue.shift()
        : state.chain;
      return c;
    },
    async getTxStatus(txid) {
      const spec = state.tx[txid];
      if (!spec) throw txNotFound();
      if (spec.throw) throw spec.throw;
      return { confirmations: spec.confirmations };
    },
  };
}

// ── fixtures ────────────────────────────────────────────────────────────────

function depositsFile(agentId) {
  return path.join(TEST_HOME, '.j41', 'dispatcher', 'agents', agentId, 'deposits.json');
}

function readDeposits(agentId) {
  return JSON.parse(fs.readFileSync(depositsFile(agentId), 'utf8'));
}

function writeDeposits(agentId, data) {
  const p = depositsFile(agentId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

let agentSeq = 0;
/** A fresh agent holding one open 0-conf credit, meter already credited. */
function seedOpenCredit({ amount = 1.5, buyer = 'buyer@', creditedAtMs = _epoch, extra = {} } = {}) {
  const agentId = `agent-rec-${++agentSeq}`;
  const txid = 'tx_' + crypto.randomBytes(8).toString('hex');
  writeDeposits(agentId, {
    processed: [{
      txid,
      buyerVerusId: buyer,
      amount,
      confirmations: 0,
      creditedAt: new Date(creditedAtMs).toISOString(),
      unconfirmed: true,
      creditedAtMs,
      misses: 0,
      ...extra,
    }],
    pending: [],
    reversed: [],
    creditedTxids: [txid],
  });
  creditDeposit(agentId, buyer, amount, txid);
  return { agentId, txid, buyer, amount };
}

/**
 * Drive a full qualifying miss run: 3 passes, >10 minutes apart, with the node
 * ingesting enough blocks to clear the block grace. Returns the last result.
 */
async function fullMissRun(agentId, client, state, { blocksPerPass = 20, passes = 3, t0 = _epoch } = {}) {
  let res;
  for (let i = 1; i <= passes; i++) {
    state.chain = syncedChain(BASE_HEIGHT + i * blocksPerPass);
    res = await reconcileUnconfirmedDeposits(agentId, client, t0 + i * 6 * MINUTE);
  }
  return res;
}

// ── the gate: when the reconciler must REFUSE to act ────────────────────────

test('a lagging node reporting TX_NOT_FOUND does not reverse, and the credit survives catch-up', async () => {
  const T0 = epoch();
  setBackendFeatures(FLAG_ON);
  const { agentId, txid, buyer, amount } = seedOpenCredit();
  const state = { chain: { ...syncedChain(BASE_HEIGHT), blockHeight: BASE_HEIGHT - 500 }, tx: {} };
  const client = makeClient(state);

  // Many passes against a node 500 blocks behind its peers.
  for (let i = 1; i <= 6; i++) {
    state.chain = { chain: 'VRSCTEST', testnet: true, blockHeight: BASE_HEIGHT - 500 + i, longestChain: BASE_HEIGHT + i, connections: 4 };
    await reconcileUnconfirmedDeposits(agentId, client, T0 + i * 10 * MINUTE);
  }
  assert.equal(getBalance(agentId, buyer), amount, 'a lagging node must never cost a buyer their balance');
  assert.equal(readDeposits(agentId).processed[0].misses, 0, 'a lagging node produces zero evidence — no misses counted');

  // The node catches up and the transaction was there all along.
  state.chain = syncedChain(BASE_HEIGHT + 600);
  state.tx[txid] = { confirmations: 3 };
  const res = await reconcileUnconfirmedDeposits(agentId, client, T0 + 70 * MINUTE);
  assert.equal(res.confirmed, 1);
  assert.equal(getBalance(agentId, buyer), amount);
  assert.equal(readDeposits(agentId).processed[0].unconfirmed, undefined, 'a confirmed credit stops being open');
});

test('chain info unavailable for the whole window counts nothing', async () => {
  const T0 = epoch();
  setBackendFeatures(FLAG_ON);
  const { agentId, buyer, amount } = seedOpenCredit();
  const state = { chain: syncedChain(), tx: {}, chainThrows: true };
  const client = makeClient(state);

  for (let i = 1; i <= 6; i++) await reconcileUnconfirmedDeposits(agentId, client, T0 + i * 10 * MINUTE);

  assert.equal(getBalance(agentId, buyer), amount);
  assert.equal(readDeposits(agentId).processed[0].misses, 0);
});

test('[MUT-2] an isolated node with zero peers counts nothing, even at its peers\' height', async () => {
  const T0 = epoch();
  // blockHeight === longestChain looks perfectly synced. It is not: an isolated
  // node's longestChain is just its own stale tip agreeing with itself.
  setBackendFeatures(FLAG_ON);
  const { agentId, buyer, amount } = seedOpenCredit();
  const state = { chain: { ...syncedChain(), connections: 0 }, tx: {} };
  const client = makeClient(state);

  for (let i = 1; i <= 6; i++) {
    state.chain = { chain: 'VRSCTEST', testnet: true, blockHeight: BASE_HEIGHT + i * 20, longestChain: BASE_HEIGHT + i * 20, connections: 0 };
    await reconcileUnconfirmedDeposits(agentId, client, T0 + i * 10 * MINUTE);
  }
  assert.equal(getBalance(agentId, buyer), amount, 'an isolated node must not be able to debit a buyer');
  assert.equal(readDeposits(agentId).processed[0].misses, 0);
});

test('longestChain of zero is not "caught up"', async () => {
  const T0 = epoch();
  // Komodo-lineage daemons report 0 before peer heights are polled, which any
  // `blockHeight >= longestChain` test passes trivially. The backend restarts
  // daily, so this is a state reached routinely, not a curiosity.
  setBackendFeatures(FLAG_ON);
  const { agentId, buyer, amount } = seedOpenCredit();
  const state = { chain: { chain: 'VRSCTEST', testnet: true, blockHeight: BASE_HEIGHT, longestChain: 0, connections: 4 }, tx: {} };
  const client = makeClient(state);

  for (let i = 1; i <= 6; i++) {
    state.chain = { chain: 'VRSCTEST', testnet: true, blockHeight: BASE_HEIGHT + i * 20, longestChain: 0, connections: 4 };
    await reconcileUnconfirmedDeposits(agentId, client, T0 + i * 10 * MINUTE);
  }
  assert.equal(getBalance(agentId, buyer), amount);
  assert.equal(readDeposits(agentId).processed[0].misses, 0);
});

test('a node on the wrong chain counts nothing', async () => {
  const T0 = epoch();
  // Fully synced by every height test, and wrong about every txid.
  setBackendFeatures(FLAG_ON);
  const { agentId, buyer, amount } = seedOpenCredit();
  const state = { chain: { chain: 'VRSC', testnet: false, blockHeight: BASE_HEIGHT, longestChain: BASE_HEIGHT, connections: 8 }, tx: {} };
  const client = makeClient(state);

  // Drive the run by hand: the shared fullMissRun helper installs a TESTNET
  // node, which would quietly make this test pass for the wrong reason.
  for (let i = 1; i <= 6; i++) {
    state.chain = { chain: 'VRSC', testnet: false, blockHeight: BASE_HEIGHT + i * 20, longestChain: BASE_HEIGHT + i * 20, connections: 8 };
    await reconcileUnconfirmedDeposits(agentId, client, T0 + i * 6 * MINUTE);
  }
  assert.equal(getBalance(agentId, buyer), amount, 'a node on the wrong chain must not debit anyone');
  assert.equal(readDeposits(agentId).processed[0].misses, 0, 'and its answers are not counted as evidence');
});

test('a frozen node satisfies the wall clock and still cannot reverse', async () => {
  const T0 = epoch();
  setBackendFeatures(FLAG_ON);
  const { agentId, buyer, amount } = seedOpenCredit();
  const state = { chain: syncedChain(BASE_HEIGHT), tx: {} };
  const client = makeClient(state);

  // Hours pass. The node is at its peers' tip and ingests nothing.
  for (let i = 1; i <= 8; i++) await reconcileUnconfirmedDeposits(agentId, client, T0 + i * 30 * MINUTE);

  assert.equal(getBalance(agentId, buyer), amount,
    'height never advanced, so no amount of elapsed wall time is evidence');
  assert.ok(readDeposits(agentId).processed[0].misses >= 3, 'misses do accumulate — it is the block grace that holds');
});

test('[MUT-3] a partial block advance does not reverse; passing 30 blocks does', async () => {
  const T0 = epoch();
  setBackendFeatures(FLAG_ON);
  const { agentId, buyer, amount } = seedOpenCredit();
  const state = { chain: syncedChain(BASE_HEIGHT), tx: {} };
  const client = makeClient(state);

  // Three misses over 18 minutes, but only ~10 blocks ingested.
  for (let i = 1; i <= 3; i++) {
    state.chain = syncedChain(BASE_HEIGHT + i * 3);
    await reconcileUnconfirmedDeposits(agentId, client, T0 + i * 6 * MINUTE);
  }
  assert.equal(getBalance(agentId, buyer), amount,
    `10 blocks is short of the ${RECONCILE_MIN_ADVANCE_BLOCKS}-block grace and must not reverse`);

  // Now the chain moves properly.
  state.chain = syncedChain(BASE_HEIGHT + RECONCILE_MIN_ADVANCE_BLOCKS + 5);
  const res = await reconcileUnconfirmedDeposits(agentId, client, T0 + 30 * MINUTE);
  assert.equal(res.reversed, 1);
  assert.equal(getBalance(agentId, buyer), 0);
});

test('[MUT-1] with the backend flag absent, TX_NOT_FOUND is not evidence', async () => {
  const T0 = epoch();
  // The flag gate had no test that could fail if it were deleted: the harness
  // advertised the flag by default and nothing ever varied it.
  setBackendFeatures(FLAG_OFF);
  const { agentId, buyer, amount } = seedOpenCredit();
  const state = { chain: syncedChain(), tx: {} };
  const client = makeClient(state);

  const res = await fullMissRun(agentId, client, state, { passes: 6 });

  assert.equal(getBalance(agentId, buyer), amount,
    'without the advertised contract a not-found code means nothing and must not move money');
  assert.equal(res.reversed, 0);
  assert.equal(res.state, 'inert-no-flag', 'and the inert state must be reported, not silent');
});

test('a bare 404 is not evidence even when the flag is on', async () => {
  const T0 = epoch();
  setBackendFeatures(FLAG_ON);
  const { agentId, txid, buyer, amount } = seedOpenCredit();
  const state = { chain: syncedChain(), tx: { [txid]: { throw: bareNotFound() } } };
  const client = makeClient(state);

  await fullMissRun(agentId, client, state, { passes: 6 });

  assert.equal(getBalance(agentId, buyer), amount,
    'a generic 404 is what a renamed route answers with, identically for every txid');
  assert.equal(readDeposits(agentId).processed[0].misses, 0,
    'classified transient, so the miss run never starts');
});

test('the pass is bracketed: a node that falls out of sync mid-pass cannot reverse', async () => {
  const T0 = epoch();
  setBackendFeatures(FLAG_ON);
  const { agentId, buyer, amount } = seedOpenCredit();
  const state = { chain: syncedChain(BASE_HEIGHT), tx: {} };
  const client = makeClient(state);

  // Two clean passes to build the miss run.
  for (let i = 1; i <= 2; i++) {
    state.chain = syncedChain(BASE_HEIGHT + i * 20);
    await reconcileUnconfirmedDeposits(agentId, client, T0 + i * 6 * MINUTE);
  }
  // Third pass: synced when sampled before the lookups, behind when re-sampled.
  state.chainQueue = [
    syncedChain(BASE_HEIGHT + 60),
    { chain: 'VRSCTEST', testnet: true, blockHeight: BASE_HEIGHT + 60, longestChain: BASE_HEIGHT + 900, connections: 4 },
  ];
  const res = await reconcileUnconfirmedDeposits(agentId, client, T0 + 20 * MINUTE);

  assert.equal(res.reversed, 0, 'the second sample withdraws consent for this pass');
  assert.equal(getBalance(agentId, buyer), amount);
});

// ── systemic and blast radius ───────────────────────────────────────────────

test('every open credit answering TX_NOT_FOUND at once is a backend fault, not evidence', async () => {
  const T0 = epoch();
  setBackendFeatures(FLAG_ON);
  const agentId = 'agent-systemic';
  const buyer = 'buyer-sys@';
  const txids = ['tx_sys_a', 'tx_sys_b', 'tx_sys_c'];
  writeDeposits(agentId, {
    processed: txids.map((txid) => ({
      txid, buyerVerusId: buyer, amount: 1, confirmations: 0,
      creditedAt: new Date(T0).toISOString(), unconfirmed: true, creditedAtMs: T0, misses: 0,
    })),
    pending: [], reversed: [], creditedTxids: [...txids],
  });
  for (const t of txids) creditDeposit(agentId, buyer, 1, t);

  const state = { chain: syncedChain(), tx: {} }; // every lookup → TX_NOT_FOUND
  const client = makeClient(state);
  const res = await fullMissRun(agentId, client, state, { passes: 6 });

  assert.equal(res.state, 'systemic');
  assert.equal(getBalance(agentId, buyer), 3, 'a txindex wipe must not empty every buyer at once');
  assert.equal(readDeposits(agentId).processed[0].misses, 0, 'a systemic pass counts nothing');
});

test('the fleet reversal budget stops a runaway before it works through everyone', async () => {
  const T0 = epoch();
  setBackendFeatures(FLAG_ON);
  // Each agent holds ONE open credit, so the per-agent systemic guard (which
  // needs >1 lookup) cannot fire — this is precisely the residue it leaves.
  const seeds = [];
  for (let i = 0; i < REVERSAL_BUDGET_MAX + 3; i++) {
    seeds.push(seedOpenCredit({ buyer: `budget-buyer-${i}@`, amount: 1 }));
  }
  let reversedTotal = 0;
  let withheld = 0;
  for (const s of seeds) {
    const state = { chain: syncedChain(), tx: {} };
    const res = await fullMissRun(s.agentId, makeClient(state), state);
    reversedTotal += res.reversed;
    const rec = readDeposits(s.agentId).processed[0];
    if (rec && rec.needsOperator) withheld++;
  }
  assert.ok(reversedTotal <= REVERSAL_BUDGET_MAX,
    `at most ${REVERSAL_BUDGET_MAX} reversals per hour fleet-wide; got ${reversedTotal}`);
  assert.ok(withheld >= 1, 'the withheld ones must be flagged for a human, not silently skipped');
});

// ── the miss run ────────────────────────────────────────────────────────────

test('[MUT-4] a mempool sighting resets the block grace, not just the clock', async () => {
  const T0 = epoch();
  setBackendFeatures(FLAG_ON);
  const { agentId, txid, buyer, amount } = seedOpenCredit();
  const state = { chain: syncedChain(BASE_HEIGHT), tx: {} };
  const client = makeClient(state);

  // Two misses while the chain advances a long way.
  for (let i = 1; i <= 2; i++) {
    state.chain = syncedChain(BASE_HEIGHT + i * 100);
    await reconcileUnconfirmedDeposits(agentId, client, T0 + i * 6 * MINUTE);
  }
  const stamped = readDeposits(agentId).processed[0].firstMissHeight;
  assert.ok(Number.isFinite(stamped), 'the first miss stamps a height');

  // The tx reappears in the mempool: positive evidence it exists.
  state.tx[txid] = { confirmations: 0 };
  state.chain = syncedChain(BASE_HEIGHT + 300);
  await reconcileUnconfirmedDeposits(agentId, client, T0 + 20 * MINUTE);
  const afterFlap = readDeposits(agentId).processed[0];
  assert.equal(afterFlap.firstMissHeight, undefined,
    'a stale firstMissHeight makes the next run clear the 30-block grace instantly');
  assert.equal(afterFlap.firstMissAtMs, undefined);

  // It drops out again. The new run must start its block clock from here.
  delete state.tx[txid];
  state.chain = syncedChain(BASE_HEIGHT + 305);
  await reconcileUnconfirmedDeposits(agentId, client, T0 + 26 * MINUTE);
  const restarted = readDeposits(agentId).processed[0];
  assert.ok(restarted.firstMissHeight >= BASE_HEIGHT + 300,
    `the block clock must restart after a sighting; got ${restarted.firstMissHeight}`);
  assert.equal(getBalance(agentId, buyer), amount);
});

test('a genuine drop is reversed once, and the balance goes negative if it was spent', async () => {
  const T0 = epoch();
  setBackendFeatures(FLAG_ON);
  const { agentId, buyer, amount } = seedOpenCredit({ amount: 1.5 });
  const state = { chain: syncedChain(), tx: {} };
  const client = makeClient(state);

  const res = await fullMissRun(agentId, client, state);
  assert.equal(res.reversed, 1);
  assert.equal(getBalance(agentId, buyer), 0);

  const d = readDeposits(agentId);
  assert.equal(d.processed.length, 0, 'the reversed record leaves `processed`');
  assert.equal(d.reversed.length, 1);
  assert.equal(d.reversed[0].debited, true);
  assert.ok(!d.creditedTxids.includes(d.reversed[0].txid),
    'the txid leaves the dedup ledger so a buyer whose payment DID confirm can re-report it');

  // A second pass must not debit again.
  await fullMissRun(agentId, client, state);
  assert.equal(getBalance(agentId, buyer), 0);
  assert.ok(res.reversed === 1);
  void amount;
});

// ── restore, and the double-credit paths around it ──────────────────────────

test('a reversal that turns out wrong is restored, and cannot then be credited twice', async () => {
  const T0 = epoch();
  setBackendFeatures(FLAG_ON);
  const { agentId, txid, buyer, amount } = seedOpenCredit({ amount: 1.5 });
  const state = { chain: syncedChain(), tx: {} };
  const client = makeClient(state);

  await fullMissRun(agentId, client, state);
  assert.equal(getBalance(agentId, buyer), 0, 'reversed');

  // The transaction confirms after all.
  state.tx[txid] = { confirmations: 4 };
  const res = await reconcileUnconfirmedDeposits(agentId, client, T0 + 40 * MINUTE);
  assert.equal(res.restored, 1);
  assert.equal(getBalance(agentId, buyer), amount, 'the buyer is made whole');

  const d = readDeposits(agentId);
  assert.ok(d.processed.some((r) => r.txid === txid),
    'a restored txid must go back into `processed` or a re-report credits it again');
  assert.ok(d.creditedTxids.includes(txid), 'and back into the dedup ledger');

  // Another pass must not restore a second time.
  await reconcileUnconfirmedDeposits(agentId, client, T0 + 50 * MINUTE);
  assert.equal(getBalance(agentId, buyer), amount);
});

test('an interrupted restore is flagged for a human, not silently lost', async () => {
  const T0 = epoch();
  setBackendFeatures(FLAG_ON);
  const { agentId, txid, buyer } = seedOpenCredit({ amount: 1.5 });
  const state = { chain: syncedChain(), tx: {} };
  const client = makeClient(state);
  await fullMissRun(agentId, client, state);

  // Crash between the restore intent and the credit: the meter write fails.
  state.tx[txid] = { confirmations: 4 };
  const realRename = fs.renameSync;
  fs.renameSync = (from, to, ...rest) => {
    if (String(to).endsWith('credit-meters.json')) throw new Error('EIO');
    return realRename(from, to, ...rest);
  };
  try {
    await reconcileUnconfirmedDeposits(agentId, client, T0 + 40 * MINUTE).catch(() => {});
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(getBalance(agentId, buyer), 0, 'the credit did not land');

  // The next pass must notice, rather than excluding the entry forever.
  await reconcileUnconfirmedDeposits(agentId, client, T0 + 50 * MINUTE);
  const entry = readDeposits(agentId).reversed.find((r) => r.txid === txid);
  assert.ok(entry.needsOperator,
    'an interrupted restore that nothing flags is money gone with the ledger claiming otherwise');
});

test('a reversal that never certainly debited is never auto-restored', async () => {
  const T0 = epoch();
  setBackendFeatures(FLAG_ON);
  const agentId = 'agent-forgiven';
  const txid = 'tx_forgiven';
  writeDeposits(agentId, {
    processed: [], pending: [], creditedTxids: [],
    reversed: [{
      txid, buyerVerusId: 'buyer-f@', amount: 1.5,
      reversedAt: new Date(T0).toISOString(),
      reason: 'test', debited: false,
    }],
  });
  const state = { chain: syncedChain(), tx: { [txid]: { confirmations: 5 } } };

  const res = await reconcileUnconfirmedDeposits(agentId, makeClient(state), T0 + 10 * MINUTE);
  assert.equal(res.restored, 0);
  assert.equal(getBalance(agentId, 'buyer-f@'), 0,
    'restoring a reversal that never charged the buyer hands them the deposit twice');
  assert.ok(readDeposits(agentId).reversed[0].needsOperator);
});

// ── pre-port credits ────────────────────────────────────────────────────────

test('0-conf credits minted before the reconciler existed are adopted, and the old tail is reported', async () => {
  const T0 = epoch();
  setBackendFeatures(FLAG_ON);
  const agentId = 'agent-backfill';
  const recent = 'tx_recent';
  const ancient = 'tx_ancient';
  writeDeposits(agentId, {
    processed: [
      // No `unconfirmed` flag: exactly what the shipped code writes today.
      { txid: recent, buyerVerusId: 'b1@', amount: 1, confirmations: 0, creditedAt: new Date(T0 - 60 * MINUTE).toISOString() },
      { txid: ancient, buyerVerusId: 'b2@', amount: 1, confirmations: 0, creditedAt: new Date(T0 - 90 * 24 * 60 * MINUTE).toISOString() },
    ],
    pending: [], reversed: [], creditedTxids: [recent, ancient],
  });
  const state = { chain: syncedChain(), tx: { [recent]: { confirmations: 2 } } };

  await reconcileUnconfirmedDeposits(agentId, makeClient(state), T0);

  const d = readDeposits(agentId);
  const r = d.processed.find((x) => x.txid === recent);
  const a = d.processed.find((x) => x.txid === ancient);
  assert.equal(r.unconfirmed, undefined, 'the adopted credit was checked and confirmed');
  assert.equal(r.confirmations, 2);
  assert.equal(a.reconcileBackfillSkipped, true,
    'the old tail is marked as a deliberate skip, not silently ignored');
  assert.equal(a.unconfirmed, undefined);
});

// NOTE: the "audit trim must not discard an open 0-conf credit" case lives in
// deposit-crash-consistency.test.js, not here. It was written here first and was
// VACUOUS: a reconcile pass never calls the trim, so the assertion passed no
// matter what the trim did — a mutation removing `unconfirmed` from the
// exemption survived it. Trimming happens when a NEW deposit is credited, so the
// test has to drive `reportDeposit`, which is where that file's machinery is.

// ── events ──────────────────────────────────────────────────────────────────

test('[MUT-5] money-moving outcomes emit control-API events', async () => {
  // The emit parameter defaults to a no-op, so "never wire it up" is a mutation
  // that changes nothing observable unless something asserts the events. Which
  // is exactly how an event stream ends up permanently silent in production.
  const T0 = epoch();
  setBackendFeatures(FLAG_ON);
  const { agentId, txid, buyer, amount } = seedOpenCredit({ amount: 1.5 });
  const state = { chain: syncedChain(), tx: {} };
  const client = makeClient(state);
  const events = [];
  const emit = (type, data) => events.push({ type, data });

  for (let i = 1; i <= 3; i++) {
    state.chain = syncedChain(BASE_HEIGHT + i * 20);
    await reconcileUnconfirmedDeposits(agentId, client, T0 + i * 6 * MINUTE, emit);
  }
  const rev = events.find((e) => e.type === 'deposit.reversed');
  assert.ok(rev, `expected a deposit.reversed event; got ${JSON.stringify(events.map((e) => e.type))}`);
  assert.equal(rev.data.txid, txid);
  assert.equal(rev.data.buyerVerusId, buyer);
  assert.equal(rev.data.amount, amount);
  assert.equal(rev.data.debited, true);

  // The reversal was wrong after all.
  state.tx[txid] = { confirmations: 4 };
  await reconcileUnconfirmedDeposits(agentId, client, T0 + 40 * MINUTE, emit);
  const res = events.find((e) => e.type === 'deposit.restored');
  assert.ok(res, 'a restore must be as visible as the reversal that preceded it');
  assert.equal(res.data.txid, txid);
});

test('an anomaly only a human can settle emits deposit.needs_operator', async () => {
  const T0 = epoch();
  setBackendFeatures(FLAG_ON);
  const agentId = 'agent-emit-op';
  const txid = 'tx_emit_op';
  writeDeposits(agentId, {
    processed: [], pending: [], creditedTxids: [],
    reversed: [{
      txid, buyerVerusId: 'buyer-op@', amount: 1.5,
      reversedAt: new Date(T0).toISOString(), reason: 'test', debited: false,
    }],
  });
  const state = { chain: syncedChain(), tx: { [txid]: { confirmations: 5 } } };
  const events = [];

  await reconcileUnconfirmedDeposits(agentId, makeClient(state), T0 + 10 * MINUTE,
    (type, data) => events.push({ type, data }));

  const ev = events.find((e) => e.type === 'deposit.needs_operator');
  assert.ok(ev, `expected deposit.needs_operator; got ${JSON.stringify(events.map((e) => e.type))}`);
  assert.equal(ev.data.where, 'reversed');
  assert.ok(ev.data.reason);
});

test('a thrown event handler cannot break the money path', async () => {
  const T0 = epoch();
  setBackendFeatures(FLAG_ON);
  const { agentId, buyer } = seedOpenCredit({ amount: 1.5 });
  const state = { chain: syncedChain(), tx: {} };
  const client = makeClient(state);
  const hostile = () => { throw new Error('bus exploded'); };

  for (let i = 1; i <= 3; i++) {
    state.chain = syncedChain(BASE_HEIGHT + i * 20);
    await reconcileUnconfirmedDeposits(agentId, client, T0 + i * 6 * MINUTE, hostile);
  }
  assert.equal(getBalance(agentId, buyer), 0, 'the reversal still completed');
  assert.equal(readDeposits(agentId).reversed.length, 1, 'and was still recorded');
});

test('a restore emits even when the pass also has open credits to work through', async () => {
  // Reconcile reaches _recheckReversals by TWO routes: an early return when
  // nothing is open, and phase 4 at the end of a working pass. The obvious
  // restore test only exercises the first, so the second's event threading can
  // be deleted with the suite still green.
  const T0 = epoch();
  setBackendFeatures(FLAG_ON);
  const { agentId, txid, buyer, amount } = seedOpenCredit({ amount: 1.5 });
  const state = { chain: syncedChain(), tx: {} };
  const client = makeClient(state);

  for (let i = 1; i <= 3; i++) {
    state.chain = syncedChain(BASE_HEIGHT + i * 20);
    await reconcileUnconfirmedDeposits(agentId, client, T0 + i * 6 * MINUTE);
  }
  assert.equal(getBalance(agentId, buyer), 0, 'reversed');

  // Give the agent a second, still-open credit so the pass does real work and
  // reaches phase 4 rather than returning early.
  const d = readDeposits(agentId);
  const otherTxid = 'tx_other_open';
  d.processed.push({
    txid: otherTxid, buyerVerusId: 'someone-else@', amount: 1, confirmations: 0,
    creditedAt: new Date(T0).toISOString(), unconfirmed: true, creditedAtMs: T0, misses: 0,
  });
  d.creditedTxids.push(otherTxid);
  writeDeposits(agentId, d);
  state.tx[otherTxid] = { confirmations: 0 }; // visibly in the mempool, so it just waits
  state.tx[txid] = { confirmations: 4 };      // the reversed one confirmed after all

  const events = [];
  const res = await reconcileUnconfirmedDeposits(agentId, client, T0 + 40 * MINUTE,
    (type, data) => events.push({ type, data }));

  assert.equal(res.restored, 1);
  assert.equal(getBalance(agentId, buyer), amount);
  const ev = events.find((e) => e.type === 'deposit.restored');
  assert.ok(ev, `phase 4 must emit too; got ${JSON.stringify(events.map((e) => e.type))}`);
  assert.equal(ev.data.txid, txid);
});
