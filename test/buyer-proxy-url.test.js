'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  codedError,
  originOf,
  hostsEqual,
  mintBuyerProxyBase,
  callProxiedPath,
  depositReportUrl,
  isDispatcherProxyBase,
  assertDispatcherHealth,
  resolveListingDispatcherBase,
  refreshStaleDispatcherBase,
} = require('../src/buyer-proxy-url');

test('codedError attaches a stable code', () => {
  const e = codedError('ENVELOPE_NO_PUBLIC_URL', 'missing publicUrl');
  assert.equal(e instanceof Error, true);
  assert.equal(e.code, 'ENVELOPE_NO_PUBLIC_URL');
  assert.equal(e.message, 'missing publicUrl');
});

test('originOf keeps scheme+host+port and refuses non-http(s)', () => {
  assert.equal(originOf('https://foo.example/j41/proxy/v1'), 'https://foo.example');
  assert.equal(originOf('https://foo.example:8443/extra'), 'https://foo.example:8443');
  assert.throws(() => originOf('not a url'), (e) => e.code === 'ENVELOPE_BAD_PUBLIC_URL');
  assert.throws(() => originOf('ftp://foo.example/x'), (e) => e.code === 'ENVELOPE_BAD_PUBLIC_URL');
});

test('mintBuyerProxyBase always rebuilds {origin}/j41/proxy/v1', () => {
  assert.equal(mintBuyerProxyBase('https://foo.example/j41/proxy/v1'), 'https://foo.example/j41/proxy/v1');
  assert.equal(mintBuyerProxyBase('https://foo.example/'), 'https://foo.example/j41/proxy/v1');
  assert.equal(mintBuyerProxyBase('https://foo.example/v1'), 'https://foo.example/j41/proxy/v1');
  assert.equal(
    mintBuyerProxyBase('https://integrate.api.nvidia.com/v1'),
    'https://integrate.api.nvidia.com/j41/proxy/v1',
  );
});

test('callProxiedPath does not double /v1', () => {
  assert.equal(callProxiedPath('https://foo.example/j41/proxy/v1'), '/chat/completions');
  assert.equal(callProxiedPath('https://foo.example/j41/proxy/v1/'), '/chat/completions');
  assert.equal(callProxiedPath('https://integrate.api.nvidia.com/v1'), '/chat/completions');
  assert.equal(callProxiedPath('https://foo.example/j41/proxy'), '/v1/chat/completions');
});

test('depositReportUrl is origin + /j41/deposit/report', () => {
  assert.equal(
    depositReportUrl('https://foo.example/j41/proxy/v1'),
    'https://foo.example/j41/deposit/report',
  );
});

test('isDispatcherProxyBase is a path check on the saved URL, not a minted hint', () => {
  assert.equal(isDispatcherProxyBase('https://foo.example/j41/proxy/v1'), true);
  assert.equal(isDispatcherProxyBase('https://foo.example/j41/proxy'), true);
  assert.equal(isDispatcherProxyBase('https://foo.example/j41/proxy/v1/'), true);
  assert.equal(isDispatcherProxyBase('https://integrate.api.nvidia.com/v1'), false);
  assert.equal(isDispatcherProxyBase('https://foo.example/'), false);
  // tautology: minting ANY http(s) URL yields a dispatcher-shaped path
  assert.equal(isDispatcherProxyBase(mintBuyerProxyBase('https://example.com')), true);
  assert.equal(isDispatcherProxyBase(mintBuyerProxyBase('https://integrate.api.nvidia.com/v1')), true);
});

test('hostsEqual compares hostname case-insensitively and ignores path', () => {
  assert.equal(hostsEqual('https://A/v1', 'https://A/j41/proxy/v1'), true);
  assert.equal(hostsEqual('https://Foo.Example/v1', 'https://foo.example/j41/proxy/v1'), true);
  assert.equal(hostsEqual('https://foo.example/v1', 'https://bar.example/v1'), false);
  assert.equal(hostsEqual('not-a-url', 'https://foo.example'), false);
});

test('resolveListingDispatcherBase refuses an NVIDIA hint without calling health', async () => {
  let fetched = false;
  await assert.rejects(
    () => resolveListingDispatcherBase('https://integrate.api.nvidia.com/v1', {
      grant: { endpointUrl: 'https://integrate.api.nvidia.com/v1' },
      fetchImpl: async () => { fetched = true; return { ok: true, json: async () => ({ service: 'dispatcher' }) }; },
    }),
    (e) => e.code === 'ACCESS_GRANT_UPSTREAM',
  );
  assert.equal(fetched, false);
});

test('resolveListingDispatcherBase requires GET /j41/health service=dispatcher', async () => {
  const urls = [];
  const minted = await resolveListingDispatcherBase('https://foo.example/website', {
    grant: { endpointUrl: 'https://integrate.api.nvidia.com/v1' },
    fetchImpl: async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ service: 'dispatcher', status: 'ok' }) };
    },
  });
  assert.equal(minted, 'https://foo.example/j41/proxy/v1');
  assert.equal(urls[0], 'https://foo.example/j41/health');

  await assert.rejects(
    () => resolveListingDispatcherBase('https://marketing.example/', {
      fetchImpl: async () => ({ ok: true, json: async () => ({ service: 'nginx' }) }),
    }),
    (e) => e.code === 'ACCESS_GRANT_UPSTREAM',
  );
});

test('assertDispatcherHealth default failCode is ENVELOPE_NO_PUBLIC_URL', async () => {
  await assert.rejects(
    () => assertDispatcherHealth('https://foo.example', async () => ({ ok: false })),
    (e) => e.code === 'ENVELOPE_NO_PUBLIC_URL',
  );
});

test('refreshStaleDispatcherBase keeps a live grant origin and rewrites after health fail', async () => {
  const kept = await refreshStaleDispatcherBase(
    'https://live.example/j41/proxy/v1',
    'https://other.example/',
    { fetchImpl: async () => ({ ok: true, json: async () => ({ service: 'dispatcher' }) }) },
  );
  assert.equal(kept, 'https://live.example/j41/proxy/v1');

  const urls = [];
  const minted = await refreshStaleDispatcherBase(
    'https://dead.example/j41/proxy/v1',
    'https://fresh.example/',
    {
      fetchImpl: async (url) => {
        urls.push(String(url));
        if (String(url).includes('dead.example')) return { ok: false, status: 404 };
        return { ok: true, json: async () => ({ service: 'dispatcher' }) };
      },
      failCode: 'ACCESS_GRANT_STALE',
    },
  );
  assert.equal(minted, 'https://fresh.example/j41/proxy/v1');
  assert.ok(urls.includes('https://dead.example/j41/health'));
  assert.ok(urls.includes('https://fresh.example/j41/health'));

  await assert.rejects(
    () => refreshStaleDispatcherBase('https://dead.example/j41/proxy/v1', null, {
      fetchImpl: async () => ({ ok: false, status: 404 }),
    }),
    (e) => e.code === 'ACCESS_GRANT_STALE',
  );
});
