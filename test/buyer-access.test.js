'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {
  requestAndOpenAccess,
  chatCompletions,
  saveAccessGrant,
  loadAccessGrant,
  redactApiKey,
  listingPublicUrlHint,
  refreshGrantFromListing,
} = require('../src/buyer-access');
const { assertAccessAllowed } = require('../src/hire');
const { TESTNET_PLATFORM_SIGNER, FEE_TANK_NOT_SIGNER } = require('../src/platform-signer');
const { codedError } = require('../src/buyer-proxy-url');
const { startWebhookServer } = require('../src/webhook-server');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'j41-access-'));
}

const API_SERVICES = [{ serviceType: 'api-endpoint' }];

test('requestAndOpenAccess refuses the fee-tank R before any SDK call', async () => {
  let called = false;
  const r = await requestAndOpenAccess({
    apiUrl: 'https://api.junction41.io',
    network: 'verustest',
    signer: FEE_TANK_NOT_SIGNER,
    seller: 'duskseek.agentplatform@',
    keys: { wif: 'WIF' },
    agent: { client: { requestApiAccess: async () => { called = true; } } },
    sdk: {
      generateEphemeralKeypair: () => { called = true; },
      buildAccessRequest: () => { called = true; },
      openAccessEnvelope: async () => { called = true; },
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PLATFORM_SIGNER_NOT_FEE');
  assert.equal(called, false);
});

test('getIdentityKeys PLATFORM_SIGNER_REQUIRED is not swallowed into empty addresses', async () => {
  const prev = process.env.J41_PLATFORM_SIGNER;
  delete process.env.J41_PLATFORM_SIGNER;
  try {
    const err = new Error('getIdentityKeys refused on mainnet: J41_PLATFORM_SIGNER is unset');
    err.code = 'PLATFORM_SIGNER_REQUIRED';
    const r = await requestAndOpenAccess({
      apiUrl: 'https://api.junction41.io',
      network: 'verustest',
      signer: TESTNET_PLATFORM_SIGNER,
      seller: 'iSeller',
      keys: { wif: 'WIF' },
      services: API_SERVICES,
      agent: {
        client: {
          requestApiAccess: async () => ({ ciphertext: 'x', iv: 'y' }),
          getIdentityKeys: async () => { throw err; },
        },
      },
      sdk: {
        generateEphemeralKeypair: () => ({ privateKey: new Uint8Array(32), publicKey: new Uint8Array(33) }),
        buildAccessRequest: () => ({ nonce: 'aa'.repeat(16) }),
        openAccessEnvelope: async () => {
          throw new Error('Could not resolve seller primary R-addresses');
        },
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PLATFORM_SIGNER_REQUIRED');
    assert.doesNotMatch(r.message, /Could not resolve seller primary R-addresses/);
  } finally {
    if (prev === undefined) delete process.env.J41_PLATFORM_SIGNER;
    else process.env.J41_PLATFORM_SIGNER = prev;
  }
});

test('successful decrypt returns payload and does not require a second hire', async () => {
  const prev = process.env.J41_PLATFORM_SIGNER;
  try {
    const r = await requestAndOpenAccess({
      apiUrl: 'https://api.junction41.io',
      network: 'verustest',
      signer: TESTNET_PLATFORM_SIGNER,
      seller: 'iSeller',
      keys: { wif: 'WIF' },
      services: API_SERVICES,
      agent: {
        client: {
          requestApiAccess: async () => ({ ciphertext: 'x', expiresAt: '2099-01-01T00:00:00Z' }),
          getIdentityKeys: async () => ({ primaryAddresses: ['Rseller'] }),
        },
      },
      sdk: {
        generateEphemeralKeypair: () => ({ privateKey: new Uint8Array(32), publicKey: new Uint8Array(33) }),
        buildAccessRequest: () => ({ nonce: 'aa'.repeat(16) }),
        openAccessEnvelope: async () => ({
          apiKey: 'sk-test-secret',
          endpointUrl: 'https://proxy.example/j41/proxy/v1',
          expiresAt: '2099-01-01T00:00:00Z',
          models: ['duskseek'],
        }),
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.payload.endpointUrl, 'https://proxy.example/j41/proxy/v1');
    assert.equal(r.payload.apiKey, 'sk-test-secret');
  } finally {
    if (prev === undefined) delete process.env.J41_PLATFORM_SIGNER;
    else process.env.J41_PLATFORM_SIGNER = prev;
  }
});

test('grant round-trip is 0600 and expired grants are dropped', () => {
  const dir = tmpDir();
  try {
    const rec = saveAccessGrant(dir, 'agent-1', 'duskseek.agentplatform@', {
      apiKey: 'sk-secret',
      endpointUrl: 'https://proxy.example',
      expiresAt: '2099-01-01T00:00:00Z',
      models: ['m'],
    });
    const p = path.join(dir, 'agent-1', 'access', 'duskseek.agentplatform@.json'.replace(/[^A-Za-z0-9._-]+/g, '_'));
    assert.equal(fs.statSync(p).mode & 0o077, 0);
    assert.equal(loadAccessGrant(dir, 'agent-1', 'duskseek.agentplatform@').apiKey, 'sk-secret');
    const dead = saveAccessGrant(dir, 'agent-1', 'old@', {
      apiKey: 'sk',
      endpointUrl: 'https://x',
      expiresAt: '2000-01-01T00:00:00Z',
    });
    assert.equal(dead.expiresAt, '2000-01-01T00:00:00Z');
    assert.equal(loadAccessGrant(dir, 'agent-1', 'old@', Date.parse('2026-09-05T00:00:00Z')), null);
    assert.equal(redactApiKey(rec.apiKey), 'sk-sec…cret');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chatCompletions posts OpenAI-compatible body through callProxied', async () => {
  const bodies = [];
  const r = await chatCompletions({
    grant: { apiKey: 'sk-test', endpointUrl: 'https://proxy.example/j41/proxy/v1', models: ['duskseek'] },
    message: 'hello',
    fetchImpl: async () => ({ ok: true, json: async () => ({ service: 'dispatcher' }) }),
    client: {
      callProxied: async (opts) => {
        bodies.push(opts.body);
        return { ok: true, status: 200, body: { choices: [{ message: { content: 'hi' } }] } };
      },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(bodies[0].model, 'duskseek');
  assert.equal(bodies[0].messages[0].content, 'hello');
});

test('assertAccessAllowed requires serviceType api-endpoint, not kind=model', () => {
  assert.equal(assertAccessAllowed({
    sellerKind: 'model',
    services: [{ serviceType: 'agent' }],
  }).code, 'ACCESS_NOT_API_ENDPOINT');
  assert.equal(assertAccessAllowed({
    sellerKind: 'data',
    services: [],
  }).code, 'ACCESS_NOT_API_ENDPOINT');
  assert.equal(assertAccessAllowed({
    sellerKind: 'agent',
    services: [{ serviceType: 'agent' }],
  }).ok, false);
  assert.equal(assertAccessAllowed({
    sellerKind: 'model',
    services: [{ serviceType: 'api-endpoint' }],
  }).ok, true);
});

test('labour / model-without-api-endpoint never buildAccessRequest', async () => {
  let called = false;
  const sdk = {
    generateEphemeralKeypair: () => { called = true; },
    buildAccessRequest: () => { called = true; },
    openAccessEnvelope: async () => { called = true; },
  };
  const labour = await requestAndOpenAccess({
    apiUrl: 'https://api.junction41.io',
    network: 'verustest',
    signer: TESTNET_PLATFORM_SIGNER,
    seller: 'labour.agentplatform@',
    keys: { wif: 'WIF' },
    sellerKind: 'agent',
    services: [{ serviceType: 'agent' }],
    agent: { client: { requestApiAccess: async () => { called = true; } } },
    sdk,
  });
  assert.equal(labour.ok, false);
  assert.equal(labour.code, 'ACCESS_NOT_API_ENDPOINT');
  assert.equal(called, false);

  const model = await requestAndOpenAccess({
    apiUrl: 'https://api.junction41.io',
    network: 'verustest',
    signer: TESTNET_PLATFORM_SIGNER,
    seller: 'duskseek.agentplatform@',
    keys: { wif: 'WIF' },
    sellerKind: 'model',
    services: [{ name: 'inference' }],
    agent: { client: { requestApiAccess: async () => { called = true; } } },
    sdk,
  });
  assert.equal(model.ok, false);
  assert.equal(model.code, 'ACCESS_NOT_API_ENDPOINT');
  assert.equal(called, false);
});

function cliAccessBlock() {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const start = cli.indexOf(".command('access <buyer-agent-id> <seller>')");
  const end = cli.indexOf(".command('chat <buyer-agent-id> <seller>')", start);
  return cli.slice(start, end);
}

function cliOnAccessRequest() {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const start = cli.indexOf('onAccessRequest: async (wireBody)');
  const end = cli.indexOf('onDepositReport:', start);
  return cli.slice(start, end);
}

function cliAgentConfigs() {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const start = cli.indexOf('const agentConfigs = new Map()');
  const end = cli.indexOf('proxyContext = {', start);
  return cli.slice(start, end);
}

test('access CLI calls assertAccessAllowed before requestAndOpenAccess', () => {
  const src = cliAccessBlock();
  const gate = src.indexOf('assertAccessAllowed');
  const req = src.indexOf('requestAndOpenAccess');
  assert.ok(gate > -1, 'access command must call assertAccessAllowed');
  assert.ok(req > -1, 'access command must call requestAndOpenAccess');
  assert.ok(gate < req, 'ACCESS_NOT_API_ENDPOINT preflight must run before signing');
});

test('access CLI tries loadAccessGrant + refreshGrantFromListing before requestAndOpenAccess', () => {
  const src = cliAccessBlock();
  const load = src.indexOf('loadAccessGrant(');
  const refresh = src.indexOf('refreshGrantFromListing(');
  const req = src.indexOf('await requestAndOpenAccess(');
  assert.ok(load > -1, 'access must load any saved grant');
  assert.ok(refresh > -1, 'access must try listing rewrite before re-access');
  assert.ok(req > -1, 'access still falls through to requestAndOpenAccess');
  assert.ok(load < refresh, 'load saved grant before refresh');
  assert.ok(refresh < req, 'listing rewrite must run before requestApiAccess path');
});

test('seller ACCESS_NOT_API_ENDPOINT is above verifyAccessRequest and checkNonceAfterVerify', () => {
  const src = cliOnAccessRequest();
  const gate = src.indexOf("serviceType === 'api-endpoint'");
  const v1 = src.indexOf('verifyAccessRequest');
  const v2 = src.indexOf('checkNonceAfterVerify');
  assert.ok(gate > -1, 'seller must gate on serviceType === api-endpoint');
  assert.ok(v1 > -1 && v2 > -1, 'v1 verify and v2 nonce check must still exist');
  assert.ok(gate < v1, 'serviceType gate must be above v1 verifyAccessRequest');
  assert.ok(gate < v2, 'serviceType gate must be above v2 checkNonceAfterVerify');
  assert.match(src, /ACCESS_NOT_API_ENDPOINT/);
  assert.doesNotMatch(src.slice(src.indexOf('sellerAgent'), gate + 80), /_isApiEndpoint/,
    '_isApiEndpoint stamp is not sufficient for mint');
});

test('mint payload uses mintBuyerProxyBase(publicUrl) and never cfg.endpointUrl', () => {
  const src = cliOnAccessRequest();
  assert.match(src, /mintBuyerProxyBase\(cfg\.publicUrl\)/);
  assert.doesNotMatch(src, /endpointUrl:\s*cfg\.endpointUrl/);
  assert.match(src, /ENVELOPE_NO_PUBLIC_URL/);
  assert.match(src, /ENVELOPE_UPSTREAM_URL/);
  assert.match(src, /hostsEqual\(minted,\s*cfg\.endpointUrl\)/);
  const cfg = cliAgentConfigs();
  assert.match(cfg, /publicUrl/);
  assert.match(cfg, /localCfg\.publicUrl/);
  assert.match(cfg, /endpointUrl:\s*apiSvc\.endpointUrl/);
  assert.match(cfg, /buyer UNREACHABLE/);
  assert.match(cfg, /hostsEqual\(buyerUrl,\s*apiSvc\.endpointUrl\)/);
  assert.doesNotMatch(cfg, /endpointUrl:\s*mintBuyerProxyBase/);
});

function joinCallProxied(endpointUrl, path) {
  const base = String(endpointUrl).replace(/\/$/, '');
  const p = path || '/v1/chat/completions';
  return `${base}${p.startsWith('/') ? '' : '/'}${p}`;
}

test('chatCompletions joins /chat/completions onto a /v1 proxy base (no /v1/v1)', async () => {
  const calls = [];
  const r = await chatCompletions({
    grant: { apiKey: 'sk-test', endpointUrl: 'https://foo.example/j41/proxy/v1', models: ['m'] },
    message: 'hi',
    fetchImpl: async () => ({ ok: true, json: async () => ({ service: 'dispatcher' }) }),
    client: {
      callProxied: async (opts) => {
        calls.push(opts);
        return { ok: true, status: 200, body: { choices: [{ message: { content: 'ok' } }] } };
      },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpointUrl, 'https://foo.example/j41/proxy/v1');
  assert.equal(calls[0].path, '/chat/completions');
  const url = joinCallProxied(calls[0].endpointUrl, calls[0].path);
  assert.equal(url, 'https://foo.example/j41/proxy/v1/chat/completions');
  assert.doesNotMatch(url, /\/v1\/v1/);
});

test('NVIDIA grant without hint is ACCESS_GRANT_UPSTREAM; callProxied not invoked; file unchanged', async () => {
  const dir = tmpDir();
  try {
    saveAccessGrant(dir, 'agent-1', 'duskseek.agentplatform@', {
      apiKey: 'sk-test',
      endpointUrl: 'https://integrate.api.nvidia.com/v1',
      expiresAt: '2099-01-01T00:00:00Z',
      models: ['m'],
    });
    const before = fs.readFileSync(path.join(dir, 'agent-1', 'access', 'duskseek.agentplatform@.json'.replace(/[^A-Za-z0-9._-]+/g, '_')), 'utf8');
    let called = false;
    const r = await chatCompletions({
      grant: loadAccessGrant(dir, 'agent-1', 'duskseek.agentplatform@'),
      message: 'hi',
      agentsDir: dir,
      buyerId: 'agent-1',
      seller: 'duskseek.agentplatform@',
      client: { callProxied: async () => { called = true; } },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ACCESS_GRANT_UPSTREAM');
    assert.equal(called, false);
    const after = fs.readFileSync(path.join(dir, 'agent-1', 'access', 'duskseek.agentplatform@.json'.replace(/[^A-Za-z0-9._-]+/g, '_')), 'utf8');
    assert.equal(after, before);
    assert.match(after, /integrate\.api\.nvidia\.com/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NVIDIA listing hint is refused; grant file unchanged; callProxied not invoked', async () => {
  const dir = tmpDir();
  try {
    saveAccessGrant(dir, 'agent-1', 'duskseek.agentplatform@', {
      apiKey: 'sk-test',
      endpointUrl: 'https://integrate.api.nvidia.com/v1',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    let called = false;
    let fetched = false;
    const r = await chatCompletions({
      grant: loadAccessGrant(dir, 'agent-1', 'duskseek.agentplatform@'),
      message: 'hi',
      publicUrlHint: 'https://integrate.api.nvidia.com/v1',
      agentsDir: dir,
      buyerId: 'agent-1',
      seller: 'duskseek.agentplatform@',
      fetchImpl: async () => { fetched = true; return { ok: true, json: async () => ({ service: 'dispatcher' }) }; },
      client: { callProxied: async () => { called = true; } },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ACCESS_GRANT_UPSTREAM');
    assert.equal(called, false);
    assert.equal(fetched, false);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'agent-1', 'access', 'duskseek.agentplatform@.json'.replace(/[^A-Za-z0-9._-]+/g, '_')), 'utf8'));
    assert.equal(rec.endpointUrl, 'https://integrate.api.nvidia.com/v1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('marketing-page hint without dispatcher health refuses and leaves the grant', async () => {
  const dir = tmpDir();
  try {
    saveAccessGrant(dir, 'agent-1', 'duskseek.agentplatform@', {
      apiKey: 'sk-test',
      endpointUrl: 'https://integrate.api.nvidia.com/v1',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    let called = false;
    const r = await chatCompletions({
      grant: loadAccessGrant(dir, 'agent-1', 'duskseek.agentplatform@'),
      message: 'hi',
      publicUrlHint: 'https://marketing.example/',
      agentsDir: dir,
      buyerId: 'agent-1',
      seller: 'duskseek.agentplatform@',
      fetchImpl: async () => ({ ok: true, json: async () => ({ service: 'pages' }) }),
      client: { callProxied: async () => { called = true; } },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ACCESS_GRANT_UPSTREAM');
    assert.equal(called, false);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'agent-1', 'access', 'duskseek.agentplatform@.json'.replace(/[^A-Za-z0-9._-]+/g, '_')), 'utf8'));
    assert.equal(rec.endpointUrl, 'https://integrate.api.nvidia.com/v1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listing hint with dispatcher health rewrites grant 0600 and proceeds', async () => {
  const dir = tmpDir();
  try {
    saveAccessGrant(dir, 'agent-1', 'duskseek.agentplatform@', {
      apiKey: 'sk-test',
      endpointUrl: 'https://integrate.api.nvidia.com/v1',
      expiresAt: '2099-01-01T00:00:00Z',
      models: ['m'],
    });
    const calls = [];
    const r = await chatCompletions({
      grant: loadAccessGrant(dir, 'agent-1', 'duskseek.agentplatform@'),
      message: 'hi',
      listing: { networkEndpoints: ['https://seller.example/'], website: 'https://ignored.example' },
      agentsDir: dir,
      buyerId: 'agent-1',
      seller: 'duskseek.agentplatform@',
      fetchImpl: async () => ({ ok: true, json: async () => ({ service: 'dispatcher', status: 'ok' }) }),
      client: {
        callProxied: async (opts) => {
          calls.push(opts);
          return { ok: true, status: 200, body: {} };
        },
      },
    });
    assert.equal(r.ok, true);
    assert.equal(calls[0].endpointUrl, 'https://seller.example/j41/proxy/v1');
    assert.equal(calls[0].path, '/chat/completions');
    const p = path.join(dir, 'agent-1', 'access', 'duskseek.agentplatform@.json'.replace(/[^A-Za-z0-9._-]+/g, '_'));
    assert.equal(fs.statSync(p).mode & 0o077, 0);
    const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(rec.endpointUrl, 'https://seller.example/j41/proxy/v1');
    assert.doesNotMatch(rec.endpointUrl, /nvidia/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listing with only endpoints[].url rewrites NVIDIA grant after dispatcher health', async () => {
  const dir = tmpDir();
  try {
    saveAccessGrant(dir, 'agent-1', 'duskseek.agentplatform@', {
      apiKey: 'sk-test',
      endpointUrl: 'https://integrate.api.nvidia.com/v1',
      expiresAt: '2099-01-01T00:00:00Z',
      models: ['m'],
    });
    const calls = [];
    const health = [];
    const r = await chatCompletions({
      grant: loadAccessGrant(dir, 'agent-1', 'duskseek.agentplatform@'),
      message: 'hi',
      listing: {
        endpoints: [{ url: 'https://seller.example/j41/proxy/v1', protocol: 'https', public: true }],
      },
      agentsDir: dir,
      buyerId: 'agent-1',
      seller: 'duskseek.agentplatform@',
      fetchImpl: async (url) => {
        health.push(url);
        return { ok: true, json: async () => ({ service: 'dispatcher', status: 'ok' }) };
      },
      client: {
        callProxied: async (opts) => {
          calls.push(opts);
          return { ok: true, status: 200, body: {} };
        },
      },
    });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpointUrl, 'https://seller.example/j41/proxy/v1');
    assert.equal(calls[0].path, '/chat/completions');
    assert.ok(health.some((u) => String(u).includes('/j41/health')));
    const p = path.join(dir, 'agent-1', 'access', 'duskseek.agentplatform@.json'.replace(/[^A-Za-z0-9._-]+/g, '_'));
    assert.equal(fs.statSync(p).mode & 0o077, 0);
    const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(rec.endpointUrl, 'https://seller.example/j41/proxy/v1');
    assert.doesNotMatch(rec.endpointUrl, /nvidia/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('typed endpoints[].url pathname is not proof of a dispatcher', async () => {
  const dir = tmpDir();
  try {
    saveAccessGrant(dir, 'agent-1', 'duskseek.agentplatform@', {
      apiKey: 'sk-test',
      endpointUrl: 'https://integrate.api.nvidia.com/v1',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    let called = false;
    let fetched = false;
    const r = await chatCompletions({
      grant: loadAccessGrant(dir, 'agent-1', 'duskseek.agentplatform@'),
      message: 'hi',
      listing: {
        endpoints: [{ url: 'https://integrate.api.nvidia.com/j41/proxy/v1', protocol: 'https', public: true }],
      },
      agentsDir: dir,
      buyerId: 'agent-1',
      seller: 'duskseek.agentplatform@',
      fetchImpl: async () => { fetched = true; return { ok: true, json: async () => ({ service: 'dispatcher' }) }; },
      client: { callProxied: async () => { called = true; } },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ACCESS_GRANT_UPSTREAM');
    assert.equal(called, false);
    assert.equal(fetched, false);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'agent-1', 'access', 'duskseek.agentplatform@.json'.replace(/[^A-Za-z0-9._-]+/g, '_')), 'utf8'));
    assert.equal(rec.endpointUrl, 'https://integrate.api.nvidia.com/v1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chat 402 maps to CHAT_NEEDS_DEPOSIT from statusCode/responseBody', async () => {
  const err = new Error('Proxy call failed: Insufficient credit');
  err.statusCode = 402;
  err.responseBody = {
    error: 'Insufficient credit',
    balance: 0,
    estimatedCost: 0.01,
    topupAddress: 'iSellerPay',
  };
  err.responseHeaders = { 'x-j41-credit-suggestedtopup': '10' };
  const r = await chatCompletions({
    grant: { apiKey: 'sk-test', endpointUrl: 'https://foo.example/j41/proxy/v1' },
    message: 'hi',
    fetchImpl: async () => ({ ok: true, json: async () => ({ service: 'dispatcher' }) }),
    client: { callProxied: async () => { throw err; } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CHAT_NEEDS_DEPOSIT');
  assert.equal(r.topupAddress, 'iSellerPay');
  assert.equal(r.estimatedCost, 0.01);
  assert.equal(r.balance, 0);
  assert.equal(r.suggestedTopup, '10');
  assert.match(String(r.depositArgv || r.deposit || ''), /deposit/);
  assert.notEqual(r.suggestedTopup, r.amount);
});

test('non-402 proxy errors stay CHAT_FAILED', async () => {
  const err = new Error('Proxy call failed: HTTP 404');
  err.statusCode = 404;
  const r = await chatCompletions({
    grant: { apiKey: 'sk-test', endpointUrl: 'https://foo.example/j41/proxy/v1' },
    message: 'hi',
    fetchImpl: async () => ({ ok: true, json: async () => ({ service: 'dispatcher' }) }),
    client: { callProxied: async () => { throw err; } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CHAT_FAILED');
});

function grantFile(dir, seller) {
  const safe = String(seller).replace(/[^A-Za-z0-9._-]+/g, '_');
  return path.join(dir, 'agent-1', 'access', `${safe}.json`);
}

test('stale dispatcher grant origin 404s health then listing hint rewrites and callProxied uses new origin', async () => {
  const dir = tmpDir();
  const seller = 'duskseek.agentplatform@';
  try {
    saveAccessGrant(dir, 'agent-1', seller, {
      apiKey: 'sk-test',
      endpointUrl: 'https://old-tunnel.trycloudflare.com/j41/proxy/v1',
      expiresAt: '2099-01-01T00:00:00Z',
      models: ['m'],
    });
    const health = [];
    const calls = [];
    const r = await chatCompletions({
      grant: loadAccessGrant(dir, 'agent-1', seller),
      message: 'hi',
      listing: { website: 'https://new-tunnel.example/', description: 'ignore me' },
      agentsDir: dir,
      buyerId: 'agent-1',
      seller,
      fetchImpl: async (url) => {
        health.push(String(url));
        if (String(url).includes('old-tunnel.trycloudflare.com')) {
          return { ok: false, status: 404 };
        }
        return { ok: true, json: async () => ({ service: 'dispatcher', status: 'ok' }) };
      },
      client: {
        callProxied: async (opts) => {
          calls.push(opts);
          return { ok: true, status: 200, body: {} };
        },
      },
    });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpointUrl, 'https://new-tunnel.example/j41/proxy/v1');
    assert.ok(health.some((u) => u === 'https://old-tunnel.trycloudflare.com/j41/health'));
    assert.ok(health.some((u) => u === 'https://new-tunnel.example/j41/health'));
    const p = grantFile(dir, seller);
    assert.equal(fs.statSync(p).mode & 0o077, 0);
    const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(rec.endpointUrl, 'https://new-tunnel.example/j41/proxy/v1');
    assert.doesNotMatch(rec.endpointUrl, /old-tunnel/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stale dispatcher grant + listing hint without dispatcher health is ACCESS_GRANT_STALE; file unchanged', async () => {
  const dir = tmpDir();
  const seller = 'duskseek.agentplatform@';
  try {
    saveAccessGrant(dir, 'agent-1', seller, {
      apiKey: 'sk-test',
      endpointUrl: 'https://old-tunnel.trycloudflare.com/j41/proxy/v1',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    const before = fs.readFileSync(grantFile(dir, seller), 'utf8');
    let called = false;
    const r = await chatCompletions({
      grant: loadAccessGrant(dir, 'agent-1', seller),
      message: 'hi',
      listing: { website: 'https://marketing.example/', endpoints: [{ url: 'https://pages.example/' }] },
      agentsDir: dir,
      buyerId: 'agent-1',
      seller,
      fetchImpl: async (url) => {
        if (String(url).includes('old-tunnel.trycloudflare.com')) return { ok: false, status: 404 };
        return { ok: true, json: async () => ({ service: 'pages' }) };
      },
      client: { callProxied: async () => { called = true; } },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ACCESS_GRANT_STALE');
    assert.equal(called, false);
    const after = fs.readFileSync(grantFile(dir, seller), 'utf8');
    assert.equal(after, before);
    assert.match(after, /old-tunnel\.trycloudflare\.com/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stale dispatcher grant with no listing hint is ACCESS_GRANT_STALE; file unchanged', async () => {
  const dir = tmpDir();
  const seller = 'duskseek.agentplatform@';
  try {
    saveAccessGrant(dir, 'agent-1', seller, {
      apiKey: 'sk-test',
      endpointUrl: 'https://old-tunnel.trycloudflare.com/j41/proxy/v1',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    const before = fs.readFileSync(grantFile(dir, seller), 'utf8');
    let called = false;
    const r = await chatCompletions({
      grant: loadAccessGrant(dir, 'agent-1', seller),
      message: 'hi',
      agentsDir: dir,
      buyerId: 'agent-1',
      seller,
      fetchImpl: async () => ({ ok: false, status: 404 }),
      client: { callProxied: async () => { called = true; } },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ACCESS_GRANT_STALE');
    assert.equal(called, false);
    assert.equal(fs.readFileSync(grantFile(dir, seller), 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('listingPublicUrlHint prefers networkEndpoints[0] over website', () => {
  assert.equal(
    listingPublicUrlHint({ networkEndpoints: ['https://ep.example'], website: 'https://web.example' }),
    'https://ep.example',
  );
  assert.equal(
    listingPublicUrlHint({ profile: { network: { endpoints: ['https://vdxf.example'] }, profile: { website: 'https://web.example' } } }),
    'https://vdxf.example',
  );
  assert.equal(listingPublicUrlHint({ website: 'https://web.example' }), 'https://web.example');
});

test('listingPublicUrlHint reads typed endpoints[].url and skips non-http(s)', () => {
  assert.equal(
    listingPublicUrlHint({
      endpoints: [{ url: 'https://seller.example/j41/proxy/v1', protocol: 'https', public: true }],
    }),
    'https://seller.example/j41/proxy/v1',
  );
  assert.equal(
    listingPublicUrlHint({
      endpoints: [
        { url: 'ssh://gpu.example', protocol: 'ssh', public: false },
        { url: 12 },
        'https://not-an-object.example',
        { url: 'https://seller.example/' },
      ],
    }),
    'https://seller.example/',
  );
  assert.equal(
    listingPublicUrlHint({ endpoints: [{ url: 'not-a-url' }], website: 'https://web.example' }),
    'https://web.example',
  );
  assert.equal(listingPublicUrlHint({ endpoints: [] }), null);
});

test('requestAndOpenAccess maps Nonce already used to NONCE_REPLAY', async () => {
  const prev = process.env.J41_PLATFORM_SIGNER;
  try {
    const err = new Error('Nonce already used');
    const r = await requestAndOpenAccess({
      apiUrl: 'https://api.junction41.io',
      network: 'verustest',
      signer: TESTNET_PLATFORM_SIGNER,
      seller: 'moonkimi.agentplatform@',
      keys: { wif: 'WIF' },
      services: API_SERVICES,
      agent: {
        client: {
          requestApiAccess: async () => { throw err; },
        },
      },
      sdk: {
        generateEphemeralKeypair: () => ({ privateKey: new Uint8Array(32), publicKey: new Uint8Array(33) }),
        buildAccessRequest: () => ({ nonce: 'bb'.repeat(16) }),
        openAccessEnvelope: async () => { throw new Error('should not decrypt'); },
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NONCE_REPLAY');
    assert.match(r.message, /Nonce already used/);

    const coded = new Error('platform rejected');
    coded.code = 'NONCE_REPLAY';
    const r2 = await requestAndOpenAccess({
      apiUrl: 'https://api.junction41.io',
      network: 'verustest',
      signer: TESTNET_PLATFORM_SIGNER,
      seller: 'moonkimi.agentplatform@',
      keys: { wif: 'WIF' },
      services: API_SERVICES,
      agent: {
        client: {
          requestApiAccess: async () => { throw coded; },
        },
      },
      sdk: {
        generateEphemeralKeypair: () => ({ privateKey: new Uint8Array(32), publicKey: new Uint8Array(33) }),
        buildAccessRequest: () => ({ nonce: 'cc'.repeat(16) }),
        openAccessEnvelope: async () => { throw new Error('should not decrypt'); },
      },
    });
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'NONCE_REPLAY');
  } finally {
    if (prev === undefined) delete process.env.J41_PLATFORM_SIGNER;
    else process.env.J41_PLATFORM_SIGNER = prev;
  }
});

test('NVIDIA saved grant + listing dispatcher health rewrites endpointUrl without requestApiAccess', async () => {
  const dir = tmpDir();
  const seller = 'moonkimi.agentplatform@';
  try {
    saveAccessGrant(dir, 'agent-1', seller, {
      apiKey: 'sk-nvidia-secret',
      endpointUrl: 'https://integrate.api.nvidia.com/v1',
      expiresAt: '2099-01-01T00:00:00Z',
      models: ['moonkimi'],
    });
    let requestApiAccessCalled = false;
    const poisoned = async () => { requestApiAccessCalled = true; throw new Error('requestApiAccess must not run'); };
    const r = await refreshGrantFromListing({
      grant: loadAccessGrant(dir, 'agent-1', seller),
      listing: { networkEndpoints: ['https://seller.example/'], website: 'https://ignored.example' },
      agentsDir: dir,
      buyerId: 'agent-1',
      seller,
      fetchImpl: async () => ({ ok: true, json: async () => ({ service: 'dispatcher', status: 'ok' }) }),
      // If a future regression wires this through requestAndOpenAccess, poison the client:
      agent: { client: { requestApiAccess: poisoned } },
    });
    assert.equal(r.ok, true);
    assert.equal(r.refreshed, true);
    assert.equal(r.grant.endpointUrl, 'https://seller.example/j41/proxy/v1');
    assert.equal(r.grant.apiKey, 'sk-nvidia-secret');
    assert.equal(requestApiAccessCalled, false);
    const src = fs.readFileSync(path.join(__dirname, '../src/buyer-access.js'), 'utf8');
    const fnStart = src.indexOf('async function refreshGrantFromListing');
    const fnEnd = src.indexOf('\nasync function ', fnStart + 1);
    const body = src.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
    assert.doesNotMatch(body, /requestApiAccess/, 'refreshGrantFromListing must never call requestApiAccess');
    const rec = JSON.parse(fs.readFileSync(grantFile(dir, seller), 'utf8'));
    assert.equal(rec.endpointUrl, 'https://seller.example/j41/proxy/v1');
    assert.equal(fs.statSync(grantFile(dir, seller)).mode & 0o077, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NVIDIA grant + listing health fail does not call requestApiAccess and does not overwrite file', async () => {
  const dir = tmpDir();
  const seller = 'moonkimi.agentplatform@';
  try {
    saveAccessGrant(dir, 'agent-1', seller, {
      apiKey: 'sk-nvidia-secret',
      endpointUrl: 'https://integrate.api.nvidia.com/v1',
      expiresAt: '2099-01-01T00:00:00Z',
      models: ['moonkimi'],
    });
    const before = fs.readFileSync(grantFile(dir, seller), 'utf8');
    let requestApiAccessCalled = false;
    const r = await refreshGrantFromListing({
      grant: loadAccessGrant(dir, 'agent-1', seller),
      listing: { website: 'https://marketing.example/' },
      agentsDir: dir,
      buyerId: 'agent-1',
      seller,
      fetchImpl: async () => ({ ok: true, json: async () => ({ service: 'pages' }) }),
      agent: { client: { requestApiAccess: async () => { requestApiAccessCalled = true; } } },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ACCESS_GRANT_UPSTREAM');
    assert.equal(requestApiAccessCalled, false);
    assert.equal(fs.readFileSync(grantFile(dir, seller), 'utf8'), before);
    assert.match(before, /integrate\.api\.nvidia\.com/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery maps ACCESS_NOT_API_ENDPOINT to 400 and envelope codes to 503', async () => {
  const cases = [
    ['ACCESS_NOT_API_ENDPOINT', 400],
    ['ENVELOPE_NO_PUBLIC_URL', 503],
    ['ENVELOPE_UPSTREAM_URL', 503],
    ['ENVELOPE_BAD_PUBLIC_URL', 503],
  ];
  for (const [code, status] of cases) {
    const server = startWebhookServer(0, new Map(), async () => {}, {
      onAccessRequest: async () => { throw codedError(code, code); },
    });
    await new Promise((r) => server.on('listening', r));
    try {
      const port = server.address().port;
      const res = await new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port, path: '/j41/discovery/request-access', method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, (resp) => {
          let out = '';
          resp.on('data', (c) => { out += c; });
          resp.on('end', () => resolve({ status: resp.statusCode, body: out }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ buyerVerusId: 'b@', sellerVerusId: 's@' }));
      });
      assert.equal(res.status, status, `${code} should be HTTP ${status}`);
      const body = JSON.parse(res.body);
      assert.equal(body.code, code);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }
});
