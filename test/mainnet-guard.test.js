const test = require('node:test');
const assert = require('node:assert/strict');
const { findMainnetSecurityViolations } = require('../src/mainnet-guard');

test('clean env + no opts → no violations', () => {
  assert.deepEqual(findMainnetSecurityViolations({}, {}), []);
  assert.deepEqual(findMainnetSecurityViolations({}, undefined), []); // tolerates missing opts
});

test('unrelated env var → no violations', () => {
  assert.deepEqual(findMainnetSecurityViolations({ HOME: '/x', J41_LOG_LEVEL: 'debug' }, {}), []);
});

test('each hatch individually produces exactly one violation naming the flag', () => {
  const cases = [
    [{ J41_SIGNING_BROKER: '0' }, {}, /J41_SIGNING_BROKER=0/],
    [{ J41_ALLOW_INSECURE_WIF_MOUNT: '1' }, {}, /J41_ALLOW_INSECURE_WIF_MOUNT=1/],
    [{}, { devUnsafe: true }, /--dev-unsafe/],
    [{ J41_DISABLE_BWRAP: '1' }, {}, /J41_DISABLE_BWRAP=1/],
    [{ J41_ALLOW_LOCAL_UPSTREAM: '1' }, {}, /J41_ALLOW_LOCAL_UPSTREAM=1/],
    [{ J41_SKIP_STATUS_CHECK: '1' }, {}, /J41_SKIP_STATUS_CHECK=1/],
    [{ J41_ALLOW_LEGACY_REVOKE: '1' }, {}, /J41_ALLOW_LEGACY_REVOKE=1/],
    [{ J41_WITNESS_VERIFY: 'off' }, {}, /J41_WITNESS_VERIFY=off/],
  ];
  for (const [env, opts, re] of cases) {
    const v = findMainnetSecurityViolations(env, opts);
    assert.equal(v.length, 1, `expected one violation for ${JSON.stringify({ env, opts })}`);
    assert.match(v[0], re);
  }
});

test('multiple hatches → multiple violations', () => {
  const v = findMainnetSecurityViolations(
    { J41_SIGNING_BROKER: '0', J41_DISABLE_BWRAP: '1' },
    { devUnsafe: true },
  );
  assert.equal(v.length, 3);
});

test('broker not set (undefined) is NOT a violation — only the literal "0" is', () => {
  assert.deepEqual(findMainnetSecurityViolations({}, {}), []);
  assert.deepEqual(findMainnetSecurityViolations({ J41_SIGNING_BROKER: '1' }, {}), []);
});

const { resolveIsMainnet } = require('../src/mainnet-guard');

test('resolveIsMainnet: file=verus is mainnet even when effective(env) says testnet (no downgrade)', () => {
  assert.equal(resolveIsMainnet('verus', 'verustest'), true);
});

test('resolveIsMainnet: both testnet (or null) → false', () => {
  assert.equal(resolveIsMainnet('verustest', 'verustest'), false);
  assert.equal(resolveIsMainnet(null, undefined), false);
});

test('resolveIsMainnet: effective=verus (env upgrade) → true', () => {
  assert.equal(resolveIsMainnet('verustest', 'verus'), true);
  assert.equal(resolveIsMainnet(null, 'verus'), true);
});
