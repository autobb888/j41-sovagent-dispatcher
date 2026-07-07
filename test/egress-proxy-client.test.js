const { test } = require('node:test');
const assert = require('node:assert');
const { installEgressProxy } = require('../src/egress-proxy-client.js');

test('installs proxy dispatcher + overrides global fetch when env set', () => {
  const calls = {};
  const fakeFetch = () => {};
  const fakeUndici = {
    ProxyAgent: class { constructor(opts) { calls.opts = opts; } },
    setGlobalDispatcher: (a) => { calls.dispatcher = a; },
    fetch: fakeFetch,
  };
  const prevFetch = globalThis.fetch;
  try {
    const ok = installEgressProxy({
      env: { J41_EGRESS_PROXY: 'http://172.18.0.1:9847', J41_EGRESS_TOKEN: 'abc' },
      undici: fakeUndici,
    });
    assert.equal(ok, true);
    assert.equal(calls.opts.uri, 'http://172.18.0.1:9847');
    assert.equal(calls.opts.token, 'Bearer abc');
    assert.ok(calls.dispatcher instanceof fakeUndici.ProxyAgent);
    assert.equal(globalThis.fetch, fakeFetch);
  } finally { globalThis.fetch = prevFetch; }
});

test('no-op when env missing', () => {
  const ok = installEgressProxy({ env: {}, undici: { ProxyAgent: class {}, setGlobalDispatcher(){}, fetch(){} } });
  assert.equal(ok, false);
});
