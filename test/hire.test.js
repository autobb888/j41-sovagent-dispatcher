'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  assertHireAllowed,
  paymentOutputs,
  localBuyers,
  fetchMarketplaceListings,
} = require('../src/hire');

test('hire gate matches platform: agent labour ok, data refused', () => {
  assert.equal(assertHireAllowed({ sellerKind: 'agent', serviceId: 's1' }).ok, true);
  const data = assertHireAllowed({ sellerKind: 'data', serviceType: 'agent', serviceId: 's1' });
  assert.equal(data.ok, false);
  assert.equal(data.code, 'DATA_NOT_HIREABLE');
});

test('compute requires gpu-rental; model and api-endpoint are not labour jobs', () => {
  assert.equal(assertHireAllowed({ sellerKind: 'compute', serviceType: 'gpu-rental', serviceId: 's1' }).ok, true);
  assert.equal(assertHireAllowed({ sellerKind: 'compute', serviceType: 'api-endpoint', serviceId: 's1' }).ok, false);
  const model = assertHireAllowed({ sellerKind: 'model', serviceType: 'api-endpoint', serviceId: 's1' });
  assert.equal(model.ok, false);
  assert.equal(model.code, 'MODEL_NOT_A_LABOUR_JOB');
  assert.equal(assertHireAllowed({ sellerKind: 'model', serviceType: 'gpu-rental', serviceId: 's1' }).ok, false);
  const api = assertHireAllowed({ sellerKind: 'agent', serviceType: 'api-endpoint', serviceId: 's1' });
  assert.equal(api.ok, false);
  assert.equal(api.code, 'MODEL_NOT_A_LABOUR_JOB');
});

test('paymentOutputs refuses missing/malformed addresses and implausible fees', () => {
  assert.throws(() => paymentOutputs({ payment: {} }, 1), /No payment address/);
  assert.throws(() => paymentOutputs({ payment: { address: 'not-an-address' } }, 1), /malformed payment address/);
  const addr = 'R' + 'A'.repeat(33);
  const fee = 'i' + 'B'.repeat(33);
  const outs = paymentOutputs({
    payment: { address: addr, platformFeeAddress: fee, feeAmount: 0.05 },
  }, 1);
  assert.equal(outs.length, 2);
  assert.equal(outs[0].amount, 1);
  assert.throws(() => paymentOutputs({
    payment: { address: addr, platformFeeAddress: fee, feeAmount: 2 },
  }, 1), /implausible/);
});

test('CLI registers hire; TUI exposes buyer hire; plan no longer claims dispatcher cannot hire', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const dash = fs.readFileSync(path.join(__dirname, '../src/dashboard.js'), 'utf8');
  assert.match(cli, /\.command\('hire <buyer-agent-id> <seller>'\)/);
  assert.match(cli, /--pay/);
  assert.match(dash, /hireScreen/);
  assert.match(dash, /Hire a listing \(this fleet as buyer\)/);
});

test('localBuyers lists hire-as ids and flags unregistered keys', () => {
  const rows = localBuyers(['a1', 'a2', 'missing'], (id) => {
    if (id === 'a1') return { identity: 'alice.agentplatform@', iAddress: 'iAlice', wif: 'x', address: 'Ralice' };
    if (id === 'a2') return { address: 'Ronly' };
    return null;
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].buyerAgentId, 'a1');
  assert.equal(rows[0].canHire, true);
  assert.equal(rows[1].canHire, false);
});

test('fetchMarketplaceListings refuses unknown kind/serviceType instead of sending them', async () => {
  await assert.rejects(
    () => fetchMarketplaceListings({ apiUrl: 'https://api.example', kind: 'nope', fetchImpl: async () => { throw new Error('should not fetch'); } }),
    /INVALID_KIND/,
  );
  await assert.rejects(
    () => fetchMarketplaceListings({ apiUrl: 'https://api.example', serviceType: 'nope', fetchImpl: async () => { throw new Error('should not fetch'); } }),
    /INVALID_SERVICE_TYPE/,
  );
});

