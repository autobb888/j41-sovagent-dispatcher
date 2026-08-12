/**
 * B1 — /health must reflect whether the PLATFORM still considers an agent online.
 *
 * Live failure 2026-08-06: a routine restart left all nine agents `inactive` on the
 * platform. Every dispatcher surface — /health, /metrics, ctl status, the control API
 * — reported `status: ok` with all agents `available`, because agent status was
 * derived purely from local job assignment and platform state was never queried at
 * all (zero references in control.js). A monitoring endpoint that stays green through
 * a total outage is worse than no endpoint: it actively suppresses the alarm.
 *
 * `unknown` deliberately does NOT degrade — it means "not checked yet", and treating
 * absence of information as failure would make every cold start look broken.
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildHealthDocument } = require('../src/control');

function stateWith(agents) {
  return {
    agents,
    active: new Map(),
    available: [],
    queue: [],
    reactivationQueue: [],
    seen: new Map(),
    _agentErrors: new Map(),
    _containerCrashes: new Map(),
    _inboxFailures: new Map(),
    startedAt: Date.now() - 1000,
    startupComplete: true, // the degrade only applies once activation has finished
  };
}

test('an agent the platform considers inactive is visible in the health document', () => {
  const doc = buildHealthDocument(stateWith([
    { id: 'agent-1', identity: 'a1@', platformStatus: 'inactive' },
  ]), Date.now() - 1000);

  assert.equal(doc.agents[0].platformStatus, 'inactive');
});

test('an inactive agent degrades the whole document — it cannot receive work', () => {
  const doc = buildHealthDocument(stateWith([
    { id: 'agent-1', identity: 'a1@', platformStatus: 'active' },
    { id: 'agent-2', identity: 'a2@', platformStatus: 'inactive' },
  ]), Date.now() - 1000);

  assert.equal(doc.status, 'degraded',
    'this is the exact 2026-08-06 state that reported ok');
});

test('a disabled agent degrades too', () => {
  const doc = buildHealthDocument(stateWith([
    { id: 'agent-1', identity: 'a1@', platformStatus: 'disabled' },
  ]), Date.now() - 1000);
  assert.equal(doc.status, 'degraded');
});

test('a fully active fleet is ok', () => {
  const doc = buildHealthDocument(stateWith([
    { id: 'agent-1', identity: 'a1@', platformStatus: 'active' },
    { id: 'agent-2', identity: 'a2@', platformStatus: 'active' },
  ]), Date.now() - 1000);
  assert.equal(doc.status, 'ok');
});

test('unknown does not degrade — "not checked yet" is not "broken"', () => {
  // A cold start, or a start with the platform-status check skipped, must not look
  // like an outage. Only a positive inactive/disabled reading is a fault.
  const doc = buildHealthDocument(stateWith([
    { id: 'agent-1', identity: 'a1@' },                          // no field at all
    { id: 'agent-2', identity: 'a2@', platformStatus: 'unknown' },
  ]), Date.now() - 1000);

  assert.equal(doc.agents[0].platformStatus, 'unknown', 'absent reads as unknown, never as active');
  assert.equal(doc.status, 'ok');
});

test('the startup window does not degrade — agents are not activated yet', () => {
  // The health server binds before the staggered activation loop runs, so every
  // restart would otherwise fire an alert. An alarm that cries wolf on every restart
  // is how the 2026-08-06 outage went unnoticed to begin with.
  const st = stateWith([{ id: 'agent-1', identity: 'a1@', platformStatus: 'inactive' }]);
  st.startupComplete = false;
  assert.equal(buildHealthDocument(st, Date.now() - 1000).status, 'ok');

  st.startupComplete = true;
  assert.equal(buildHealthDocument(st, Date.now() - 1000).status, 'degraded',
    'once startup is done, an inactive agent is a real fault');
});

// ── The second axis (Fable, review of 2.29.0) ───────────────────────────────
//
// Once the dispatcher stopped writing on-chain status on a routine restart, the
// chain axis became able to sit at `inactive` from an older dispatcher while the
// platform axis reads `active`. The startup loop stamps `platformStatus='active'`
// after a successful platform write, so a document built from that field alone
// reports a green fleet the platform's hire gate is blocking — the 2026-08-06
// shape, reproduced by the release meant to prevent it.

test('an agent inactive on the CHAIN axis degrades, even when the platform axis is active', () => {
  const doc = buildHealthDocument(stateWith([
    { id: 'agent-1', identity: 'a1@', platformStatus: 'active', chainStatus: 'inactive' },
  ]), Date.now() - 1000);

  assert.equal(doc.agents[0].chainStatus, 'inactive', 'the axis must be visible, not just folded in');
  assert.equal(doc.status, 'degraded',
    'the hire gate ANDs both axes; /health must agree or it lies about a blocked fleet');
});

test('both axes active is ok', () => {
  const doc = buildHealthDocument(stateWith([
    { id: 'agent-1', identity: 'a1@', platformStatus: 'active', chainStatus: 'active' },
  ]), Date.now() - 1000);
  assert.equal(doc.status, 'ok');
});

test('an unknown chain axis does not degrade', () => {
  // Same rule as the platform axis: "not checked yet" is not "broken", or every
  // cold start looks like an outage.
  const doc = buildHealthDocument(stateWith([
    { id: 'agent-1', identity: 'a1@', platformStatus: 'active' },
  ]), Date.now() - 1000);
  assert.equal(doc.agents[0].chainStatus, 'unknown');
  assert.equal(doc.status, 'ok');
});

// ── Two fleet-down shapes that still read "ok" (round 5) ────────────────────

test('an agent carrying a live error degrades, even with both axes unknown', () => {
  // A restart during the daily ~04:00 platform outage: the pre-start status check
  // fails, both axes read `unknown` (fail-open include), every activation fails,
  // zero agents can work — and the document said `ok`. `unknown` deliberately does
  // not degrade on its own, which is precisely why the recorded error must.
  const st = stateWith([
    { id: 'agent-1', identity: 'a1@' },
    { id: 'agent-2', identity: 'a2@' },
  ]);
  st._agentErrors.set('agent-1', 'activation failed: 503 CHAIN_SYNCING');
  const doc = buildHealthDocument(st, Date.now() - 1000);

  assert.equal(doc.status, 'degraded', 'a fleet that activated nothing is not ok');
  assert.match(doc.agents[0].lastError, /503/);
});

test('a startup that never completes eventually degrades on its own', () => {
  // The zombie: startup dies partway, the axis degrade is gated on
  // startupComplete, and /health stays green forever while the process does
  // nothing. Past a generous bound, not having finished IS the fault.
  const st = stateWith([{ id: 'agent-1', identity: 'a1@', platformStatus: 'active', chainStatus: 'active' }]);
  st.startupComplete = false;

  st.startedAt = Date.now() - 60_000;              // one minute in
  assert.equal(buildHealthDocument(st, Date.now() - 1000).status, 'ok',
    'a normal startup window must not alert');

  st.startedAt = Date.now() - 21 * 60 * 1000;      // well past any real startup
  assert.equal(buildHealthDocument(st, Date.now() - 1000).status, 'degraded',
    'a startup still unfinished after 20 minutes is wedged');
});

test('a clean fleet with no errors is still ok', () => {
  const st = stateWith([{ id: 'agent-1', identity: 'a1@', platformStatus: 'active', chainStatus: 'active' }]);
  st.startedAt = Date.now() - 60_000;
  assert.equal(buildHealthDocument(st, Date.now() - 1000).status, 'ok');
});
