/**
 * WP-D1/D2: the headless control surface. Token auth is non-negotiable
 * (this daemon moves money), the event feed is monotonic and survives
 * restart, and the health document's dotted paths are a compatibility
 * promise to the monitor room.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate ~/.j41 before requiring the module — paths are resolved lazily.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-ctlapi-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
fs.mkdirSync(path.join(TEST_HOME, '.j41', 'dispatcher'), { recursive: true });

const {
  startControlApi, createEventBus, ensureToken, checkAuth,
  TOKEN_PATH, EVENTS_PATH, RING_CAP,
} = require('../src/control-api');
const { buildHealthDocument } = require('../src/control');

// ── A synthetic dispatcher state ──
function makeState() {
  return {
    agents: [{ id: 'agent-1', identity: 'agent1@', iAddress: 'iA1' }],
    active: new Map(),
    available: [{ id: 'agent-1' }],
    queue: [],
    seen: new Map(),
    capabilities: new Map(),
    _agentErrors: new Map(),
    _containerCrashes: new Map(),
  };
}

// ── Token ──

test('ensureToken creates a 0600 token file and is stable across calls', () => {
  const t1 = ensureToken();
  assert.ok(t1 && t1.length >= 32);
  const t2 = ensureToken();
  assert.equal(t1, t2, 'token must not rotate on every call');
  const mode = fs.statSync(TOKEN_PATH()).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('checkAuth accepts the exact bearer token and rejects everything else', () => {
  const token = ensureToken();
  const ok = { headers: { authorization: `Bearer ${token}` } };
  assert.equal(checkAuth(ok, token), true);
  assert.equal(checkAuth({ headers: {} }, token), false);
  assert.equal(checkAuth({ headers: { authorization: 'Bearer wrong' } }, token), false);
  assert.equal(checkAuth({ headers: { authorization: token } }, token), false); // missing "Bearer "
  assert.equal(checkAuth({ headers: { authorization: `Bearer ${token}x` } }, token), false);
});

// ── Event bus ──

test('event bus assigns monotonic seq and filters by since', () => {
  // Fresh events file for this test
  try { fs.unlinkSync(EVENTS_PATH()); } catch {}
  const bus = createEventBus();
  const a = bus.emit('job.started', { jobId: 'j1' });
  const b = bus.emit('job.delivered', { jobId: 'j1' });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(bus.emit(null), null, 'typeless events are dropped');

  const all = bus.query(0);
  assert.equal(all.events.length, 2);
  assert.equal(all.cursor, 2);
  const tail = bus.query(1);
  assert.equal(tail.events.length, 1);
  assert.equal(tail.events[0].seq, 2);
  assert.equal(bus.query(2).events.length, 0);
});

test('event bus seq survives a restart (re-seeded from disk)', () => {
  try { fs.unlinkSync(EVENTS_PATH()); } catch {}
  const bus1 = createEventBus();
  bus1.emit('job.started', { jobId: 'j1' });
  bus1.emit('job.completed', { jobId: 'j1' });
  // New bus = simulated dispatcher restart
  const bus2 = createEventBus();
  assert.equal(bus2.cursor(), 2, 'seq continues past the persisted tail');
  const next = bus2.emit('agent.online', { agentId: 'agent-1' });
  assert.equal(next.seq, 3);
  // The old events are still queryable after restart
  assert.equal(bus2.query(0).events.length, 3);
});

test('event ring is capped but seq keeps climbing', () => {
  try { fs.unlinkSync(EVENTS_PATH()); } catch {}
  const bus = createEventBus();
  for (let i = 0; i < RING_CAP + 50; i++) bus.emit('tick', { i });
  const all = bus.query(0);
  assert.equal(all.events.length, RING_CAP, 'ring holds at most RING_CAP');
  assert.equal(all.cursor, RING_CAP + 50, 'cursor reflects total emitted');
  assert.equal(all.events[all.events.length - 1].seq, RING_CAP + 50);
});

// ── HTTP server (token gate + routes) ──

async function withServer(state, fn) {
  const handle = startControlApi(state, { getAgentSession: async () => { throw new Error('no platform'); } }, { port: 0 });
  await new Promise((res) => handle.server.on('listening', res));
  const port = handle.server.address().port;
  try {
    await fn(port, handle.token);
  } finally {
    handle.server.close();
  }
}

test('GET /v1/* requires a valid bearer token', async () => {
  const state = makeState();
  await withServer(state, async (port, token) => {
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/status`);
    assert.equal(noAuth.status, 401);

    const badAuth = await fetch(`http://127.0.0.1:${port}/v1/status`, {
      headers: { authorization: 'Bearer nope' },
    });
    assert.equal(badAuth.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.agents.total, 1);
  });
});

test('read endpoints return builder shapes; unknown job is 404', async () => {
  const state = makeState();
  state.active.set('job-abc', {
    agentId: 'agent-1', startedAt: Date.now(), jobAmount: 5, currency: 'VRSC',
    container: { name: 'j41-job-abc' },
  });
  await withServer(state, async (port, token) => {
    const h = { authorization: `Bearer ${token}` };

    const jobs = await (await fetch(`http://127.0.0.1:${port}/v1/jobs`, { headers: h })).json();
    assert.equal(jobs.active.length, 1);
    assert.equal(jobs.active[0].jobId, 'job-abc');

    const detail = await fetch(`http://127.0.0.1:${port}/v1/jobs/job-abc`, { headers: h });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).agentId, 'agent-1');

    const missing = await fetch(`http://127.0.0.1:${port}/v1/jobs/nope`, { headers: h });
    assert.equal(missing.status, 404);

    const agents = await (await fetch(`http://127.0.0.1:${port}/v1/agents`, { headers: h })).json();
    assert.equal(agents.agents[0].status, 'busy'); // agent-1 has an active job
  });
});

test('/v1/events serves the shared bus with a since cursor', async () => {
  const state = makeState();
  const handle = startControlApi(state, { getAgentSession: async () => ({}) }, { port: 0 });
  state.emitEvent = (type, data) => handle.bus.emit(type, data);
  await new Promise((res) => handle.server.on('listening', res));
  const port = handle.server.address().port;
  const h = { authorization: `Bearer ${handle.token}` };
  try {
    state.emitEvent('job.started', { jobId: 'jX' });
    const r1 = await (await fetch(`http://127.0.0.1:${port}/v1/events`, { headers: h })).json();
    assert.ok(r1.cursor >= 1);
    const cursor = r1.cursor;
    state.emitEvent('job.completed', { jobId: 'jX' });
    const r2 = await (await fetch(`http://127.0.0.1:${port}/v1/events?since=${cursor}`, { headers: h })).json();
    assert.equal(r2.events.length, 1);
    assert.equal(r2.events[0].type, 'job.completed');
  } finally {
    handle.server.close();
  }
});

test('non-GET and non-/v1 requests are refused', async () => {
  const state = makeState();
  await withServer(state, async (port, token) => {
    const post = await fetch(`http://127.0.0.1:${port}/v1/status`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(post.status, 405);
    const root = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(root.status, 404); // health lives on :9842, not here
  });
});

// ── Health document (WP-D2 dotted-path contract) ──

test('health document exposes the stable dotted paths the monitor room reads', () => {
  const state = makeState();
  state.active.set('job-1', {
    agentId: 'agent-1', startedAt: Date.now(), container: { name: 'j41-job-1' }, paused: false,
  });
  const doc = buildHealthDocument(state, Date.now() - 1000);

  // agents.N.status / agents.N.lastError
  assert.ok(Array.isArray(doc.agents));
  assert.equal(doc.agents[0].status, 'busy');
  assert.equal(doc.agents[0].lastError, null);
  // containers.N.name / containers.N.state / containers.N.crashes
  assert.equal(doc.containers[0].name, 'j41-job-1');
  assert.equal(doc.containers[0].state, 'running');
  assert.equal(doc.containers[0].crashes, 0);
  // summary.* numeric rollups — `above:0` watch target
  assert.equal(doc.summary.containers_unhealthy, 0);
  assert.equal(doc.summary.agents_total, 1);
  assert.equal(doc.summary.jobs_active, 1);
  assert.equal(doc.status, 'ok');
});

test('a crashed container flips containers_unhealthy and the status to degraded', () => {
  const state = makeState();
  state._containerCrashes.set('agent-1', 2);
  state._agentErrors.set('agent-1', 'job process exited with code 1');
  const doc = buildHealthDocument(state, Date.now());
  assert.equal(doc.summary.containers_unhealthy, 1); // one agent with crashes>0
  assert.equal(doc.status, 'degraded');
  assert.equal(doc.agents[0].lastError, 'job process exited with code 1');
});
