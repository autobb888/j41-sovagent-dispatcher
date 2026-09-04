'use strict';
// CLI-handler tests for the `wallet` command.
//
// src/wallet.js is already proven pure (test/wallet.test.js). What is NOT proven
// by those tests is the wiring: that the CLI actually consults the planners, that
// a refusal really does stop short of the network, that a dry run never reaches
// `broadcast`, and that the pending stamp is written after a broadcast and read
// before the next one. Every assertion here is about a broadcast that must or
// must not happen, or about the file that decides it.
//
// Sandbox HOME (same isolation pattern as refund-cli.test.js) so AGENTS_DIR — and
// therefore every wallet-pending.json — resolves inside a temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-wallet-cli-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
process.env.NODE_ENV = 'test';

const AGENTS_DIR = path.join(TEST_HOME, '.j41', 'dispatcher', 'agents');
fs.mkdirSync(AGENTS_DIR, { recursive: true });

const {
  walletList, walletShow, walletSweep, walletSend,
  loadWalletPending, saveWalletPending, walletPendingPath, resolveWalletPending, checkFeeTanks,
} = require('../src/cli.js');

const { FEE_SATS, DEFAULT_FLOOR_WRITES, SWEEP_PENDING_BACKSTOP_MS } = require('../src/fee-tank.js');

// Real keypairs, not placeholder strings. The wallet paths derive the R-address
// from the WIF and refuse to move funds if the platform disputes it (audit B1),
// so a fixture whose `address` is not actually derivable from its `wif` would be
// refused — and, worse, a fixture that faked both would never exercise the
// derivation at all. Generating real pairs keeps the guard under test.
const { generateKeypair } = require('@junction41/sovagent-sdk/dist/index.js');
const SRC_KEYS = generateKeypair('verustest');
const DST_KEYS = generateKeypair('verustest');
const R_SRC = SRC_KEYS.address;
const R_DST = DST_KEYS.address;
const I_SRC = 'iSrcAgent2IdentityXXXXXXXXXXXXXXXXX';
const I_DST = 'iDstAgent11IdentityXXXXXXXXXXXXXXXX';

const rUtxo = (satoshis, n = 0) => ({ txid: `r${n}`.padEnd(64, '0'), vout: n, address: R_SRC, satoshis, script: 'aa' });
const iUtxo = (satoshis, n = 0) => ({ txid: `i${n}`.padEnd(64, '0'), vout: n, address: I_SRC, satoshis, script: 'bb' });

function agent(id, over = {}) {
  return {
    id,
    identity: `${id}@`,
    address: R_SRC,
    iAddress: I_SRC,
    wif: SRC_KEYS.wif,
    ...over,
  };
}

/**
 * A stub session plus counters for the two things that touch the network.
 * `broadcastCalls` is the assertion that matters in almost every test below:
 * a refusal that still broadcast is not a refusal.
 */
function makeState(opts = {}) {
  const calls = { broadcast: [], build: [] };
  const state = {
    agents: opts.agents || [agent('agent-2'), agent('agent-11', { address: R_DST, iAddress: I_DST, identity: 'agent-11@' })],
    agentSessions: new Map(),
    _testAgentSession: {
      client: {
        getUtxos: opts.getUtxos || (async () => ({ address: R_SRC, iAddress: I_SRC, utxos: opts.utxos || [] })),
        broadcast: async (hex) => { calls.broadcast.push(hex); return { txid: opts.txid || 'ffeeddccbbaa99887766554433221100' }; },
      },
    },
    _testBuildPayment: (args) => { calls.build.push(args); return 'deadbeef'.repeat(20); },
  };
  return { state, calls };
}

/** Capture console output so assertions can be made on what the operator SEES. */
function capture(fn) {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  const push = (...a) => lines.push(a.join(' '));
  console.log = push; console.error = push; console.warn = push;
  const done = () => { console.log = orig.log; console.error = orig.error; console.warn = orig.warn; };
  const out = fn();
  if (out && typeof out.then === 'function') {
    return out.then(v => { done(); return { value: v, text: lines.join('\n') }; },
      e => { done(); throw e; });
  }
  done();
  return { value: out, text: lines.join('\n') };
}

function clearStamps() {
  for (const id of fs.existsSync(AGENTS_DIR) ? fs.readdirSync(AGENTS_DIR) : []) {
    const p = path.join(AGENTS_DIR, id, 'wallet-pending.json');
    try { fs.unlinkSync(p); } catch {}
  }
}

