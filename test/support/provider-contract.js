'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Shared lease-lifecycle contract every ComputeProvider must satisfy. Task 4 runs it
// against `local`; S6 runs it against `vast`. If a provider needs a special-case here,
// the interface is wrong (spec §11 non-goal).
function runProviderContract({ name, makeProvider, spec = {} }) {
  test(`[contract:${name}] discover->acquire->waitReady->probe->release`, async () => {
    const p = makeProvider();
    const cands = await p.discover(spec);
    assert.ok(Array.isArray(cands) && cands.length >= 1, 'discover returns >=1 candidate');

    let lease = await p.acquire(cands[0], spec);
    assert.equal(typeof lease.id, 'string');
    assert.ok(['pending', 'ready'].includes(lease.state));

    lease = await p.waitReady(lease, { timeoutMs: 3000 });
    assert.equal(lease.state, 'ready', 'waitReady yields state=ready');
    assert.ok(lease.baseUrl, 'waitReady populates baseUrl');

    const health = await p.probe(lease);
    assert.equal(typeof health.healthy, 'boolean');

    const cost = p.describeCost(lease);
    assert.equal(typeof cost.usdPerHour, 'number');
    assert.ok(['quoted', 'declared'].includes(cost.source));
  });

  test(`[contract:${name}] release is idempotent`, async () => {
    const p = makeProvider();
    const lease = await p.acquire((await p.discover(spec))[0], spec);
    const r1 = await p.release(lease);
    assert.equal(r1.state, 'released');
    const r2 = await p.release(r1); // second call must not throw
    assert.equal(r2.state, 'released');
  });

  test(`[contract:${name}] capabilities shape`, () => {
    const caps = makeProvider().capabilities;
    for (const k of ['canProvision', 'canSsh', 'canScaleToZero', 'isElastic']) {
      assert.equal(typeof caps[k], 'boolean', `capabilities.${k} is boolean`);
    }
  });
}
module.exports = { runProviderContract };