test('fetchMarketplaceListings maps services and treats data as browse-only', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const u = String(url);
    if (u.includes('/v1/agents')) {
      return { ok: true, json: async () => ({ data: [{ id: 'iData', qualifiedName: 'set.agentplatform@', name: 'set' }], meta: { total: 1 } }) };
    }
    return {
      ok: true,
      json: async () => ({
        data: [{ id: 'svc1', verusId: 'iSeller', qualifiedName: 'gpu.agentplatform@', kind: 'compute', serviceType: 'gpu-rental', price: 1, currency: 'VRSCTEST', name: 'card' }],
        meta: { total: 1 },
      }),
    };
  };
  const data = await fetchMarketplaceListings({ apiUrl: 'https://api.example', kind: 'data', fetchImpl });
  assert.equal(data.browseOnly, true);
  assert.equal(data.rows[0].hireable, false);
  assert.match(calls[0], /kind=data/);

  const compute = await fetchMarketplaceListings({ apiUrl: 'https://api.example/', kind: 'compute', fetchImpl });
  assert.equal(compute.browseOnly, false);
  assert.equal(compute.rows[0].seller, 'iSeller');
  assert.equal(compute.rows[0].serviceId, 'svc1');
  assert.match(calls[1], /serviceType=gpu-rental/);
});

test('CLI buyers and listings commands exist; TUI can browse marketplace ids', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const dash = fs.readFileSync(path.join(__dirname, '../src/dashboard.js'), 'utf8');
  assert.match(cli, /\.command\('buyers'\)/);
  assert.match(cli, /\.command\('listings'\)/);
  assert.match(dash, /Browse marketplace/);
  assert.match(dash, /fetchMarketplaceListings/);
});

test('listings default limit is 100; TUI browse does not cap at 24', async () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const dash = fs.readFileSync(path.join(__dirname, '../src/dashboard.js'), 'utf8');
  const listings = cli.slice(cli.indexOf(".command('listings')"), cli.indexOf(".command('listings')") + 1200);
  assert.match(listings, /\.option\('--limit <n>', 'Max rows', '100'\)/);
  assert.doesNotMatch(dash, /limit:\s*24/);

  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/v1/agents')) {
      return { ok: true, json: async () => ({ data: [], meta: { total: 0 } }) };
    }
    return { ok: true, json: async () => ({ data: new Array(27).fill(0).map((_, i) => ({
      id: `s${i}`, verusId: `i${i}`, kind: 'agent', serviceType: 'agent', price: 1,
    })), meta: { total: 27 } }) };
  };
  const result = await fetchMarketplaceListings({ apiUrl: 'https://api.example', fetchImpl });
  assert.equal(result.rows.filter((r) => r.kind !== 'data').length, 27);
  assert.match(calls[0], /limit=100/);
});

test('listings do not mark models hireable; default browse includes data identities', async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/v1/agents')) {
      return {
        ok: true,
        json: async () => ({
          data: [{ id: 'iData', qualifiedName: 'pippinapples.agentplatform@', name: 'pippinapples' }],
          meta: { total: 1 },
        }),
      };
    }
    const all = [
      { id: 'svc-agent', verusId: 'iAgent', kind: 'agent', serviceType: 'agent', price: 1 },
      { id: 'svc-model', verusId: 'iModel', kind: 'model', serviceType: 'api-endpoint', price: 0.01, qualifiedName: 'duskseek.agentplatform@' },
    ];
    const kind = new URL(u).searchParams.get('kind');
    const data = kind ? all.filter((s) => s.kind === kind) : all;
    return {
      ok: true,
      json: async () => ({ data, meta: { total: data.length } }),
    };
  };
  const mixed = await fetchMarketplaceListings({ apiUrl: 'https://api.example', fetchImpl });
  const agent = mixed.rows.find((r) => r.kind === 'agent');
  const model = mixed.rows.find((r) => r.kind === 'model');
  const data = mixed.rows.find((r) => r.kind === 'data');
  assert.equal(agent.hireable, true);
  assert.equal(agent.next, 'hire');
  assert.equal(model.hireable, false);
  assert.equal(model.refuseCode, 'MODEL_NOT_A_LABOUR_JOB');
  assert.equal(model.next, 'access');
  assert.equal(data.hireable, false);
  assert.equal(data.refuseCode, 'DATA_NOT_HIREABLE');
  assert.equal(data.qualifiedName, 'pippinapples.agentplatform@');

  const modelsOnly = await fetchMarketplaceListings({ apiUrl: 'https://api.example', kind: 'model', fetchImpl });
  assert.equal(modelsOnly.rows.every((r) => r.hireable === false), true);
  assert.equal(modelsOnly.rows.every((r) => r.next === 'access'), true);
});

test('CLI has access/chat; TUI does not hire models', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const dash = fs.readFileSync(path.join(__dirname, '../src/dashboard.js'), 'utf8');
  assert.match(cli, /\.command\('access <buyer-agent-id> <seller>'\)/);
  assert.match(cli, /\.command\('chat <buyer-agent-id> <seller>'\)/);
  assert.match(dash, /j41-dispatcher access/);
  assert.match(dash, /MODEL_NOT_A_LABOUR_JOB/);
});