// ── list ─────────────────────────────────────────────────────────────────────

test('list renders an unqueried agent as "—", never as 0', async () => {
  const { state, calls } = makeState({
    agents: [agent('agent-2'), { id: 'agent-12', address: R_DST }], // no identity/wif → never queried
    utxos: [rUtxo(250000000)],
  });

  const { value, text } = await capture(() => walletList(state, {}));

  const unreg = value.rows.find(r => r.agentId === 'agent-12');
  assert.equal(unreg.status, 'unregistered');
  assert.equal(unreg.feeSats, null, 'balance must be null — we never looked');
  assert.equal(unreg.sweepableSats, null);

  const row = text.split('\n').find(l => l.includes('agent-12'));
  assert.ok(row, 'unregistered agent must still appear in the table');
  assert.ok(!/0\.00000000/.test(row), `unregistered row must not print a zero balance: ${row}`);
  assert.match(row, /—/, 'unregistered row must show the never-queried dash');
  assert.match(row, new RegExp(R_DST), 'must print the full fundable address, not a truncation');

  // Totals exclude the null row entirely.
  assert.equal(value.totals.totalFeeSats, 250000000);
  assert.equal(calls.broadcast.length, 0, 'list must never broadcast');
});

test('list --json emits integer satoshis and nulls, no floats', async () => {
  const { state } = makeState({
    agents: [agent('agent-2'), { id: 'agent-12', address: R_DST }],
    utxos: [rUtxo(13490000), iUtxo(49990000)],
  });
  const { text } = await capture(() => walletList(state, { json: true }));
  const doc = JSON.parse(text);
  const a2 = doc.agents.find(a => a.id === 'agent-2');
  assert.equal(a2.feeSats, 13490000);
  assert.equal(a2.sweepableSats, 49990000);
  assert.equal(Number.isInteger(a2.feeSats), true);
  assert.equal(doc.agents.find(a => a.id === 'agent-12').feeSats, null);
  assert.equal(doc.totals.feeSats, 13490000);
});

test('list survives one agent whose query fails, without inventing a balance', async () => {
  const { state } = makeState({
    agents: [agent('agent-2')],
    getUtxos: async () => { throw new Error('CHAIN_SYNCING'); },
  });
  const { value } = await capture(() => walletList(state, {}));
  assert.equal(value.rows[0].status, 'error');
  assert.equal(value.rows[0].feeSats, null);
  assert.match(value.rows[0].error, /CHAIN_SYNCING/);
});

// ── sweep ────────────────────────────────────────────────────────────────────

test('sweep of an unknown agent broadcasts nothing', async () => {
  clearStamps();
  const { state, calls } = makeState({ utxos: [iUtxo(13500000)] });
  const { value } = await capture(() => walletSweep(state, 'agent-nope', { yes: true }));
  assert.equal(value.results.length, 0);
  assert.equal(calls.broadcast.length, 0);
});

test('sweep with nothing at the i-address broadcasts nothing', async () => {
  clearStamps();
  const { state, calls } = makeState({ utxos: [rUtxo(500000)] });
  const { value } = await capture(() => walletSweep(state, 'agent-2', { yes: true }));
  assert.equal(value.results[0].swept, false);
  assert.equal(value.results[0].reason, 'needs-external-funding');
  assert.equal(calls.broadcast.length, 0);
});

test('sweep succeeds and stamps wallet-pending.json at 0600', async () => {
  clearStamps();
  const { state, calls } = makeState({ utxos: [rUtxo(0 + 1), iUtxo(13500000)], txid: '4e4f3bf7aabbccddeeff00112233445566' });
  const before = Date.now();
  const { value } = await capture(() => walletSweep(state, 'agent-2', { yes: true }));

  assert.equal(value.results[0].swept, true);
  assert.equal(value.results[0].amountSats, 13500000 - FEE_SATS, 'sweep pays its own fee out of the swept inputs');
  assert.equal(calls.broadcast.length, 1);

  // Only i-address inputs may be spent by a sweep (fee-tank.js invariant).
  assert.deepEqual(calls.build[0].utxos.map(u => u.address), [I_SRC]);
  assert.equal(calls.build[0].toAddress, R_SRC);

  const p = walletPendingPath('agent-2');
  const stamp = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(stamp.kind, 'sweep');
  assert.equal(stamp.txid, '4e4f3bf7aabbccddeeff00112233445566');
  assert.ok(stamp.at >= before, 'stamp must carry the broadcast time');
  assert.equal(fs.statSync(p).mode & 0o777, 0o600, 'stamp holds a txid — 0600 only');
});

