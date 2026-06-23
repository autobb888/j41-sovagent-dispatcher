const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { startWebhookServer } = require('../src/webhook-server.js');

function hmac(body, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function startServer() {
  const port = 0;
  const agentWebhooks = new Map([
    ['agent-1', { secret: 'test-secret-1234', identity: 'seller@' }],
  ]);
  const proxyContext = {
    agentConfigs: new Map(),
    onAccessRequest: async () => ({}),
    onDepositReport: async () => ({}),
    onApiAccessRevoke: async () => ({ revoked: 1 }),
    lookupAgentSecret: (sellerVerusId) => sellerVerusId === 'iSELLER' ? 'test-secret-1234' : null,
  };
  return new Promise(res => {
    const server = startWebhookServer(0, agentWebhooks, async () => {}, proxyContext);
    server.on('listening', () => res({ server, port: server.address().port }));
  });
}

async function postJson(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('revoke webhook: 401 when x-webhook-signature missing', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());
  const r = await postJson(port, '/j41/api-access/revoke', { sellerVerusId: 'iSELLER', buyerVerusId: 'iBUYER' });
  assert.strictEqual(r.status, 401);
  assert.match(r.body, /Missing webhook signature/);
});

test('revoke webhook: 403 when signature invalid', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());
  const body = JSON.stringify({ sellerVerusId: 'iSELLER', buyerVerusId: 'iBUYER' });
  const r = await postJson(port, '/j41/api-access/revoke', body, { 'x-webhook-signature': 'sha256=deadbeef' });
  assert.strictEqual(r.status, 403);
  assert.match(r.body, /Invalid or stale signature/);
});

test('revoke webhook: 403 when seller not on this dispatcher (uniform 403, no enumeration oracle)', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());
  const body = JSON.stringify({ sellerVerusId: 'iUNKNOWN', buyerVerusId: 'iBUYER' });
  const r = await postJson(port, '/j41/api-access/revoke', body, { 'x-webhook-signature': hmac(body, 'test-secret-1234') });
  // Fix 4: unknown seller must return 403 (same as bad signature) to prevent enumeration.
  assert.strictEqual(r.status, 403);
});

test('revoke webhook: legacy-only signature is REJECTED by default (replay-downgrade guard)', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());
  const body = JSON.stringify({ sellerVerusId: 'iSELLER', buyerVerusId: 'iBUYER' });
  // A valid LEGACY body-only HMAC must no longer be accepted on the revoke path —
  // the timestamped signature is required so it can't be replayed.
  const r = await postJson(port, '/j41/api-access/revoke', body, { 'x-webhook-signature': hmac(body, 'test-secret-1234') });
  assert.strictEqual(r.status, 403);
});

const tsHmac = (ts, body, secret) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

test('revoke webhook: 200 with valid timestamped signature', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());
  const body = JSON.stringify({ sellerVerusId: 'iSELLER', buyerVerusId: 'iBUYER' });
  const ts = Math.floor(Date.now() / 1000);
  const r = await postJson(port, '/j41/api-access/revoke', body, {
    'x-webhook-timestamp': String(ts),
    'x-webhook-signature-timestamped': tsHmac(ts, body, 'test-secret-1234'),
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(JSON.parse(r.body).revoked, 1);
});

test('revoke webhook: 403 when timestamped signature is stale', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());
  const body = JSON.stringify({ sellerVerusId: 'iSELLER', buyerVerusId: 'iBUYER' });
  const ts = Math.floor(Date.now() / 1000) - 3600; // 1h old, outside 300s window
  const r = await postJson(port, '/j41/api-access/revoke', body, {
    'x-webhook-timestamp': String(ts),
    'x-webhook-signature-timestamped': tsHmac(ts, body, 'test-secret-1234'),
  });
  assert.strictEqual(r.status, 403);
});
