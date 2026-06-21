const test = require('node:test');
const assert = require('node:assert/strict');
const { renderActiveJobs } = require('../src/tui/live-screen');

// Strip ANSI so assertions are about content, not color.
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('renderActiveJobs: empty list shows "No active jobs" and queue 0', () => {
  const out = plain(renderActiveJobs({ jobs: { active: [], queue: 0 } }));
  assert.match(out, /Live Jobs/);
  assert.match(out, /No active jobs\./);
  assert.match(out, /Queue: 0 pending/);
});

test('renderActiveJobs: one running job shows id, agent, runtime, tokens', () => {
  const data = {
    jobs: { active: [{ jobId: '0bf75391-aaaa', agentId: 'agent-5', runningFor: '3m', paused: false, workspace: false, tokens: { total: 1234 } }], queue: 0 },
  };
  const out = plain(renderActiveJobs(data));
  assert.match(out, /0bf75391/);
  assert.match(out, /agent-5/);
  assert.match(out, /3m/);
  assert.match(out, /1234/);
  assert.match(out, /running/);
});

test('renderActiveJobs: paused job and [WS] flag render', () => {
  const data = {
    jobs: { active: [{ jobId: 'deadbeef-1', agentId: 'agent-2', runningFor: '1m', paused: true, workspace: true, tokens: null }], queue: 2 },
  };
  const out = plain(renderActiveJobs(data));
  assert.match(out, /paused/);
  assert.match(out, /\[WS\]/);
  assert.match(out, /Queue: 2 pending/);
});

test('renderActiveJobs: per-job memMB from resources is shown', () => {
  const data = {
    jobs: { active: [{ jobId: '0bf75391-aaaa', agentId: 'agent-5', runningFor: '3m', paused: false, workspace: false, tokens: null }], queue: 0 },
    resources: { jobs: [{ jobId: '0bf75391', memMB: 512, agentId: 'agent-5' }] },
  };
  const out = plain(renderActiveJobs(data));
  assert.match(out, /512MB/);
});

test('renderActiveJobs: error state shows the message and retry hint', () => {
  const out = plain(renderActiveJobs({ error: 'Dispatcher is not running (no control socket)' }));
  assert.match(out, /Dispatcher is not running/);
  assert.match(out, /press q to go back/);
});

const { runLiveScreen } = require('../src/tui/live-screen');
const { EventEmitter } = require('node:events');

// A fake stdin that records raw-mode toggles and lets tests emit keys.
function makeStdin() {
  const e = new EventEmitter();
  e.rawModes = [];
  e.setRawMode = (v) => { e.rawModes.push(v); return e; };
  e.resume = () => e;
  e.pause = () => e;
  return e;
}

test('runLiveScreen: fetches and renders immediately, then quits on q', async () => {
  const stdin = makeStdin();
  const frames = [];
  let fetchCount = 0;
  const p = runLiveScreen({
    stdin,
    intervalMs: 9999,
    fetch: async () => { fetchCount++; return { jobs: { active: [], queue: 0 } }; },
    render: (d) => `frame:${d.error ? 'err' : 'ok'}`,
    write: (s) => frames.push(s),
    clear: () => {},
    setInterval: () => 0,        // no real timer
    clearInterval: () => {},
  });
  // let the immediate refresh() microtasks settle
  await new Promise((r) => setImmediate(r));
  assert.equal(fetchCount, 1);
  assert.deepEqual(frames, ['frame:ok']);
  assert.equal(stdin.rawModes[0], true); // raw mode turned on

  stdin.emit('data', Buffer.from('q'));
  const res = await p;
  assert.ok(res); // resolved
  assert.equal(stdin.rawModes[stdin.rawModes.length - 1], false); // raw mode restored
});

test('runLiveScreen: r forces an extra refresh', async () => {
  const stdin = makeStdin();
  let fetchCount = 0;
  const p = runLiveScreen({
    stdin, intervalMs: 9999,
    fetch: async () => { fetchCount++; return { jobs: { active: [], queue: 0 } }; },
    render: () => 'x', write: () => {}, clear: () => {},
    setInterval: () => 0, clearInterval: () => {},
  });
  await new Promise((r) => setImmediate(r));
  stdin.emit('data', Buffer.from('r'));
  await new Promise((r) => setImmediate(r));
  assert.equal(fetchCount, 2);
  stdin.emit('data', Buffer.from('q'));
  await p;
});

test('runLiveScreen: fetch rejection renders an error frame, loop survives', async () => {
  const stdin = makeStdin();
  const frames = [];
  const p = runLiveScreen({
    stdin, intervalMs: 9999,
    fetch: async () => { throw new Error('boom'); },
    render: (d) => (d.error ? `ERR:${d.error}` : 'ok'),
    write: (s) => frames.push(s), clear: () => {},
    setInterval: () => 0, clearInterval: () => {},
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(frames, ['ERR:boom']);
  stdin.emit('data', Buffer.from('q'));
  await p;
});

test('runLiveScreen: the interval callback triggers refresh', async () => {
  const stdin = makeStdin();
  let intervalFn = null;
  let fetchCount = 0;
  const p = runLiveScreen({
    stdin, intervalMs: 10,
    fetch: async () => { fetchCount++; return { jobs: { active: [], queue: 0 } }; },
    render: () => 'x', write: () => {}, clear: () => {},
    setInterval: (fn) => { intervalFn = fn; return 1; },
    clearInterval: () => {},
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(fetchCount, 1);
  await intervalFn();                 // simulate a tick
  assert.equal(fetchCount, 2);
  stdin.emit('data', Buffer.from('q'));
  await p;
});

test('runLiveScreen: a fetch resolving after quit does not write (no post-teardown paint)', async () => {
  const stdin = makeStdin();
  const frames = [];
  let resolveFetch;
  let calls = 0;
  const p = runLiveScreen({
    stdin, intervalMs: 9999,
    fetch: () => {
      calls++;
      if (calls === 1) return new Promise((r) => { resolveFetch = r; }); // first fetch hangs
      return Promise.resolve({ jobs: { active: [], queue: 0 } });
    },
    render: () => 'frame',
    write: (s) => frames.push(s), clear: () => {},
    setInterval: () => 0, clearInterval: () => {},
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(frames.length, 0);           // first refresh still pending → nothing written
  stdin.emit('data', Buffer.from('q'));     // quit while fetch in flight
  await p;
  resolveFetch({ jobs: { active: [], queue: 0 } }); // in-flight fetch now resolves
  await new Promise((r) => setImmediate(r));
  assert.equal(frames.length, 0);           // MUST be 0 — no write after teardown
});
