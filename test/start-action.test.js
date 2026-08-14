'use strict';
/**
 * Executing tests for the dispatcher's `start` action.
 *
 * These run the real action — real commander parse, real activation loop, real
 * marker handling, real control plane, real health document — against a stubbed
 * process edge (see test/helpers/dispatcher-harness.js). Nothing here greps
 * source text, because a grep for an identifier passes against `if (false)` and
 * that is precisely how the worst defects in 2.29.0 survived five review rounds.
 *
 * The invariant every scenario asserts, whatever else it is about:
 *
 *     chain.rejections.length === 0
 *
 * An identity may have one unconfirmed write in flight. A second one is a `-25`,
 * and on a nine-agent fleet that is nine agents the hire gate silently refuses
 * while every local surface reports healthy. Three consecutive live restarts
 * produced 9, then 5, then 3 of them.
 */

const test = require('node:test');
const assert = require('node:assert');

const { runStart } = require('./helpers/dispatcher-harness');
const { FakeChain } = require('./helpers/fake-chain');

/** A fleet of n agents, both axes as given. */
function fleet(n, over = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `agent-${i + 1}`,
    identity: `agent${i + 1}@`,
    iAddress: `iAgent${i + 1}`,
    chainStatus: 'active',
    platformStatus: 'active',
    ...(typeof over === 'function' ? over(i + 1) : over),
  }));
}