test('a fresh stamp blocks the next sweep, and --force overrides it', async () => {
  clearStamps();
  saveWalletPending('agent-2', { txid: 'earlier', at: Date.now(), kind: 'sweep' });

  const a = makeState({ utxos: [iUtxo(13500000)] });
  const blocked = await capture(() => walletSweep(a.state, 'agent-2', { yes: true }));
  assert.equal(blocked.value.results[0].reason, 'sweep-pending');
  assert.equal(a.calls.broadcast.length, 0, 'must not rebuild from a stale confirmed view');

  const b = makeState({ utxos: [iUtxo(13500000)] });
  const forced = await capture(() => walletSweep(b.state, 'agent-2', { yes: true, force: true }));
  assert.equal(forced.value.results[0].swept, true);
  assert.equal(b.calls.broadcast.length, 1);
  clearStamps();
});

test('a stamp older than the backstop no longer blocks', async () => {
  clearStamps();
  saveWalletPending('agent-2', { txid: 'ancient', at: Date.now() - SWEEP_PENDING_BACKSTOP_MS - 1000, kind: 'sweep' });
  const { state, calls } = makeState({ utxos: [iUtxo(13500000)] });
  const { value } = await capture(() => walletSweep(state, 'agent-2', { yes: true }));
  assert.equal(value.results[0].swept, true);
  assert.equal(calls.broadcast.length, 1);
  clearStamps();
});

