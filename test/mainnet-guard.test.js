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

test('broker disabled is always a security violation', () => {
  const v = findMainnetSecurityViolations({ J41_SIGNING_BROKER: '0' }, { devUnsafe: false });
  assert.ok(v.some(s => /SIGNING_BROKER/.test(s)));
});

test('J41_ALLOW_INSECURE_WIF_MOUNT is no longer a recognized knob', () => {
  const v = findMainnetSecurityViolations({ J41_ALLOW_INSECURE_WIF_MOUNT: '1' }, { devUnsafe: false });
  assert.ok(!v.some(s => /ALLOW_INSECURE_WIF_MOUNT/.test(s)));
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

// ---------------------------------------------------------------------------
// Flags added 2026-08-05. An audit asked why the list stopped where it did:
// J41_DEPOSIT_ALLOW_AUTH_ONLY was absent while being exactly the class of flag
// this gate exists to catch. Auditing the rest of the env surface turned up five
// more bypasses in the same position.
//
// Each pair below pins BOTH directions — the bypass value blocks, and the safe
// value does not. A gate that fires on the safe value teaches operators to
// disable it.
// ---------------------------------------------------------------------------

const NEW_BYPASSES = [
  ['J41_ALLOW_UNPRICED_JOBS',     '1', '0', /no payment record|UNPRICED/],
  ['J41_SCAN_BUYER_CHAT',         '0', '1', /SovGuard scanning|SCAN_BUYER_CHAT/],
  ['J41_ALLOW_INSECURE',          '1', '0', /plaintext HTTP|ALLOW_INSECURE/],
  ['J41_LOCAL_SIGNER_TEST_MODE',  '1', '0', /test-only|LOCAL_SIGNER_TEST_MODE/],
  ['J41_TRUST_PLATFORM_RESOLUTION','1','0', /identity resolution|TRUST_PLATFORM_RESOLUTION/],
];

for (const [flag, bypass, safe, pattern] of NEW_BYPASSES) {
  test(`${flag}=${bypass} is refused on mainnet`, () => {
    const v = findMainnetSecurityViolations({ [flag]: bypass }, { devUnsafe: false });
    assert.equal(v.length, 1, `${flag}=${bypass} must produce exactly one violation`);
    assert.match(v[0], pattern, 'the message must say what the flag actually does');
  });

  test(`${flag}=${safe} is NOT a violation`, () => {
    const v = findMainnetSecurityViolations({ [flag]: safe }, { devUnsafe: false });
    assert.equal(v.length, 0, `${flag}=${safe} is the safe value and must be allowed`);
  });
}

test('J41_SCAN_BUYER_CHAT unset is safe — scanning is default-on', () => {
  // The bypass is '0', not "absent". An unset flag must not be treated as opt-out.
  assert.equal(findMainnetSecurityViolations({}, { devUnsafe: false }).length, 0);
});

test('J41_PLATFORM_SIGNER is deliberately NOT gated here', () => {
  // The SDK already refuses to run on mainnet without the pin (audit H9,
  // client/index.ts). Duplicating it would create a second place to forget.
  const v = findMainnetSecurityViolations({ J41_PLATFORM_SIGNER: '' }, { devUnsafe: false });
  assert.ok(!v.some(s => /PLATFORM_SIGNER/.test(s)));
});

test('every violation names its flag, so the operator can act on the message alone', () => {
  const all = {
    J41_SIGNING_BROKER: '0', J41_DISABLE_BWRAP: '1', J41_ALLOW_LOCAL_UPSTREAM: '1',
    J41_SKIP_STATUS_CHECK: '1', J41_ALLOW_LEGACY_REVOKE: '1', J41_WITNESS_VERIFY: 'off',
    J41_ALLOW_UNPRICED_JOBS: '1', J41_SCAN_BUYER_CHAT: '0',
    J41_ALLOW_INSECURE: '1', J41_LOCAL_SIGNER_TEST_MODE: '1', J41_TRUST_PLATFORM_RESOLUTION: '1',
  };
  const v = findMainnetSecurityViolations(all, { devUnsafe: true });
  assert.equal(v.length, 12, '11 env flags + --dev-unsafe');
  for (const msg of v) {
    assert.match(msg, /^(J41_[A-Z_]+=|--dev-unsafe)/, `violation must start with the flag: ${msg}`);
    assert.match(msg, / — /, `violation must explain itself: ${msg}`);
  }
});

// ── P5: spend-policy integrity facts (passed in to keep the function pure) ──
test('a clamped refund_limits key is a mainnet violation', () => {
  const v = findMainnetSecurityViolations({}, { clampedConfigKeys: ['max_value_multiplier'] });
  assert.equal(v.length, 1);
  assert.match(v[0], /max_value_multiplier/);
  assert.match(v[0], /clamped/);
});

test('an unwritable spend-ledger is a mainnet violation', () => {
  const v = findMainnetSecurityViolations({}, { spendLedgerWritable: false });
  assert.equal(v.length, 1);
  assert.match(v[0], /spend-ledger/);
});

test('clean spend-policy facts add no violations', () => {
  const v = findMainnetSecurityViolations({}, { clampedConfigKeys: [], spendLedgerWritable: true });
  assert.deepEqual(v, []);
});

test('a writable ledger (true) and absent clamps add nothing', () => {
  assert.deepEqual(findMainnetSecurityViolations({}, { spendLedgerWritable: true }), []);
});

test('B3: a clamped COUNT limit is NOT a mainnet violation (documented backlog workflow)', () => {
  assert.deepEqual(findMainnetSecurityViolations({}, { clampedConfigKeys: ['max_sends_per_hour'] }), []);
  assert.deepEqual(findMainnetSecurityViolations({}, { clampedConfigKeys: ['max_sends_per_job'] }), []);
});

test('B3: only a clamped VALUE multiplier blocks a mainnet start', () => {
  const v = findMainnetSecurityViolations({}, { clampedConfigKeys: ['max_sends_per_hour', 'max_value_multiplier'] });
  assert.equal(v.length, 1);
  assert.match(v[0], /max_value_multiplier/);
});
