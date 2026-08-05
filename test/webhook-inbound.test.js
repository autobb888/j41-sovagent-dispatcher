'use strict';
/**
 * Integration tests for POST /webhook/:agentId — the inbound job-event route.
 *
 * This route had ZERO coverage. It is an unauthenticated-by-default network
 * surface on a daemon that spends money: an accepted event drives job accept,
 * container spawn and eventually on-chain writes. Sibling routes on the same
 * server (`/j41/deposit/report`, `/j41/api-access/revoke`, the proxy) all have
 * tests; the main one did not.
 *
 * The property under test throughout is NOT the status code. It is:
 *
 *     a rejected request must never reach onEvent
 *
 * A 401 that still processed the event would be the disaster, and a status-code
 * assertion alone would not notice. Every negative case below asserts the
 * handler was not called, not merely that the response said no.
 *
 * Real HTTP over a real server on an ephemeral port — no mocking of the layer
 * whose behaviour is in question.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createHmac } = require('crypto');

const { startWebhookServer } = require('../src/webhook-server.js');

const SECRET_A = 'secret-for-agent-a-0123456789abcdef';
const SECRET_B = 'secret-for-agent-b-fedcba9876543210';

const sign = (body, secret) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
const signTs = (body, secret, ts) => 'sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

/** Start a server on an ephemeral port; returns { port, events, close }. */
function serve() {
  const events = [];
  const agentWebhooks = new Map([
    ['agent-a', { secret: SECRET_A, identity: 'a@' }],
    ['agent-b', { secret: SECRET_B, identity: 'b@' }],
  ]);
  const server = startWebhookServer(0, agentWebhooks, (agentId, payload) => {
    events.push({ agentId, payload });
  });
  return new Promise((resolve) => {
    const done = () => resolve({
      port: server.address().port,
      events,
      close: () => new Promise((r) => server.close(r)),
    });
    if (server.listening) done(); else server.once('listening', done);
  });
}

function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const evt = (id) => JSON.stringify({ id, type: 'job.created', jobId: 'j-1', data: {} });

// ---------------------------------------------------------------------------

