'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  requestAndOpenAccess,
  chatCompletions,
  saveAccessGrant,
  loadAccessGrant,
  redactApiKey,
} = require('../src/buyer-access');
const { TESTNET_PLATFORM_SIGNER, FEE_TANK_NOT_SIGNER } = require('../src/platform-signer');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'j41-access-'));
}

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
          endpointUrl: 'https://proxy.example/v1',
          expiresAt: '2099-01-01T00:00:00Z',
          models: ['duskseek'],
        }),
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.payload.endpointUrl, 'https://proxy.example/v1');
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
    grant: { apiKey: 'sk', endpointUrl: 'https://proxy.example/v1', models: ['duskseek'] },
    message: 'hello',
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
