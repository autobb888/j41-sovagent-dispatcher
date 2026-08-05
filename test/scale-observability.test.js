'use strict';
/**
 * A dispatcher that cannot keep up must not look idle.
 *
 * Plan 4. Each loop guards against reentrancy, but two of the three returned
 * SILENTLY when the previous cycle was still running:
 *
 *   pollForJobs    (_polling)            silent  -> the fleet stops looking for work
 *   checkFeeTanks  (_feeSweepRunning)    silent  -> tanks stop being watched
 *   checkPendingInbox (_inboxSweepRunning) warned
 *
 * The second is the dangerous one: a fee-tank check that quietly stops running
 * is exactly how agent-6 drained to zero and went silent on-chain on 2026-08-05.
 * Both now log AND expose a counter on /health, because a log line nobody greps
 * is not observability.
 *
 * On the numbers: checkFeeTanks measured ~N x latency (N=100 at 500ms -> ~50s)
 * against a 30-minute interval, so it has ample headroom. The exposure is
 * pollForJobs, whose budget is only max(60s, N*1s) while it does (N-1)*500ms of
 * stagger plus N API round trips — overrunning from roughly 30 agents at a 1.5s
 * round trip.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildHealthDocument } = require('../src/control.js');

const baseState = (over = {}) => ({
  agents: [], active: new Map(), available: [], queue: [], seen: new Map(),
  retries: new Map(), agentSessions: new Map(), _agentErrors: new Map(),
  _containerCrashes: new Map(), _inboxFailures: new Map(), ...over,
});

test('a healthy daemon reports zero skipped cycles', () => {
  const d = buildHealthDocument(baseState(), Date.now() - 1000);
  assert.equal(d.summary.poll_cycles_skipped, 0);
  assert.equal(d.summary.fee_tank_cycles_skipped, 0);
});

test('skipped cycles are visible on /health, not just in a log', () => {
  const d = buildHealthDocument(baseState({ _pollSkips: 7, _feeSweepSkips: 3 }), Date.now() - 1000);
  assert.equal(d.summary.poll_cycles_skipped, 7);
  assert.equal(d.summary.fee_tank_cycles_skipped, 3);
});

test('an older state object without the counters does not break the document', () => {
  // buildHealthDocument runs against long-lived daemon state; a missing field
  // must read as zero rather than undefined or NaN.
  for (const bad of [undefined, null, NaN, 'lots', {}]) {
    const d = buildHealthDocument(baseState({ _pollSkips: bad, _feeSweepSkips: bad }), Date.now() - 1000);
    assert.equal(d.summary.poll_cycles_skipped, 0, `_pollSkips=${String(bad)}`);
    assert.equal(d.summary.fee_tank_cycles_skipped, 0, `_feeSweepSkips=${String(bad)}`);
  }
});

test('an overrunning daemon still reports status ok — skips are a capacity signal, not a fault', () => {
  // Deliberate: skipped cycles mean "too many agents for this interval", which an
  // operator resolves by tuning, not by treating the daemon as broken. It must be
  // countable without being alarming.
  const d = buildHealthDocument(baseState({ _pollSkips: 50 }), Date.now() - 1000);
  assert.equal(d.status, 'ok');
  assert.equal(d.summary.poll_cycles_skipped, 50);
});