/** Run, assert startup actually completed, and hand back the result. */
async function started(scenario) {
  const r = await runStart(scenario);
  if (r.startError) {
    await r.teardown();
    throw r.startError;
  }
  if (r.timedOut) {
    const tail = r.output.slice(-25).join('\n');
    await r.teardown();
    throw new Error(`start did not complete within the harness budget. Tail:\n${tail}`);
  }
  // A run that called process.exit is NOT a completed startup. `timedOut` is
  // false whenever an exit was recorded, so without this a mutation that exits
  // after the marker is written but before `startupComplete` passed several
  // scenarios outright — every assertion in them was already settled by then.
  if (r.exits.length) {
    const tail = r.output.slice(-25).join('\n');
    await r.teardown();
    throw new Error(`start exited (${r.exits.join(',')}) instead of completing. Tail:\n${tail}`);
  }
  if (r.state?.startupComplete !== true) {
    await r.teardown();
    throw new Error('start never set startupComplete');
  }
  // A timer callback that throws would crash the real process. The virtual clock
  // records them instead of re-raising, so an interval that throws during startup
  // is otherwise completely invisible.
  const timerErrors = r.clock.errors();
  if (timerErrors.length) {
    await r.teardown();
    throw new Error(`timer callback(s) threw during startup: ${timerErrors.map((e) => e.message).join('; ')}`);
  }
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. The model itself must be able to fail.
//
// Every scenario below leans on FakeChain rejecting a second unconfirmed write.
// If that ever stops working, all of them pass for the wrong reason — the exact
// shape of "the test was theatre" this harness was built to end.
// ─────────────────────────────────────────────────────────────────────────────

test('harness self-test: the chain model rejects a second unconfirmed write', () => {
  const chain = new FakeChain([{ id: 'a', iAddress: 'ia', identity: 'a@' }], { blockTimeMs: 60000 });
  const t0 = 1000;
  chain.write('a', 'inactive', t0);
  assert.throws(() => chain.write('a', 'active', t0 + 5000), /-25/);
  assert.equal(chain.rejections.length, 1);

  // ...and accepts one after the block.
  chain.write('a', 'active', t0 + 60001);
  assert.equal(chain.rejections.length, 1);
  assert.equal(chain.get('a').chainStatus, 'inactive'); // the confirmed one
});

test('harness self-test: the audit matcher does not confuse deactivate with activate', async () => {
  // `'deactivate'.includes('activate')` is true. While the matcher used substring
  // search, `count('activate')` counted deactivates — so "exactly one activate per
  // agent" could be satisfied by a deactivate with the activate missing entirely.
  const { createSdkStub } = require('./helpers/sdk-stub');
  const stub = createSdkStub({ agents: [{ id: 'a', identity: 'a@', iAddress: 'ia' }] });
  const agent = new stub.modules.J41Agent({ iAddress: 'ia', identityName: 'a@' });
  await agent.deactivate({ onChain: false });

  assert.equal(stub.count('deactivate'), 1);
  assert.equal(stub.count('activate'), 0, 'a deactivate must never be counted as an activate');
  assert.equal(stub.byAgent('activate').size, 0);
});

test('harness self-test: getIdentityRaw serves the LAST CONFIRMED prevOutput', () => {
  const chain = new FakeChain([{ id: 'a', iAddress: 'ia', identity: 'a@' }], { blockTimeMs: 60000 });
  const before = chain.identityRaw('a', 1000).data.prevOutput.txid;
  const txid = chain.write('a', 'inactive', 1000);
  assert.equal(chain.identityRaw('a', 1500).data.prevOutput.txid, before,
    'a pending write must NOT appear as prevOutput — that is why the second write double-spends');
  assert.equal(chain.identityRaw('a', 61001).data.prevOutput.txid, txid);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The routine restart. This is the whole point of 2.29.0: zero transactions.
// ─────────────────────────────────────────────────────────────────────────────

test('routine restart of a healthy fleet performs ZERO on-chain writes', async (t) => {
  const r = await started({ agents: fleet(9) });
  t.after(() => r.teardown());

  assert.equal(r.chain.rejections.length, 0);
  assert.equal(r.sdk.count('setOnChainStatus'), 0, 'no chain-axis repair should be needed');
  assert.equal(r.sdk.count('activate'), 0, 'both axes active means the activation loop must skip entirely');
  for (const rec of Object.values(r.chain.snapshot())) assert.equal(rec.writes, 0);

  assert.equal(r.state.available.length, 9);
  assert.deepEqual(r.chain.hireable().sort(), fleet(9).map((a) => a.id).sort());
  assert.ok(r.logged('already active — no write needed'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The upgrade restart from 2.28.x — the case this release exists for.
//
// The previous version deactivated on-chain at shutdown. On the first start
// after the upgrade each agent therefore has an UNCONFIRMED deactivate in the
// mempool, its platform axis already inactive, and its chain axis still reading
// `active` because the deactivate has not landed yet. Writing an activate now is
// the double-spend. The action must wait for each deactivate to confirm, and
// only then repair the chain axis — exactly once per agent.
// ─────────────────────────────────────────────────────────────────────────────

function upgradeFleet(n) {
  return fleet(n, (i) => ({
    chainStatus: 'active',                                   // last CONFIRMED value
    platformStatus: 'inactive',                              // shutdown's POST landed immediately
    pending: { txid: `tx-deact-${i}`, status: 'inactive' },  // still in the mempool
  }));
}

function upgradeMarker(n) {
  const txids = {};
  for (let i = 1; i <= n; i++) txids[`agent-${i}`] = `tx-deact-${i}`;
  return { at: '2026-08-13T11:55:00.000Z', agents: Object.keys(txids), txids };
}

test('2.28.x upgrade restart: waits out the pending deactivates, repairs each chain axis exactly once, zero rejections', async (t) => {
  const N = 9;
  const r = await started({
    agents: upgradeFleet(N),
    shutdownMarker: upgradeMarker(N),
    sdk: { blockTimeMs: 60000 },
  });
  t.after(() => r.teardown());

  assert.equal(r.chain.rejections.length, 0,
    `expected no rejected writes, got ${JSON.stringify(r.chain.rejections)}`);

  const repairs = r.sdk.byAgent('setOnChainStatus');
  assert.equal(repairs.size, N, 'every agent needs its chain axis repaired');
  for (const [agentId, n] of repairs) {
    assert.equal(n, 1, `${agentId}: expected exactly one on-chain repair, got ${n}`);
  }
  for (const call of r.sdk.calls('setOnChainStatus')) assert.deepEqual(call.args, ['active']);

  assert.ok(r.logged('deactivate confirmed'), 'should observe the deactivates landing');
  assert.ok(r.logged('repaired on-chain'));

  // Both axes back, and nothing left telling the next start to retry.
  r.chain.mineBlock(r.clock.now());
  assert.equal(r.chain.hireable().length, N);
  assert.equal(r.shutdownMarker(), null, 'a fully restored fleet must clear the marker');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The chain-stranded agent (live: agent-6 and agent-7 on 2026-08-12).
//
// chain=inactive, platform=active. The hire gate ANDs both axes, so the platform
// silently refuses these agents while `platformStatus` reads `active`.
//
// Two sub-cases, and they must behave DIFFERENTLY:
//
//   in the shutdown marker  → we turned it off; starting up is an instruction to
//                             bring it back, so repair the chain axis.
//   not in the marker       → we did not turn it off. The chain axis is where a
//                             genuine retirement is recorded, so auto-writing
//                             `active` would resurrect an agent its owner
//                             deliberately retired. Skip it — but say which axis
//                             is blocking, or the operator checks platformStatus,
//                             sees `active`, and concludes we are confused.
// ─────────────────────────────────────────────────────────────────────────────

test('a chain-stranded agent IN the shutdown marker is repaired; its healthy neighbour is not touched', async (t) => {
  const agents = [
    { id: 'agent-1', identity: 'agent1@', iAddress: 'iAgent1', chainStatus: 'active', platformStatus: 'active' },
    { id: 'agent-6', identity: 'agent6@', iAddress: 'iAgent6', chainStatus: 'inactive', platformStatus: 'active' },
  ];
  const r = await started({
    agents,
    shutdownMarker: { at: '2026-08-13T11:55:00.000Z', agents: ['agent-6'], txids: {} },
  });
  t.after(() => r.teardown());

  assert.equal(r.chain.rejections.length, 0);
  const byAgent = r.sdk.byAgent('setOnChainStatus');
  assert.equal(byAgent.get('agent-6'), 1, 'the stranded agent must be repaired');
  assert.equal(byAgent.get('agent-1'), undefined, 'the healthy agent must not be written to');

  const snap = r.chain.snapshot();
  assert.equal(snap['agent-1'].writes, 0);
  assert.equal(snap['agent-6'].writes, 1);

  // RECORD THE REPAIR TXID. Without this the repair is invisible to the inbox
  // sweep that fires at +60s, and the sweep then builds its batched identity
  // write from the last CONFIRMED prevOutput — double-spending the repair. That
  // is the C1 asymmetry the code's own comment criticises in 2.27.0, and the
  // repair is the write most likely to still be unconfirmed after an upgrade,
  // because downtime is exactly when reviews and attestations pile up.
  const repairTxid = r.sdk.calls('setOnChainStatus')[0].result;
  assert.equal(r.state._inboxLastWrite.get('agent-6')?.txid, repairTxid,
    'the repair write must be recorded so the first inbox sweep defers instead of double-spending it');
  assert.equal(r.state._inboxLastWrite.has('agent-1'), false, 'no write, nothing to record');
});

test('a chain-stranded agent NOT in the marker is skipped, and the skip names the blocking axis', async (t) => {
  const r = await started({
    agents: [
      { id: 'agent-1', identity: 'agent1@', iAddress: 'iAgent1', chainStatus: 'active', platformStatus: 'active' },
      { id: 'agent-6', identity: 'agent6@', iAddress: 'iAgent6', chainStatus: 'inactive', platformStatus: 'active' },
    ],
  });
  t.after(() => r.teardown());

  assert.equal(r.sdk.count('setOnChainStatus'), 0,
    'never write `active` on-chain for an agent we did not turn off — that axis is where retirement lives');
  assert.equal(r.state.agents.length, 1, 'the stranded agent is not polled');

  // Pin the WHOLE line, not the substring. `logged('chain=inactive')` would be
  // satisfied by that text appearing anywhere, including on a different agent.
  assert.ok(r.logged('agent-6 (agent6@): inactive — skipping (chain=inactive)'),
    'the skip line must name the axis that is actually blocking');
  assert.ok(!r.logged('agent-6 (agent6@): inactive on platform'),
    'the platform axis reads `active` here — saying otherwise sends the operator to the wrong field');
  assert.ok(!r.logged('platform=active'),
    'an axis that is fine must not be listed as a reason for skipping');
  assert.ok(r.logged('j41-dispatcher activate agent-6'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. A repair that cannot land must be LOUD, must not clear the marker, and must
//    show up on /health.
//
//    On the SDK's failure shapes, because getting this backwards sends the next
//    reader to the wrong branch: `setOnChainStatus` THROWS on a dry fee tank
//    ("No UTXOs available for TX fee") and on a rejected broadcast — that path is
//    covered by the fail-then-retry test below. It returns a null-ish txid only
//    when the broadcast resolves without one. Both branches exist in cli.js and
//    both are worth covering; this test is the null-return one.
// ─────────────────────────────────────────────────────────────────────────────

test('a repair that returns no txid degrades /health and keeps the agent in the marker', async (t) => {
  const r = await started({
    agents: [{
      id: 'agent-1', identity: 'agent1@', iAddress: 'iAgent1',
      chainStatus: 'active', platformStatus: 'inactive',
      pending: { txid: 'tx-deact-1', status: 'inactive' },
    }],
    shutdownMarker: { at: '2026-08-13T11:55:00.000Z', agents: ['agent-1'], txids: { 'agent-1': 'tx-deact-1' } },
    sdk: { blockTimeMs: 60000, faults: { 'agent-1': { setOnChainStatus: [{ return: null }] } } },
    keepHome: true,
  });
  t.after(() => r.teardown());

  assert.equal(r.chain.rejections.length, 0);
  assert.match(r.state._agentErrors.get('agent-1') || '', /on-chain status still inactive/);
  assert.ok(r.logged('the repair write returned no txid'));

  const health = r.health();
  // `notEqual(..., 'ok')` was too weak — it is satisfied by any value at all,
  // including undefined from a health builder that threw halfway.
  assert.equal(health.status, 'degraded', 'an unhireable agent must not report a healthy dispatcher');
  assert.match(health.agents.find((a) => a.id === 'agent-1').lastError || '', /on-chain status still inactive/);

  const marker = r.shutdownMarker();
  assert.ok(marker && marker.agents.includes('agent-1'),
    'an agent whose chain axis is still inactive has NOT been restored — the next start must retry it');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. A repair that throws on one start must succeed on the next.
//
//    Two real starts against the same ~/.j41, with the chain state carried over.
// ─────────────────────────────────────────────────────────────────────────────

test('a repair that fails on one start is retried and lands on the next', async (t) => {
  const agents = [{
    id: 'agent-1', identity: 'agent1@', iAddress: 'iAgent1',
    chainStatus: 'inactive', platformStatus: 'inactive',
  }];
  const marker = { at: '2026-08-13T11:55:00.000Z', agents: ['agent-1'], txids: {} };

  const first = await started({
    agents,
    shutdownMarker: marker,
    sdk: { faults: { 'agent-1': { setOnChainStatus: [{ throw: 'No UTXOs available for TX fee' }] } } },
    keepHome: true,
  });
  // Register teardown BEFORE the assertions. Doing it only via the explicit call
  // below meant a failing assertion here skipped teardown and left the virtual
  // clock installed, hanging every later test in the file. teardown() is
  // idempotent so the explicit call below is still fine.
  t.after(() => first.teardown());
  const home = first.home;
  assert.equal(first.chain.rejections.length, 0);
  assert.match(first.state._agentErrors.get('agent-1') || '', /on-chain repair failed/);
  const afterFirst = first.shutdownMarker();
  assert.ok(afterFirst && afterFirst.agents.includes('agent-1'),
    'a failed repair must leave the agent in the marker');
  await first.teardown();

  // Second start: same home, same on-chain reality (still inactive), no fault.
  const second = await started({ home, agents, keepHome: false });
  t.after(() => second.teardown());

  assert.equal(second.chain.rejections.length, 0);
  assert.equal(second.sdk.byAgent('setOnChainStatus').get('agent-1'), 1);
  assert.ok(second.logged('repaired on-chain'));
  second.chain.mineBlock(second.clock.now());
  assert.deepEqual(second.chain.hireable(), ['agent-1']);
  assert.equal(second.shutdownMarker(), null, 'a successful repair clears the marker');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5b. The pending-write gate in front of the chain repair.
//
// The inbox sweep records every identity write it makes in `state._inboxLastWrite`.
// The repair must consult that before broadcasting, because two writes on one
// prevOutput is the -25. This branch has never been reachable from a test, and it
// is where the round-2 defect lived: the map was created lazily by a +60s timer,
// so `.set` threw, the catch reported a SUCCESSFUL write as "repair FAILED", and
// the operator was told to run `activate` — broadcasting the second tx by hand.
// ─────────────────────────────────────────────────────────────────────────────

const REPAIR_NEEDED = [{
  id: 'agent-1', identity: 'agent1@', iAddress: 'iAgent1',
  chainStatus: 'inactive', platformStatus: 'inactive',
}];
const REPAIR_MARKER = { at: '2026-08-13T11:55:00.000Z', agents: ['agent-1'], txids: {} };

test('an unconfirmed identity write DEFERS the chain repair rather than double-spending it', async (t) => {
  const r = await started({
    agents: REPAIR_NEEDED,
    shutdownMarker: REPAIR_MARKER,
    onStateReady: (state) => {
      // A write we made moments ago that has not confirmed. Its txid deliberately
      // does not match the chain's prevOutput, which is what "unconfirmed" means.
      state._inboxLastWrite.set('agent-1', { txid: 'tx-inbox-unconfirmed', at: Date.now() });
    },
  });
  t.after(() => r.teardown());

  assert.equal(r.sdk.count('setOnChainStatus'), 0,
    'the repair must NOT broadcast while one of our own writes is unconfirmed');
  assert.equal(r.chain.rejections.length, 0);
  assert.ok(r.logged('SKIPPING the on-chain repair this pass'));
  assert.match(r.state._agentErrors.get('agent-1') || '', /repair deferred \(pending identity write\)/);

  const marker = r.shutdownMarker();
  assert.ok(marker && marker.agents.includes('agent-1'),
    'a deferred repair is not a completed one — the next start must retry it');
});

test('a CONFIRMED prior write clears the gate and the repair proceeds', async (t) => {
  const r = await started({
    agents: REPAIR_NEEDED,
    shutdownMarker: REPAIR_MARKER,
    onStateReady: (state) => {
      // Same seam, but this txid IS the chain's confirmed prevOutput, so
      // shouldDeferForPendingWrite() reports 'confirmed' and the gate opens.
      state._inboxLastWrite.set('agent-1', { txid: 'tx-genesis-agent-1', at: Date.now() });
    },
  });
  t.after(() => r.teardown());

  assert.equal(r.sdk.byAgent('setOnChainStatus').get('agent-1'), 1);
  assert.equal(r.chain.rejections.length, 0);
  assert.ok(!r.logged('SKIPPING the on-chain repair this pass'));
  assert.ok(r.logged('repaired on-chain'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 5c. Status must not leak from one agent to the next.
//
// The per-agent axis variables were cleared only after `readyAgents.push(...)`,
// and three paths `continue` before reaching it. So a SKIPPED agent left its axes
// loaded, and the next agent whose `authenticate()` threw took the fail-open
// "including" path and was pushed carrying the skipped agent's status.
//
// Money is downstream of this: `planAgentActivation` reads `chainStatus`, so an
// inherited `inactive` broadcasts an on-chain identity write for an agent on the
// strength of a different agent's data. Found by review, fixed, and pinned here.
// ─────────────────────────────────────────────────────────────────────────────

test('an agent whose status probe fails does NOT inherit the previous agent\'s axes', async (t) => {
  const r = await started({
    agents: [
      // Healthy, goes through cleanly.
      { id: 'agent-1', identity: 'agent1@', iAddress: 'iAgent1', chainStatus: 'active', platformStatus: 'active' },
      // Inactive and NOT in the marker, so it is SKIPPED — and used to leave its
      // axes behind in the loop variables.
      { id: 'agent-2', identity: 'agent2@', iAddress: 'iAgent2', chainStatus: 'inactive', platformStatus: 'inactive' },
      // Its first authenticate throws (the daily 04:00 UTC 503 window), so the
      // outer catch includes it without ever reading its real status.
      { id: 'agent-3', identity: 'agent3@', iAddress: 'iAgent3', chainStatus: 'active', platformStatus: 'active' },
    ],
    sdk: { faults: { 'agent-3': { authenticate: [{ throw: 'platform unavailable (503 CHAIN_SYNCING)' }] } } },
  });
  t.after(() => r.teardown());

  assert.ok(r.logged('agent-3: could not check platform status'), 'the fail-open path must be the one taken');

  const a3 = r.state.agents.find((a) => a.id === 'agent-3');
  assert.ok(a3, 'a fail-open agent is still polled');
  assert.equal(a3.chainStatus, 'unknown',
    'we did not read this agent\'s chain axis, so it must stay `unknown` — not agent-2\'s `inactive`');

  // The two harms, one per direction of the leak.
  //
  // Inherited `chain=inactive` → a repair write for an agent whose chain axis is
  // actually fine, broadcast on another agent's data.
  assert.equal(r.sdk.count('setOnChainStatus'), 0);
  // Inherited `platform=active` → "already active — no write needed", the POST
  // never happens, and the agent is silently unhireable with /health green. So
  // the activate MUST have been made. (`platformStatus` reads `active` here
  // because the activation loop set it after a successful POST — that is the
  // proof it ran, not evidence of the leak.)
  assert.equal(r.sdk.byAgent('activate').get('agent-3'), 1,
    'a fail-open agent must still get its platform POST');
  assert.ok(!r.logged('agent-3: already active — no write needed'));
  assert.equal(a3.platformStatus, 'active');
  assert.equal(r.chain.rejections.length, 0);
  assert.equal(r.chain.snapshot()['agent-3'].writes, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. A deactivate that can never be matched must not re-arm the same three-minute
//    wait on every future start, and must not release the agent from the marker.
//
//    (An operator ran `activate-all` while we were down, so the chain reads
//    `active` and prevOutput is that other write — neither release condition can
//    ever fire for the txid we recorded.)
// ─────────────────────────────────────────────────────────────────────────────

test('an unresolvable deactivate wait drops the dead txid but keeps the agent in the marker', async (t) => {
  const r = await started({
    agents: [{
      id: 'agent-1', identity: 'agent1@', iAddress: 'iAgent1',
      chainStatus: 'active', platformStatus: 'inactive',
      prevOutput: 'tx-from-someone-else',
    }],
    shutdownMarker: {
      at: '2026-08-13T11:55:00.000Z',
      agents: ['agent-1'],
      txids: { 'agent-1': 'tx-we-never-see-again' },
    },
  });
  t.after(() => r.teardown());

  assert.equal(r.chain.rejections.length, 0);
  assert.ok(r.logged('still unconfirmed after 3 min'), 'the wait must be bounded, not indefinite');

  const marker = r.shutdownMarker();
  assert.ok(marker, 'an agent whose chain state we could not establish stays in the marker');
  assert.ok(marker.agents.includes('agent-1'));
  assert.equal(marker.txids['agent-1'], undefined,
    'the unmatchable txid must be dropped, or every future start re-arms the same dead 3-minute wait');

  // The chain axis reads `active`, so there was nothing to repair and we must not
  // have guessed. `unknown`/`active` never triggers a write.
  assert.equal(r.sdk.count('setOnChainStatus'), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. An offline fleet must not send the operator to `register`. Re-registering
//    costs on-chain writes and does not fix an inactive agent — a routine
//    stop/start used to lose the whole fleet this way.
// ─────────────────────────────────────────────────────────────────────────────

test('a fleet that is inactive and unmarked exits with the recovery advice, not the register advice', async (t) => {
  const r = await runStart({
    agents: fleet(3, { chainStatus: 'inactive', platformStatus: 'inactive' }),
  });
  t.after(() => r.teardown());

  assert.deepEqual(r.exits, [1]);
  assert.ok(r.logged('none active on the platform'));
  assert.ok(r.logged('activate-all'), 'must point at the command that actually fixes it');
  assert.ok(r.logged('Do NOT re-register'));
  assert.ok(!r.logged('Run: j41-dispatcher register'),
    'never send an operator with a registered-but-offline fleet to `register`');
  assert.equal(r.chain.rejections.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. The on-chain-off default is EARNED from /v1/version, never assumed. A
//    backend that does not advertise the feature means a platform-set `inactive`
//    gets reverted by the next re-index, and a hire can land on a stopped agent.
//    There is no escrow, so this one fails closed.
// ─────────────────────────────────────────────────────────────────────────────

test('a backend that does not advertise platform-status keeps on-chain writes ON', async (t) => {
  const r = await started({
    agents: fleet(2, { chainStatus: 'inactive', platformStatus: 'inactive' }),
    shutdownMarker: { at: '2026-08-13T11:55:00.000Z', agents: ['agent-1', 'agent-2'], txids: {} },
    sdk: { version: { version: '2.28.0', features: ['tx.status-notfound-code'] } },
  });
  t.after(() => r.teardown());

  assert.ok(r.logged('does not advertise agent.platform-status-v1'));
  assert.ok(r.logged('keeping on-chain status writes ON'));

  // Fail-closed means the activate itself carries the on-chain write — and that
  // must still be ONE write per agent, not an activate plus a separate repair.
  assert.equal(r.chain.rejections.length, 0);
  // Pin the COUNT before iterating. `for (const x of [])` asserts nothing, so
  // without this the next three lines pass just as happily against an activation
  // loop that never ran at all.
  assert.equal(r.sdk.count('activate'), 2, 'both agents must be activated');
  for (const call of r.sdk.calls('activate')) {
    assert.equal(call.args[0].onChain, true);
  }
  assert.equal(r.sdk.count('setOnChainStatus'), 0,
    'the activate is already writing on-chain; a separate repair would be a second write on one prevOutput');
  for (const rec of Object.values(r.chain.snapshot())) assert.equal(rec.writes, 1);
});

test('a fail-closed activate whose on-chain half returns no txid is reported, not ticked', async (t) => {
  // The SDK returns a null `onChainTxid` rather than throwing when the on-chain
  // half of an activate fails. We once printed "✅ active (on-chain txid: skipped)"
  // for that — which is how nine consecutive rejected writes were reported as
  // success while the fleet sat unhireable. No scenario previously made this
  // branch fire: every fail-closed run had a clean chain, so `onChainTxid` was
  // always non-null.
  //
  // A stuck pending write is what makes the activate's write fail here: the chain
  // model rejects a second unconfirmed write, and the SDK swallows that to null.
  const r = await started({
    agents: [{
      id: 'agent-1', identity: 'agent1@', iAddress: 'iAgent1',
      chainStatus: 'active', platformStatus: 'inactive',
      pending: { txid: 'tx-stuck-forever', status: 'inactive' },
    }],
    shutdownMarker: { at: '2026-08-13T11:55:00.000Z', agents: ['agent-1'], txids: {} },
    // No feature flag → on-chain writes stay ON (fail-closed).
    // A block time longer than the run keeps the pending write unconfirmed.
    sdk: { version: { version: '2.28.0', features: [] }, blockTimeMs: 6 * 60 * 60 * 1000 },
  });
  t.after(() => r.teardown());

  assert.equal(r.sdk.count('activate'), 1);
  assert.equal(r.sdk.calls('activate')[0].result.onChainTxid, null,
    'the scenario is only meaningful if the on-chain half actually failed');

  assert.match(r.state._agentErrors.get('agent-1') || '', /on-chain activate failed/);
  assert.ok(r.logged('ON-CHAIN activate FAILED'));
  assert.equal(r.health().status, 'degraded',
    'an agent whose chain axis may still say inactive must not leave /health green');
});

test('an unreachable /v1/version also keeps on-chain writes ON', async (t) => {
  const r = await started({
    agents: fleet(1, { chainStatus: 'inactive', platformStatus: 'inactive' }),
    shutdownMarker: { at: '2026-08-13T11:55:00.000Z', agents: ['agent-1'], txids: {} },
    sdk: { version: new Error('ECONNREFUSED') },
  });
  t.after(() => r.teardown());

  assert.ok(r.logged('could not read /v1/version'));
  assert.ok(r.logged('keeping on-chain status writes ON'));
  assert.equal(r.chain.rejections.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. The health document is the monitor-room contract. The failure it exists to
//    prevent is "fleet unhireable, every surface green".
// ─────────────────────────────────────────────────────────────────────────────

test('/health reports both status axes for every agent', async (t) => {
  const r = await started({ agents: fleet(2) });
  t.after(() => r.teardown());

  const health = r.health();
  assert.equal(health.agents.length, 2);
  for (const a of health.agents) {
    assert.equal(a.platformStatus, 'active');
    assert.equal(a.chainStatus, 'active', 'the chain axis must be on the health document, not inferred');
  }
  assert.equal(health.status, 'ok');
});
