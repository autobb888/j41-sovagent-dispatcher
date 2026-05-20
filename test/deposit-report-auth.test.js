// test/deposit-report-auth.test.js
// Auth tests for the buyer-signed deposit report (HIGH-1: credit theft).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const { generateKeypair, signMessage, buildDepositReportMessage } = require('@junction41/sovagent-sdk/dist/index.js');
const { verifyDepositReport, reportDeposit } = require('../src/deposit-watcher.js');
const { startWebhookServer } = require('../src/webhook-server.js');

const NET = 'verustest';

// Mock client: resolves the buyer identity to `buyerAddress`.
function mockClient(buyerAddress, { minimumSignatures = 1, throwOnLookup = false } = {}) {
  return {
    async getIdentityKeys(id) {
      if (throwOnLookup) throw new Error('not found');
      return { iaddress: 'i' + id, name: id, primaryAddresses: [buyerAddress], minimumSignatures };
    },
  };
}

// Build a report and sign it with `kp` over its final field values.
function signedReport(kp, overrides = {}) {
  const report = {
    buyerVerusId: 'buyer@',
    sellerVerusId: 'seller@',
    txid: 'tx_' + crypto.randomBytes(6).toString('hex'),
    amount: '10',
    nonce: crypto.randomBytes(8).toString('hex'),
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
  report.signature = signMessage(kp.wif, buildDepositReportMessage(report), NET);
  return report;
}

test('verifyDepositReport accepts a valid buyer-signed report', async () => {
  const kp = generateKeypair(NET);
  const res = await verifyDepositReport(mockClient(kp.address), signedReport(kp), NET);
  assert.strictEqual(res.ok, true);
});

test('rejects a report with no signature', async () => {
  const kp = generateKeypair(NET);
  const r = signedReport(kp);
  delete r.signature;
  const res = await verifyDepositReport(mockClient(kp.address), r, NET);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'MISSING_FIELDS');
});

test('rejects a tampered report (signature no longer matches)', async () => {
  const kp = generateKeypair(NET);
  const r = signedReport(kp);
  r.amount = '999999'; // tamper after signing
  const res = await verifyDepositReport(mockClient(kp.address), r, NET);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'BAD_SIGNATURE');
});

test('rejects a report signed by a different key than the claimed identity', async () => {
  const buyer = generateKeypair(NET);
  const attacker = generateKeypair(NET);
  // Attacker signs, but the identity resolves to the real buyer's address.
  const res = await verifyDepositReport(mockClient(buyer.address), signedReport(attacker), NET);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'BAD_SIGNATURE');
});

test('rejects a stale report (outside freshness window)', async () => {
  const kp = generateKeypair(NET);
  const stale = signedReport(kp, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
  const res = await verifyDepositReport(mockClient(kp.address), stale, NET);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'STALE');
});

test('rejects a replayed nonce', async () => {
  const kp = generateKeypair(NET);
  const client = mockClient(kp.address);
  const r = signedReport(kp);
  const first = await verifyDepositReport(client, r, NET);
  assert.strictEqual(first.ok, true);
  const second = await verifyDepositReport(client, r, NET); // same nonce
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.code, 'REPLAY');
});

test('rejects multisig buyer identities (single signature insufficient)', async () => {
  const kp = generateKeypair(NET);
  const res = await verifyDepositReport(mockClient(kp.address, { minimumSignatures: 2 }), signedReport(kp), NET);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'MULTISIG_UNSUPPORTED');
});

test('reportDeposit refuses an unauthenticated report without crediting', async () => {
  const kp = generateKeypair(NET);
  const r = signedReport(kp);
  delete r.signature;
  // verifyDepositReport fails first, so no on-chain/credit work is attempted.
  const res = await reportDeposit('agent-x', mockClient(kp.address), r, 'iSellerPay', NET);
  assert.strictEqual(res.credited, false);
  assert.strictEqual(res.code, 'MISSING_FIELDS');
});

// ── HTTP route: unsigned reports are rejected with 401 before reaching the handler ──
test('POST /j41/deposit/report returns 401 when signature is missing', async () => {
  let handlerCalled = false;
  const proxyContext = {
    agentConfigs: new Map(),
    onAccessRequest: async () => ({}),
    onApiAccessRevoke: async () => ({}),
    onDepositReport: async () => { handlerCalled = true; return {}; },
  };
  const server = startWebhookServer(0, new Map(), async () => {}, proxyContext);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  try {
    const body = JSON.stringify({ buyerVerusId: 'buyer@', sellerVerusId: 'seller@', txid: 't1', amount: '10' });
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ port, path: '/j41/deposit/report', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end(body);
    });
    assert.strictEqual(status, 401);
    assert.strictEqual(handlerCalled, false, 'handler must not run for an unsigned report');
  } finally {
    server.close();
  }
});
