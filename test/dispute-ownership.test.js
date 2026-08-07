/**
 * Who owns a job in `disputed` / `rework` when no worker is alive?
 *
 * Before this: nobody. `pollForJobs` keeps only requested/accepted/in_progress and
 * the post-delivery transition check iterates `state.active`, which by definition
 * no longer holds a job whose container exited. A dispute deadline is DAYS; a
 * worker's post-delivery hold was ~90 minutes. Every dispute filed after that gap
 * was invisible to the entire dispatcher until it lapsed on the platform's default
 * terms. Our whole test history passed only because the buyer always acted inside
 * the 90 minutes.
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  shouldReconcileJob,
  MAX_RECONCILE_RESPAWNS_PER_SWEEP,
  MAX_RECONCILE_ATTEMPTS_PER_JOB,
  reconcileOrphanedDisputes,
  readShutdownDeactivated,
  writeShutdownDeactivated,
  clearShutdownDeactivated,
  SHUTDOWN_DEACTIVATED_FILE,
} = require('../src/cli.js');

const { isPostDeliveryReconnect, ensureChatConnected } = require('../src/job-agent.js');

// ── job status routing ───────────────────────────────────────────────────────

test('rework counts as post-delivery — a respawn must never re-accept the job', () => {
  // The omission was expensive: a container spawned for a job already in rework fell
  // through to signAccept + acceptJob, hit a retry wall, and the dispatcher queued a
  // refund for a job that had BOTH a delivery and a seller-agreed rework.
  assert.equal(isPostDeliveryReconnect('rework'), true);
});

test('every post-delivery status is covered, and pre-delivery ones are not', () => {
  for (const s of ['delivered', 'disputed', 'rework', 'resolved', 'resolved_rejected']) {
    assert.equal(isPostDeliveryReconnect(s), true, `${s} must be post-delivery`);
  }
  for (const s of ['requested', 'accepted', 'in_progress', 'paused', undefined, null, '']) {
    assert.equal(isPostDeliveryReconnect(s), false, `${s} must NOT be post-delivery`);
  }
});

// ── chat room membership ─────────────────────────────────────────────────────

function chatAgent({ connected, rooms = [] }) {
  const calls = [];
  const agent = {
    calls,
    chatClient: { isConnected: connected, joinedRooms: new Set(rooms) },
    authenticate: async () => { calls.push('authenticate'); },
    connectChat: async () => { calls.push('connectChat'); agent.chatClient.isConnected = true; },
    joinJobChat: (id) => { calls.push('join'); agent.chatClient.joinedRooms.add(id); },
  };
  return agent;
}

test('connected but not in the room still joins — the respawn case that lost the rework', async () => {
  // connectChat() auto-joins only accepted + in_progress jobs, so a post-delivery
  // respawn is connected and NOT a member. Gating on isConnected alone returned
  // early and emitted into a room the agent had never joined; sendMessage is an
  // ack-less socket emit, so nothing threw and the logs read healthy.
  const agent = chatAgent({ connected: true, rooms: [] });
  await ensureChatConnected(agent, 'job-1');
  assert.deepEqual(agent.calls, ['join']);
  assert.ok(agent.chatClient.joinedRooms.has('job-1'));
});

test('already in the room does not re-join — re-joining duplicates every message', async () => {
  const agent = chatAgent({ connected: true, rooms: ['job-1'] });
  await ensureChatConnected(agent, 'job-1');
  assert.deepEqual(agent.calls, []);
});

test('a dead socket re-authenticates, reconnects, then joins — in that order', async () => {
  const agent = chatAgent({ connected: false, rooms: [] });
  await ensureChatConnected(agent, 'job-1');
  assert.deepEqual(agent.calls, ['authenticate', 'connectChat', 'join']);
});

test('an SDK without joinedRooms joins once, then never again — no silent loss, no duplicates', async () => {
  // Version-robustness: assuming "joined" loses messages silently; assuming
  // "not joined" duplicates every one. Track our own joins instead.
  const calls = [];
  const agent = {
    chatClient: { isConnected: true }, // no joinedRooms on this SDK
    authenticate: async () => calls.push('authenticate'),
    connectChat: async () => calls.push('connectChat'),
    joinJobChat: () => calls.push('join'),
  };
  await ensureChatConnected(agent, 'legacy-sdk-job');
  await ensureChatConnected(agent, 'legacy-sdk-job');
  assert.deepEqual(calls, ['join'], 'exactly one join across repeated calls');
});

test('an agent that cannot manage its socket is left alone rather than crashed', async () => {
  // A partially-featured agent must degrade to "let the send report the truth",
  // not throw and lose the message before it is even attempted.
  const agent = { sendChatMessage: async () => {} };
  await assert.doesNotReject(() => ensureChatConnected(agent, 'j'));
});

test('a reconnect that restores room membership itself does not double-join', async () => {
  // The SDK replays joinedRooms on socket reconnect, so connectChat may already
  // have restored membership.
  const agent = chatAgent({ connected: false, rooms: [] });
  agent.connectChat = async () => {
    agent.calls.push('connectChat');
    agent.chatClient.isConnected = true;
    agent.chatClient.joinedRooms.add('job-1'); // replayed by the SDK
  };
  await ensureChatConnected(agent, 'job-1');
  assert.deepEqual(agent.calls, ['authenticate', 'connectChat']);
});

// ── the reconciler ───────────────────────────────────────────────────────────

function reconState({ jobsByAgent, active = [], queue = [], reactivationQueue = [] }) {
  return {
    agents: Object.keys(jobsByAgent).map(id => ({ id })),
    active: new Map(active.map(id => [id, { agentId: 'a' }])),
    queue: queue.map(id => ({ id })),
    reactivationQueue: reactivationQueue.map(id => ({ job: { id } })),
    _jobsByAgent: jobsByAgent,
  };
}

function reconOpts(state, calls, { throwFor = null } = {}) {
  return {
    getAgentSession: async (_s, agentInfo) => ({
      client: {
        getMyJobs: async ({ status }) => {
          if (throwFor === agentInfo.id) throw new Error('platform 503');
          return { data: (state._jobsByAgent[agentInfo.id] || []).filter(j => j.status === status) };
        },
      },
    }),
    refundLedger: {},
    queueDisputedJobForRespawn: async (_s, jobId, o) => { calls.push({ jobId, agentId: o.agentId }); return { respawned: true }; },
  };
}

test('a disputed job with no worker is respawned', async () => {
  const state = reconState({ jobsByAgent: { 'agent-6': [{ id: 'j1', status: 'disputed' }] } });
  const calls = [];
  const r = await reconcileOrphanedDisputes(state, reconOpts(state, calls));
  assert.deepEqual(calls, [{ jobId: 'j1', agentId: 'agent-6' }]);
  assert.equal(r.orphaned, 1);
  assert.equal(r.respawned, 1);
});

test('a rework job with no worker is respawned — this is the one that silently died', async () => {
  const state = reconState({ jobsByAgent: { 'agent-6': [{ id: 'j2', status: 'rework' }] } });
  const calls = [];
  await reconcileOrphanedDisputes(state, reconOpts(state, calls));
  assert.deepEqual(calls.map(c => c.jobId), ['j2']);
});

test('a job that already has a live worker is left alone', async () => {
  const state = reconState({
    jobsByAgent: { 'agent-6': [{ id: 'j3', status: 'disputed' }] },
    active: ['j3'],
  });
  const calls = [];
  const r = await reconcileOrphanedDisputes(state, reconOpts(state, calls));
  assert.deepEqual(calls, []);
  assert.equal(r.orphaned, 0);
});

test('a job already waiting for capacity is not queued twice', async () => {
  const state = reconState({
    jobsByAgent: { 'agent-6': [{ id: 'j4', status: 'rework' }] },
    reactivationQueue: ['j4'],
  });
  const calls = [];
  await reconcileOrphanedDisputes(state, reconOpts(state, calls));
  assert.deepEqual(calls, [], 'respawning a queued job would double-spawn under load');
});

test('one unreachable agent does not stop the fleet-wide sweep', async () => {
  const state = reconState({
    jobsByAgent: {
      'agent-1': [{ id: 'jA', status: 'disputed' }],
      'agent-2': [{ id: 'jB', status: 'disputed' }],
    },
  });
  const calls = [];
  const r = await reconcileOrphanedDisputes(state, reconOpts(state, calls, { throwFor: 'agent-1' }));
  assert.deepEqual(calls.map(c => c.jobId), ['jB'], 'agent-2 must still be swept');
  assert.equal(r.failed, 1);
});

test('nothing to do is silent and cheap', async () => {
  const state = reconState({ jobsByAgent: { 'agent-6': [] } });
  const calls = [];
  const r = await reconcileOrphanedDisputes(state, reconOpts(state, calls));
  assert.deepEqual(calls, []);
  assert.equal(r.orphaned, 0);
  assert.equal(r.failed, 0);
});

// ── which orphans are worth a container ──────────────────────────────────────
//
// Caught live: the first sweep after upgrading respawned EVERY historical dispute
// on the account — including months-old ones already sitting in the operator's
// refund-approval queue — and spawned a container for each.

const FUTURE = new Date(Date.now() + 86400000).toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();

test('a job already queued for operator refund approval is never respawned', () => {
  // The load-bearing check. getMyJobs list items carry no nested `dispute`, so the
  // deadline/answered rules see {} and default every historical dispute to "open".
  // Live, that classified 24 months-old outage jobs as actionable and respawned 3
  // per poll cycle, forever. A job awaiting a human approval step cannot be
  // advanced by anything we spawn.
  const v = shouldReconcileJob(
    { id: 'j', status: 'disputed' },
    Date.now(),
    { refundLedger: { j: { status: 'pending_approval' } } },
  );
  assert.equal(v.respawn, false);
});

test('the ledger check beats even an actionable rework — the operator owns it', () => {
  const v = shouldReconcileJob(
    { id: 'j', status: 'rework' },
    Date.now(),
    { refundLedger: { j: { status: 'approved' } } },
  );
  assert.equal(v.respawn, false);
});

test('a job absent from the ledger is unaffected by it', () => {
  const v = shouldReconcileJob(
    { id: 'j', status: 'rework' },
    Date.now(),
    { refundLedger: { other: { status: 'pending_approval' } } },
  );
  assert.equal(v.respawn, true);
});

test('a lapsed dispute is not worth a container — nothing we spawn can change it', () => {
  const v = shouldReconcileJob({ id: 'j', status: 'disputed', dispute: { action: 'pending', deadline_at: PAST } });
  assert.equal(v.respawn, false);
});

test('an already-answered dispute is owned by the refund/rework path, not a worker', () => {
  for (const action of ['refund', 'rework', 'rejected']) {
    const v = shouldReconcileJob({ id: 'j', status: 'disputed', dispute: { action, deadline_at: FUTURE } });
    assert.equal(v.respawn, false, `action=${action} must not respawn`);
  }
});

test('an open unanswered dispute inside its deadline IS worth a container', () => {
  const v = shouldReconcileJob({ id: 'j', status: 'disputed', dispute: { action: 'pending', deadline_at: FUTURE } });
  assert.equal(v.respawn, true);
});

test('rework is always actionable — there is work to redo', () => {
  assert.equal(shouldReconcileJob({ id: 'j', status: 'rework' }).respawn, true);
  // even with no dispute object attached
  assert.equal(shouldReconcileJob({ id: 'j', status: 'rework', dispute: { action: 'rework' } }).respawn, true);
});

test('a missing deadline is treated as open — refusing on absent data recreates the hole', () => {
  const v = shouldReconcileJob({ id: 'j', status: 'disputed', dispute: { action: 'pending' } });
  assert.equal(v.respawn, true);
});

test('camelCase deadline is honoured too (platform field-shape drift)', () => {
  const v = shouldReconcileJob({ id: 'j', status: 'disputed', dispute: { action: 'pending', deadlineAt: PAST } });
  assert.equal(v.respawn, false);
});

test('malformed input never respawns', () => {
  for (const j of [null, undefined, {}, { status: 'disputed' }]) {
    assert.equal(shouldReconcileJob(j).respawn, false);
  }
});

test('a sweep is capped, and what it defers is reported rather than dropped', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    id: `job-${i}`, status: 'rework',
  }));
  const state = reconState({ jobsByAgent: { 'agent-6': many } });
  const calls = [];
  const r = await reconcileOrphanedDisputes(state, reconOpts(state, calls));

  assert.equal(calls.length, MAX_RECONCILE_RESPAWNS_PER_SWEEP,
    'must not spawn a container for every historical dispute at once');
  assert.equal(r.orphaned, 12);
  assert.equal(r.deferred, 12 - MAX_RECONCILE_RESPAWNS_PER_SWEEP,
    'deferred work must be counted, not silently truncated');
});

test('non-actionable orphans are counted separately from deferred ones', async () => {
  const state = reconState({
    jobsByAgent: {
      'agent-6': [
        { id: 'old', status: 'disputed', dispute: { action: 'refund', deadline_at: PAST } },
        { id: 'live', status: 'rework' },
      ],
    },
  });
  const calls = [];
  const r = await reconcileOrphanedDisputes(state, reconOpts(state, calls));
  assert.deepEqual(calls.map(c => c.jobId), ['live']);
  assert.equal(r.skipped, 1);
  assert.equal(r.deferred, 0);
});

// ── a job that can never make progress ───────────────────────────────────────
//
// Round 7, live: the platform's second-dispute insert failed on a unique constraint
// (Postgres 23505) but moved the job to `disputed` anyway, so it reported disputed
// with no dispute record behind it. Nothing could ever resolve it, and the sweep
// respawned a worker 14 times. Retrying forever is a resource leak, not resilience.

test('a job that never progresses is abandoned after a bounded number of respawns', async () => {
  const state = reconState({ jobsByAgent: { 'agent-6': [{ id: 'stuck', status: 'disputed' }] } });
  const calls = [];
  const opts = reconOpts(state, calls);

  // Sweep repeatedly, as the poll loop would.
  for (let i = 0; i < 10; i++) await reconcileOrphanedDisputes(state, opts);

  assert.equal(calls.length, MAX_RECONCILE_ATTEMPTS_PER_JOB,
    'must stop respawning a job it cannot advance');
});

test('giving up is counted and reported, not silent', async () => {
  const state = reconState({ jobsByAgent: { 'agent-6': [{ id: 'stuck', status: 'disputed' }] } });
  const opts = reconOpts(state, []);
  for (let i = 0; i < 5; i++) await reconcileOrphanedDisputes(state, opts);
  const last = await reconcileOrphanedDisputes(state, opts);
  assert.equal(last.stuck, 1, 'a stuck job must remain visible in the summary');
  assert.equal(last.respawned, 0);
});

test('the give-up is per job — a healthy job is unaffected by a stuck neighbour', async () => {
  const state = reconState({
    jobsByAgent: { 'agent-6': [{ id: 'stuck', status: 'disputed' }] },
  });
  const calls = [];
  const opts = reconOpts(state, calls);
  for (let i = 0; i < 6; i++) await reconcileOrphanedDisputes(state, opts);
  assert.equal(calls.length, MAX_RECONCILE_ATTEMPTS_PER_JOB);

  // A new job appears later and must still be served.
  state._jobsByAgent['agent-6'].push({ id: 'fresh', status: 'rework' });
  await reconcileOrphanedDisputes(state, opts);
  assert.ok(calls.some(c => c.jobId === 'fresh'), 'a stuck job must not starve new work');
});

// ── shutdown → start fleet handoff ───────────────────────────────────────────

// These tests MUST NOT touch the operator's real ~/.j41/dispatcher state. An
// earlier version of this file called the marker helpers with their default path
// and deleted a live dispatcher's marker mid-restart, silently un-restoring three
// agents on the next start. Every call below passes an explicit temp path.
const MARKER = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'j41-marker-')), 'shutdown-deactivated.json');

test('the marker helpers never touch the real dispatcher directory by accident', () => {
  // Regression pin for the incident above: the default path is the live one, so a
  // test that omits the argument is writing to production.
  assert.ok(SHUTDOWN_DEACTIVATED_FILE.includes('.j41'), 'default path is the live one');
  assert.ok(!MARKER.includes('.j41'), 'tests must use a temp path');
});

test('the shutdown marker round-trips, and absent means restore nothing', () => {
  clearShutdownDeactivated(MARKER);
  assert.deepEqual(readShutdownDeactivated(MARKER), [], 'absent must not be an error');

  writeShutdownDeactivated(['agent-1', 'agent-2'], MARKER);
  assert.deepEqual(readShutdownDeactivated(MARKER), ['agent-1', 'agent-2']);

  clearShutdownDeactivated(MARKER);
  assert.deepEqual(readShutdownDeactivated(MARKER), []);
});

test('a corrupt marker restores nothing rather than throwing on startup', () => {
  clearShutdownDeactivated(MARKER);
  fs.writeFileSync(MARKER, '{ this is not json');
  assert.deepEqual(readShutdownDeactivated(MARKER), [],
    'a torn marker must never stop the dispatcher from starting');
  clearShutdownDeactivated(MARKER);
});

test('the marker is written atomically — a reader never sees a partial file', () => {
  clearShutdownDeactivated(MARKER);
  writeShutdownDeactivated(['agent-1'], MARKER);
  assert.equal(fs.existsSync(`${MARKER}.tmp`), false);
  clearShutdownDeactivated(MARKER);
});

test('writing an empty list does not create a marker', () => {
  clearShutdownDeactivated(MARKER);
  writeShutdownDeactivated([], MARKER);
  assert.equal(fs.existsSync(MARKER), false,
    'a shutdown that deactivated nothing must not make the next start reactivate anything');
});
