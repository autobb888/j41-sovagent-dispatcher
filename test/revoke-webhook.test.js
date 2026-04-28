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
  assert.match(r.body, /Missing x-webhook-signature/);
});

test('revoke webhook: 403 when signature invalid', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());
  const body = JSON.stringify({ sellerVerusId: 'iSELLER', buyerVerusId: 'iBUYER' });
  const r = await postJson(port, '/j41/api-access/revoke', body, { 'x-webhook-signature': 'sha256=deadbeef' });
  assert.strictEqual(r.status, 403);
  assert.match(r.body, /Invalid signature/);
});

test('revoke webhook: 404 when seller not on this dispatcher', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());
  const body = JSON.stringify({ sellerVerusId: 'iUNKNOWN', buyerVerusId: 'iBUYER' });
  const r = await postJson(port, '/j41/api-access/revoke', body, { 'x-webhook-signature': hmac(body, 'test-secret-1234') });
  assert.strictEqual(r.status, 404);
  assert.match(r.body, /Seller not found/);
});

test('revoke webhook: 200 with valid signature', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());
  const body = JSON.stringify({ sellerVerusId: 'iSELLER', buyerVerusId: 'iBUYER' });
  const r = await postJson(port, '/j41/api-access/revoke', body, { 'x-webhook-signature': hmac(body, 'test-secret-1234') });
  assert.strictEqual(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.strictEqual(parsed.revoked, 1);
});