test('a correctly signed event is accepted and delivered exactly once', async () => {
  const s = await serve();
  try {
    const body = evt('e1');
    const r = await post(s.port, '/webhook/agent-a', body, { 'x-webhook-signature': sign(body, SECRET_A) });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.body}`);
    assert.equal(s.events.length, 1, 'a valid event must be delivered');
    assert.equal(s.events[0].agentId, 'agent-a');
  } finally { await s.close(); }
});

test('NO signature: rejected, and the event never reaches the handler', async () => {
  const s = await serve();
  try {
    const r = await post(s.port, '/webhook/agent-a', evt('e2'));
    assert.equal(r.status, 401);
    assert.equal(s.events.length, 0, 'an unsigned event must not be processed');
  } finally { await s.close(); }
});

test('WRONG signature: rejected, handler never called', async () => {
  const s = await serve();
  try {
    const body = evt('e3');
    for (const bad of [
      'sha256=' + '0'.repeat(64),
      'sha256=deadbeef',
      'not-even-a-signature',
      'sha256=',
      sign(body, 'a-completely-different-secret'),
    ]) {
      const r = await post(s.port, '/webhook/agent-a', body, { 'x-webhook-signature': bad });
      assert.equal(r.status, 401, `accepted a bad signature: ${bad}`);
    }
    assert.equal(s.events.length, 0, 'no forged event may be processed');
  } finally { await s.close(); }
});

test('CROSS-AGENT: a signature valid for agent-b is rejected on agent-a', async () => {
  // The nastiest realistic case — a legitimate secret used against the wrong
  // agent. Verification must be against THAT agent's secret only, never
  // "any known secret".
  const s = await serve();
  try {
    const body = evt('e4');
    const r = await post(s.port, '/webhook/agent-a', body, { 'x-webhook-signature': sign(body, SECRET_B) });
    assert.equal(r.status, 401, 'agent-b may not drive agent-a');
    assert.equal(s.events.length, 0);
  } finally { await s.close(); }
});

test('TAMPERED body: a signature valid for the original does not cover the change', async () => {
  const s = await serve();
  try {
    const original = evt('e5');
    const tampered = JSON.stringify({ id: 'e5', type: 'job.created', jobId: 'ATTACKER-JOB', data: {} });
    const r = await post(s.port, '/webhook/agent-a', tampered, { 'x-webhook-signature': sign(original, SECRET_A) });
    assert.equal(r.status, 401);
    assert.equal(s.events.length, 0, 'a mutated body must not be processed');
  } finally { await s.close(); }
});

test('UNKNOWN agent is refused before any signature work', async () => {
  const s = await serve();
  try {
    const body = evt('e6');
    const r = await post(s.port, '/webhook/agent-nope', body, { 'x-webhook-signature': sign(body, SECRET_A) });
    assert.equal(r.status, 404);
    assert.equal(s.events.length, 0);
  } finally { await s.close(); }
});

test('agent ids that try to traverse or inject are refused', async () => {
  const s = await serve();
  try {
    for (const bad of ['..', '../../etc/passwd', '.hidden', '-flag', '', '%2e%2e']) {
      const body = evt('e7');
      const r = await post(s.port, `/webhook/${bad}`, body, { 'x-webhook-signature': sign(body, SECRET_A) });
      assert.ok(r.status === 400 || r.status === 404, `agent id ${JSON.stringify(bad)} got ${r.status}`);
    }
    assert.equal(s.events.length, 0);
  } finally { await s.close(); }
});

test('a replayed event id is accepted at most once', async () => {
  // The signature stays valid forever, so replay protection has to come from
  // the nonce. Without it, a captured event can be re-driven indefinitely.
  const s = await serve();
  try {
    const body = evt('replay-me');
    const sig = { 'x-webhook-signature': sign(body, SECRET_A) };
    await post(s.port, '/webhook/agent-a', body, sig);
    await post(s.port, '/webhook/agent-a', body, sig);
    await post(s.port, '/webhook/agent-a', body, sig);
    assert.equal(s.events.length, 1, `a replayed event was processed ${s.events.length} times`);
  } finally { await s.close(); }
});

test('a timestamped signature outside the tolerance window is refused', async () => {
  const s = await serve();
  try {
    const body = evt('e8');
    const old = Math.floor(Date.now() / 1000) - 3600; // an hour stale
    const r = await post(s.port, '/webhook/agent-a', body, {
      'x-webhook-signature-timestamped': signTs(body, SECRET_A, old),
      'x-webhook-timestamp': String(old),
    });
    assert.equal(r.status, 401, 'a stale timestamped signature must not verify');
    assert.equal(s.events.length, 0);
  } finally { await s.close(); }
});

test('a fresh timestamped signature IS accepted', async () => {
  const s = await serve();
  try {
    const body = evt('e9');
    const now = Math.floor(Date.now() / 1000);
    const r = await post(s.port, '/webhook/agent-a', body, {
      'x-webhook-signature-timestamped': signTs(body, SECRET_A, now),
      'x-webhook-timestamp': String(now),
    });
    assert.equal(r.status, 200, `fresh timestamped signature rejected: ${r.body}`);
    assert.equal(s.events.length, 1);
  } finally { await s.close(); }
});

test('an oversized body is refused without being processed', async () => {
  const s = await serve();
  try {
    const huge = Buffer.alloc(3 * 1024 * 1024, 0x41); // 3 MB of 'A'
    let status = 0;
    try { ({ status } = await post(s.port, '/webhook/agent-a', huge, { 'x-webhook-signature': sign(huge, SECRET_A) })); }
    catch { status = 413; } // the server may destroy the socket rather than answer
    assert.ok(status === 413 || status === 401 || status === 400, `oversized body got ${status}`);
    assert.equal(s.events.length, 0, 'an oversized body must not be processed');
  } finally { await s.close(); }
});

test('valid JSON with a valid signature but a non-POST method is refused', async () => {
  const s = await serve();
  try {
    const got = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, path: '/webhook/agent-a', method: 'GET' },
        (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end();
    });
    assert.equal(got, 404);
    assert.equal(s.events.length, 0);
  } finally { await s.close(); }
});

test('the health endpoint does not disclose the version', async () => {
  const s = await serve();
  try {
    const got = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, path: '/health', method: 'GET' }, (res) => {
        let out = ''; res.on('data', (c) => { out += c; }); res.on('end', () => resolve(out));
      });
      req.on('error', reject); req.end();
    });
    const doc = JSON.parse(got);
    assert.equal(doc.status, 'ok');
    assert.ok(!('version' in doc), 'the public health endpoint must not disclose a version');
  } finally { await s.close(); }
});