test('a malformed stamp fails CLOSED — no broadcast', async () => {
  clearStamps();
  const p = walletPendingPath('agent-2');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{ this is not json', { mode: 0o600 });

  assert.equal(loadWalletPending('agent-2').at, null, 'unparseable stamp must not read as "nothing pending"');

  const { state, calls } = makeState({ utxos: [iUtxo(13500000)] });
  const { value } = await capture(() => walletSweep(state, 'agent-2', { yes: true }));
  assert.equal(value.results[0].reason, 'sweep-pending');
  assert.equal(calls.broadcast.length, 0);
  clearStamps();
});

test('sweep without --yes and without a confirmation function refuses', async () => {
  clearStamps();
  const { state, calls } = makeState({ utxos: [iUtxo(13500000)] });
  const { value } = await capture(() => walletSweep(state, 'agent-2', {}));
  assert.equal(value.results[0].reason, 'no-confirmation');
  assert.equal(calls.broadcast.length, 0);
});

test('a declined confirmation broadcasts nothing', async () => {
  clearStamps();
  const { state, calls } = makeState({ utxos: [iUtxo(13500000)] });
  const { value } = await capture(() => walletSweep(state, 'agent-2', { confirmFn: async () => false }));
  assert.equal(value.results[0].reason, 'cancelled');
  assert.equal(calls.broadcast.length, 0);
});

test('sweep --dry-run builds but never broadcasts and writes no stamp', async () => {
  clearStamps();
  const { state, calls } = makeState({ utxos: [iUtxo(13500000)] });
  const { value, text } = await capture(() => walletSweep(state, 'agent-2', { yes: true, dryRun: true }));
  assert.equal(value.results[0].dryRun, true);
  assert.equal(value.results[0].swept, false);
  assert.equal(calls.build.length, 1, 'dry run must still sign, so signing errors surface');
  assert.equal(calls.broadcast.length, 0);
  assert.equal(fs.existsSync(walletPendingPath('agent-2')), false, 'nothing was broadcast, so nothing may be stamped');
  assert.match(text, /proves NOTHING/, 'the dry-run caveat must be stated');
});

test('sweep --all keeps going after one agent fails', async () => {
  clearStamps();
  let n = 0;
  const { state, calls } = makeState({
    agents: [agent('agent-2'), agent('agent-6'), { id: 'agent-12', address: R_DST }],
    getUtxos: async () => {
      n += 1;
      if (n === 1) throw new Error('boom');
      return { address: R_SRC, iAddress: I_SRC, utxos: [iUtxo(13500000)] };
    },
  });
  const { value } = await capture(() => walletSweep(state, null, { all: true, yes: true }));
  assert.equal(value.results.length, 2, 'unregistered agent-12 is not a sweep target');
  assert.equal(value.results[0].swept, false);
  assert.match(value.results[0].reason, /boom/);
  assert.equal(value.results[1].swept, true, 'the loop must continue past a failure');
  assert.equal(calls.broadcast.length, 1);
  clearStamps();
});

// ── send ─────────────────────────────────────────────────────────────────────

const FUNDED = [rUtxo(250000000)]; // 2.5 coin tank

function sendState(over = {}) {
  return makeState({
    agents: [agent('agent-2'), agent('agent-11', { address: R_DST, iAddress: I_DST, identity: 'agent-11@' })],
    utxos: FUNDED,
    ...over,
  });
}

test('send refuses a raw address as a destination', async () => {
  clearStamps();
  const { state, calls } = sendState();
  const { value, text } = await capture(() => walletSend(state, 'agent-2', R_DST, '1.0', { yes: true }));
  assert.equal(value.sent, false);
  assert.equal(value.reason, 'unknown-agent');
  assert.match(text, /raw address/i);
  assert.equal(calls.broadcast.length, 0);
});

test('send refuses an unparseable amount before touching anything', async () => {
  clearStamps();
  for (const bad of ['1e3', '-1', '0', '1.000000001', 'abc']) {
    const { state, calls } = sendState();
    const { value } = await capture(() => walletSend(state, 'agent-2', 'agent-11', bad, { yes: true }));
    assert.equal(value.reason, 'invalid-amount', `${bad} must be refused`);
    assert.equal(calls.broadcast.length, 0);
  }
});

test('send refuses self-send', async () => {
  clearStamps();
  const { state, calls } = sendState();
  const { value } = await capture(() => walletSend(state, 'agent-2', 'agent-2', '1.0', { yes: true }));
  assert.equal(value.reason, 'self-send');
  assert.equal(calls.broadcast.length, 0);
});

test('send succeeds, spends only R-address inputs, and stamps the SOURCE', async () => {
  clearStamps();
  const { state, calls } = sendState({ utxos: [rUtxo(250000000), iUtxo(9000000)], txid: 'aee1973900000000000000000000000000' });
  const { value } = await capture(() => walletSend(state, 'agent-2', 'agent-11', '1.0', { yes: true }));

  assert.equal(value.sent, true);
  assert.equal(value.amountSats, 100000000);
  assert.equal(calls.broadcast.length, 1);
  assert.deepEqual(calls.build[0].utxos.map(u => u.address), [R_SRC], 'a send must never spend i-address earnings');
  assert.equal(calls.build[0].toAddress, R_DST, "destination is the fleet agent's own R-address");
  assert.equal(calls.build[0].amount, 1, 'buildPayment takes coins, not satoshis');

  const stamp = JSON.parse(fs.readFileSync(walletPendingPath('agent-2'), 'utf8'));
  assert.equal(stamp.kind, 'send');
  assert.equal(fs.existsSync(walletPendingPath('agent-11')), false, 'only the spending agent is stamped');
  clearStamps();
});

test('send that would breach the reserve is refused, and --allow-drain overrides', async () => {
  clearStamps();
  const tank = (DEFAULT_FLOOR_WRITES + 1) * FEE_SATS; // 101 writes
  const amount = '0.01'; // 1_000_000 sats; + fee → exactly drains the tank

  const a = sendState({ utxos: [rUtxo(tank)] });
  const refused = await capture(() => walletSend(a.state, 'agent-2', 'agent-11', amount, { yes: true }));
  assert.equal(refused.value.reason, 'below-reserve');
  assert.equal(a.calls.broadcast.length, 0);
  assert.match(refused.text, /--allow-drain/);

  const b = sendState({ utxos: [rUtxo(tank)] });
  const drained = await capture(() => walletSend(b.state, 'agent-2', 'agent-11', amount, { yes: true, allowDrain: true }));
  assert.equal(drained.value.sent, true);
  assert.equal(b.calls.broadcast.length, 1);
  clearStamps();
});

test('send refuses when the amount plus fee exceeds the tank', async () => {
  clearStamps();
  const { state, calls } = sendState({ utxos: [rUtxo(100000000)] });
  const { value } = await capture(() => walletSend(state, 'agent-2', 'agent-11', '1.0', { yes: true, allowDrain: true }));
  assert.equal(value.reason, 'insufficient-funds');
  assert.equal(calls.broadcast.length, 0);
});

test('send --dry-run builds but never broadcasts and writes no stamp', async () => {
  clearStamps();
  const { state, calls } = sendState();
  const { value, text } = await capture(() => walletSend(state, 'agent-2', 'agent-11', '1.0', { yes: true, dryRun: true }));
  assert.equal(value.dryRun, true);
  assert.equal(value.sent, false);
  assert.equal(calls.build.length, 1);
  assert.equal(calls.broadcast.length, 0);
  assert.equal(fs.existsSync(walletPendingPath('agent-2')), false);
  assert.match(text, /proves NOTHING/);
});

test('an address-less UTXO in the tank fails the send closed', async () => {
  clearStamps();
  // summarizeUtxos counts an address-less UTXO as fee-payable (safe for
  // COUNTING); executeSend refuses to SPEND it. The send must die here rather
  // than guess which address it belongs to.
  const { state, calls } = sendState({ utxos: [rUtxo(250000000), { txid: 'x'.repeat(64), vout: 3, satoshis: 500000 }] });
  const { value } = await capture(() => walletSend(state, 'agent-2', 'agent-11', '1.0', { yes: true }));
  assert.equal(value.sent, false);
  assert.match(value.reason, /non-R-address/);
  assert.equal(calls.broadcast.length, 0);
});

test('send without --yes and without a confirmation function refuses', async () => {
  clearStamps();
  const { state, calls } = sendState();
  const { value } = await capture(() => walletSend(state, 'agent-2', 'agent-11', '1.0', {}));
  assert.equal(value.reason, 'no-confirmation');
  assert.equal(calls.broadcast.length, 0);
});

test('a fresh stamp blocks a send too', async () => {
  clearStamps();
  saveWalletPending('agent-2', { txid: 'earlier', at: Date.now(), kind: 'send' });
  const { state, calls } = sendState();
  const { value } = await capture(() => walletSend(state, 'agent-2', 'agent-11', '1.0', { yes: true }));
  assert.equal(value.reason, 'send-pending');
  assert.equal(calls.broadcast.length, 0);
  clearStamps();
});

// ── mainnet ──────────────────────────────────────────────────────────────────
//
// IS_MAINNET is resolved once at require time and can only be made STRICTER by a
// caller, never looser — `forceMainnetRules` turns the rules on, and nothing can
// turn them off on a real mainnet install.

test('mainnet refuses --yes for send', async () => {
  clearStamps();
  const { state, calls } = sendState();
  const { value, text } = await capture(() =>
    walletSend(state, 'agent-2', 'agent-11', '1.0', { yes: true, forceMainnetRules: true }));
  assert.equal(value.reason, 'mainnet-yes-refused');
  assert.equal(calls.broadcast.length, 0);
  assert.match(text, /mainnet/i);
});

test('mainnet demands a typed amount, not a keypress', async () => {
  clearStamps();
  const seen = [];
  const { state, calls } = sendState();
  const { value } = await capture(() => walletSend(state, 'agent-2', 'agent-11', '1.0', {
    forceMainnetRules: true,
    confirmFn: async (ctx) => { seen.push(ctx); return true; },
  }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].requireTypedAmount, true, 'mainnet confirmation must be typed-amount');
  assert.equal(seen[0].amountText, '1.0');
  assert.equal(value.sent, true);
  assert.equal(calls.broadcast.length, 1);
  clearStamps();
});

test('testnet send uses a plain y/N confirmation', async () => {
  clearStamps();
  const seen = [];
  const { state } = sendState();
  await capture(() => walletSend(state, 'agent-2', 'agent-11', '1.0', {
    confirmFn: async (ctx) => { seen.push(ctx); return true; },
  }));
  assert.equal(seen[0].requireTypedAmount, false);
  clearStamps();
});

// ── show ─────────────────────────────────────────────────────────────────────

test('show reports the pending stamp and never fabricates balances', async () => {
  clearStamps();
  saveWalletPending('agent-2', { txid: '4e4f3bf7cafe', at: Date.now() - 120000, kind: 'sweep' });
  const { state } = sendState({ utxos: [rUtxo(13490000), iUtxo(49990000)] });
  const { text } = await capture(() => walletShow(state, 'agent-2', {}));
  assert.match(text, /0\.13490000/);
  assert.match(text, /0\.49990000/);
  assert.match(text, /Pending sweep 4e4f3bf7cafe/);
  assert.match(text, /2m ago/);
  clearStamps();
});

test('show of an unknown agent returns null', async () => {
  const { state } = sendState();
  const { value } = await capture(() => walletShow(state, 'nope', {}));
  assert.equal(value, null);
});

// ── checkFeeTanks snapshot (feeds /health) ───────────────────────────────────
//
// The daemon's sweep already fetches every agent's UTXOs each cycle and then
// threw the numbers away. These pin that it now records them for EVERY outcome —
// a snapshot that only appeared on the sweep path would be blank exactly when
// the fleet is healthy, and blank again when an agent is stuck.

function sweepState(utxos) {
  const { state, calls } = makeState({ agents: [agent('agent-6')], utxos });
  state._agentErrors = new Map();
  state._feeSweepPending = new Map();
  state._feeTankLast = new Map();
  state.feeSweep = { floorWrites: DEFAULT_FLOOR_WRITES };
  return { state, calls };
}

test('checkFeeTanks records a healthy tank (above-floor)', async () => {
  const { state } = sweepState([rUtxo(250000000)]);
  await capture(() => checkFeeTanks(state));
  const snap = state._feeTankLast.get('agent-6');
  assert.equal(snap.feeSats, 250000000);
  assert.equal(snap.writes, 25000);
  assert.equal(snap.sweepableSats, 0);
  assert.equal(snap.reason, 'above-floor');
  assert.equal(typeof snap.at, 'number');
});

test('checkFeeTanks records LOW (32 writes) without setting EMPTY lastError', async () => {
  const { state } = sweepState([rUtxo(32 * FEE_SATS)]);
  state._agentErrors.set('agent-6', 'FEE TANK EMPTY and nothing to sweep — fund RAbc externally');
  const { text } = await capture(() => checkFeeTanks(state));
  const snap = state._feeTankLast.get('agent-6');
  assert.equal(snap.writes, 32);
  assert.equal(snap.reason, 'below-floor-unfunded');
  assert.equal(state._agentErrors.get('agent-6'), undefined);
  assert.match(text, /FEE TANK LOW/);
  assert.doesNotMatch(text, /FEE TANK EMPTY/);
});

test('checkFeeTanks records the stuck agent it cannot fix (needs-external-funding)', async () => {
  const { state, calls } = sweepState([]);
  await capture(() => checkFeeTanks(state));
  const snap = state._feeTankLast.get('agent-6');
  assert.equal(snap.feeSats, 0);
  assert.equal(snap.writes, 0);
  assert.equal(snap.reason, 'needs-external-funding');
  assert.equal(calls.broadcast.length, 0);
  assert.match(state._agentErrors.get('agent-6'), /FEE TANK EMPTY/);
});

test('checkFeeTanks records a below-floor agent with earnings to sweep', async () => {
  const { state } = sweepState([rUtxo(500000), iUtxo(13500000)]);
  await capture(() => checkFeeTanks(state));
  const snap = state._feeTankLast.get('agent-6');
  assert.equal(snap.feeSats, 500000);
  assert.equal(snap.writes, 50);
  assert.equal(snap.sweepableSats, 13500000);
  assert.equal(snap.reason, 'below-floor');
});

test('checkFeeTanks tolerates a state object that predates the map', async () => {
  const { state } = sweepState([rUtxo(250000000)]);
  delete state._feeTankLast;
  await capture(() => checkFeeTanks(state));
  assert.equal(state._feeTankLast.get('agent-6').reason, 'above-floor');
});


// ---------------------------------------------------------------------------
// resolveWalletPending — a CONFIRMED tx must stop blocking.
//
// Found by live-testing the sweep on 2026-08-05: agent-1's sweep confirmed in
// ~90s, but the wall-clock stamp kept refusing the next command for the full
// 30-minute backstop AND told the operator the tx was "unconfirmed" when it
// demonstrably was not. The guard exists to stop a rebuild while the first tx
// is in the mempool; once it confirms, that hazard is gone.
//
// Fails CLOSED on every doubt — the stamp survives unless confirmation is proven.
// ---------------------------------------------------------------------------

const stampFor = (txid, kind = 'sweep') => ({ txid, at: Date.now(), kind });

test('a confirmed tx clears the stamp and unblocks the next command', async () => {
  saveWalletPending('agent-2', stampFor('confirmed-tx'));
  const client = { getTxStatus: async () => ({ confirmations: 3 }) };
  const out = await resolveWalletPending(client, 'agent-2', loadWalletPending('agent-2'));
  assert.equal(out, null, 'confirmed → guard released');
  assert.equal(fs.existsSync(walletPendingPath('agent-2')), false, 'stamp file removed');
});

test('an UNCONFIRMED tx keeps the stamp — the mempool hazard is real', async () => {
  saveWalletPending('agent-2', stampFor('mempool-tx'));
  const client = { getTxStatus: async () => ({ confirmations: 0 }) };
  const out = await resolveWalletPending(client, 'agent-2', loadWalletPending('agent-2'));
  assert.ok(out && out.txid === 'mempool-tx', 'still pending → guard held');
  assert.equal(fs.existsSync(walletPendingPath('agent-2')), true, 'stamp file kept');
  fs.unlinkSync(walletPendingPath('agent-2'));
});

test('fails CLOSED on every doubt rather than guessing', async () => {
  const cases = [
    ['lookup throws',        { getTxStatus: async () => { throw new Error('503'); } }],
    ['no confirmations key', { getTxStatus: async () => ({}) }],
    ['client lacks method',  {}],
    ['null client',          null],
  ];
  for (const [label, client] of cases) {
    saveWalletPending('agent-2', stampFor('unknown-tx'));
    const out = await resolveWalletPending(client, 'agent-2', loadWalletPending('agent-2'));
    assert.ok(out && out.txid === 'unknown-tx', `${label}: must keep the guard`);
    assert.equal(fs.existsSync(walletPendingPath('agent-2')), true, `${label}: stamp kept`);
    fs.unlinkSync(walletPendingPath('agent-2'));
  }
});

test('a malformed or txid-less stamp is passed through untouched, not cleared', async () => {
  const client = { getTxStatus: async () => ({ confirmations: 9 }) };
  assert.equal(await resolveWalletPending(client, 'agent-2', null), null, 'no stamp stays no stamp');
  const bad = { at: null, malformed: true };
  assert.equal(await resolveWalletPending(client, 'agent-2', bad), bad, 'malformed survives');
  const noTxid = { at: Date.now(), kind: 'sweep' };
  assert.equal(await resolveWalletPending(client, 'agent-2', noTxid), noTxid, 'no txid → cannot verify → keep');
});

// ---------------------------------------------------------------------------
// Audit B1 at the handler level: a platform-supplied address that disagrees with
// the agent's key must stop the sweep dead.
//
// The pre-fix code did `rAddress = u.address || agentInfo.address`, PREFERRING
// the platform's value. summarizeUtxos then reclassified every UTXO — R and i
// alike — as sweepable, executeFeeSweep's guard passed because nothing matched,
// and the whole balance was signed to the supplied address. The daemon does this
// unattended every 30 minutes.
//
// No earlier test could catch it: the stub returned the same address the fixture
// held, so key-derived and platform-supplied were indistinguishable. This one
// makes them differ.
// ---------------------------------------------------------------------------

test('B1: a sweep is REFUSED when the platform disputes the key-derived address', async () => {
  const EVIL = 'RAttackerAddressXXXXXXXXXXXXXXXXXX';
  // Everything an honest response would carry — except `address`, which lies.
  const { state, calls } = makeState({
    getUtxos: async () => ({ address: EVIL, iAddress: I_SRC, utxos: [rUtxo(1_099_320_000, 1), iUtxo(50_000_000, 2)] }),
  });

  const { value } = await capture(() => walletSweep(state, 'agent-2', { yes: true }));
  const row = value.results[0];

  assert.equal(row.swept, false, 'must not sweep against a disputed address');
  assert.equal(row.reason, 'address-mismatch');
  assert.equal(calls.build.length, 0, 'nothing may be signed');
  assert.equal(calls.broadcast.length, 0, 'nothing may be broadcast');
  assert.equal(fs.existsSync(walletPendingPath('agent-2')), false, 'and nothing stamped');
});

test('B1: a send is REFUSED when the platform disputes the source address', async () => {
  const EVIL = 'RAttackerAddressXXXXXXXXXXXXXXXXXX';
  const { state, calls } = makeState({
    getUtxos: async () => ({ address: EVIL, iAddress: I_SRC, utxos: [rUtxo(1_099_320_000, 1)] }),
  });

  const { value } = await capture(() => walletSend(state, 'agent-2', 'agent-11', '1.0', { yes: true }));

  assert.equal(value.sent, false);
  assert.equal(calls.broadcast.length, 0, 'nothing may be broadcast');
});
