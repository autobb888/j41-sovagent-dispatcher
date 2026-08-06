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

// ── shutdown → start fleet handoff ───────────────────────────────────────────

test('the shutdown marker round-trips, and absent means restore nothing', () => {
  clearShutdownDeactivated();
  assert.deepEqual(readShutdownDeactivated(), [], 'absent must not be an error');

  writeShutdownDeactivated(['agent-1', 'agent-2']);
  assert.deepEqual(readShutdownDeactivated(), ['agent-1', 'agent-2']);

  clearShutdownDeactivated();
  assert.deepEqual(readShutdownDeactivated(), []);
});

test('a corrupt marker restores nothing rather than throwing on startup', () => {
  clearShutdownDeactivated();
  fs.writeFileSync(SHUTDOWN_DEACTIVATED_FILE, '{ this is not json');
  assert.deepEqual(readShutdownDeactivated(), [],
    'a torn marker must never stop the dispatcher from starting');
  clearShutdownDeactivated();
});

test('the marker is written atomically — a reader never sees a partial file', () => {
  clearShutdownDeactivated();
  writeShutdownDeactivated(['agent-1']);
  // No .tmp left behind: the write is tmp+rename, so a crash mid-write cannot
  // leave a half-written marker that strands the fleet.
  assert.equal(fs.existsSync(`${SHUTDOWN_DEACTIVATED_FILE}.tmp`), false);
  clearShutdownDeactivated();
});

test('writing an empty list does not create a marker', () => {
  clearShutdownDeactivated();
  writeShutdownDeactivated([]);
  assert.equal(fs.existsSync(SHUTDOWN_DEACTIVATED_FILE), false,
    'a shutdown that deactivated nothing must not make the next start reactivate anything');
});
