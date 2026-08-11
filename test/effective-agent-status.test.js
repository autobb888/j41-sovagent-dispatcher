/**
 * The two status axes, and why reading one of them is a fleet-loss bug.
 *
 * Backend shipped `agents.platform_status` on 2026-08-11 (089bf94, migration 058)
 * and made the hire gate a fail-closed AND over it and the on-chain-mirrored
 * `status`. On the same day we stopped writing `status` on-chain for routine
 * restarts, because the shutdown-deactivate and startup-activate writes spend the
 * same prevOutput and the second is always rejected.
 *
 * Those two changes interact. After a clean shutdown the chain — and therefore
 * `status` — still says `active`, while availability says `inactive`. A reader
 * that consults `status` alone concludes the fleet is healthy. Worse, the
 * activation loop's "already active, no write needed" skip then fires, so the
 * fleet is never brought back and /health reports ok through the whole outage.
 * That is the exact shape of the 2026-08-06 incident, re-created by a fix.
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  effectiveAgentStatus,
  chainAgentStatus,
  platformAgentStatus,
  planAgentActivation,
} = require('../src/cli');

test('inactive on the platform axis alone is inactive — the post-shutdown state', () => {
  // Chain says active because we deliberately no longer write it on restart.
  assert.equal(
    effectiveAgentStatus({ status: 'active', platformStatus: 'inactive' }),
    'inactive',
    'reading `status` alone here reports a healthy fleet that cannot take work',
  );
});

test('inactive on the chain axis alone is inactive — a genuinely retired agent', () => {
  assert.equal(effectiveAgentStatus({ status: 'inactive', platformStatus: 'active' }), 'inactive');
});

test('active requires BOTH axes — this is the hire gate, mirrored', () => {
  assert.equal(effectiveAgentStatus({ status: 'active', platformStatus: 'active' }), 'active');
});

test('disabled outranks inactive and is never flattened into it', () => {
  // `disabled` is a platform-side decision that start must never auto-restore,
  // so it has to survive the AND as itself rather than collapsing to `inactive`.
  assert.equal(effectiveAgentStatus({ status: 'active', platformStatus: 'disabled' }), 'disabled');
  assert.equal(effectiveAgentStatus({ status: 'disabled', platformStatus: 'active' }), 'disabled');
  assert.equal(effectiveAgentStatus({ status: 'inactive', platformStatus: 'disabled' }), 'disabled');
});

test('an older backend that omits platformStatus falls back to status alone', () => {
  // Exactly the pre-2026-08-11 behaviour — no silent change for anyone pointed at
  // a backend that has not deployed migration 058.
  assert.equal(effectiveAgentStatus({ status: 'active' }), 'active');
  assert.equal(effectiveAgentStatus({ status: 'inactive' }), 'inactive');
  assert.equal(effectiveAgentStatus({ status: 'disabled' }), 'disabled');
});

test('snake_case platform_status is accepted too', () => {
  // The contract says camelCase, but the column is snake_case and one
  // unserialized response would otherwise read as "no availability info" —
  // which fails OPEN, the direction that lands a hire on a stopped agent.
  assert.equal(effectiveAgentStatus({ status: 'active', platform_status: 'inactive' }), 'inactive');
});

test('nothing known reads as unknown, never as active', () => {
  assert.equal(effectiveAgentStatus({}), 'unknown');
  assert.equal(effectiveAgentStatus(null), 'unknown');
  assert.equal(effectiveAgentStatus(undefined), 'unknown');
  assert.equal(effectiveAgentStatus('active'), 'unknown', 'a bare string is not a profile');
});

test('an unrecognised status is passed through, not coerced', () => {
  // If backend adds a state we do not know about, guessing `active` would be the
  // dangerous guess. Surface it verbatim so it shows up in /health and inspect.
  assert.equal(effectiveAgentStatus({ status: 'suspended' }), 'suspended');
  assert.equal(effectiveAgentStatus({ platformStatus: 'suspended' }), 'suspended');
});

// ── The mixed-axis fail-open (Fable, review of 2.29.0) ──────────────────────

test('an unrecognised value on EITHER axis beats active — the mixed case', () => {
  // The first version asked "does any axis say active?", so {active, suspended}
  // resolved to ACTIVE. Since the chain axis reads `active` for every running
  // agent, the mixed case is the realistic one, not the exotic one: the day the
  // backend adds a blocking state on the platform axis, the hire gate would block
  // while we reported healthy AND skipped re-activation.
  assert.equal(effectiveAgentStatus({ status: 'active', platformStatus: 'suspended' }), 'suspended');
  assert.equal(effectiveAgentStatus({ status: 'suspended', platformStatus: 'active' }), 'suspended');
});

test('values are normalized for case and whitespace', () => {
  // `'INACTIVE' !== 'inactive'` would have read as not-inactive, and the whole
  // point of this function is that not-inactive means a hire can land.
  assert.equal(effectiveAgentStatus({ status: 'ACTIVE', platformStatus: 'INACTIVE' }), 'inactive');
  assert.equal(effectiveAgentStatus({ status: ' active ', platformStatus: 'Active' }), 'active');
  assert.equal(effectiveAgentStatus({ status: 'Disabled' }), 'disabled');
});

test('an empty string is "not reported", and both empty is unknown', () => {
  assert.equal(effectiveAgentStatus({ status: 'active', platformStatus: '' }), 'active');
  assert.equal(effectiveAgentStatus({ status: '', platformStatus: '' }), 'unknown');
  assert.equal(effectiveAgentStatus({ status: '   ' }), 'unknown');
});

test('the two axes are readable separately — /health needs both, not the AND', () => {
  const p = { status: 'inactive', platformStatus: 'active' };
  assert.equal(chainAgentStatus(p), 'inactive');
  assert.equal(platformAgentStatus(p), 'active');
  assert.equal(platformAgentStatus({ status: 'active' }), null, 'absent platform axis is null, not "active"');
});

// ── planAgentActivation: the startup decision, finally testable ─────────────
//
// This is the wiring that reverting the two-axis read left untouched: the whole
// 1023-test suite passed against the broken version. The loop it came from lives
// inside the `start` command closure and cannot be reached by a unit test.

test('UPGRADE from 2.28.x: chain inactive + platform active → repair the chain', () => {
  // The state EVERY upgrading operator is in, because 2.28.x deactivated on-chain
  // at shutdown by default. Without the repair the fleet is unhireable while the
  // start log prints nine ticks and /health reports ok.
  const plan = planAgentActivation({ platformStatus: 'active', chainStatus: 'inactive' }, { toggleOnChain: false });
  assert.equal(plan.skip, false, 'skipping here is what stranded the fleet');
  assert.equal(plan.repairChain, true);
});

test('steady state: both axes active → skip, zero transactions', () => {
  const plan = planAgentActivation({ platformStatus: 'active', chainStatus: 'active' }, { toggleOnChain: false });
  assert.equal(plan.skip, true);
  assert.equal(plan.onChain, false);
  assert.equal(plan.repairChain, false);
});

test('routine restart: platform inactive → platform write, no chain write', () => {
  const plan = planAgentActivation({ platformStatus: 'inactive', chainStatus: 'active' }, { toggleOnChain: false });
  assert.deepEqual([plan.skip, plan.onChain, plan.repairChain], [false, false, false]);
});

test('an unreadable chain axis does NOT trigger a repair', () => {
  // Writing on-chain on a guess costs a fee and risks a collision. "We could not
  // read it" must not be treated as "it is wrong".
  const plan = planAgentActivation({ platformStatus: 'active', chainStatus: 'unknown' }, { toggleOnChain: false });
  assert.equal(plan.skip, true);
  assert.equal(plan.repairChain, false);
});

test('with the on-chain opt-in, the activate carries the write and there is NO separate repair', () => {
  // Two identity writes for one agent in one pass is the double-spend this release
  // exists to remove. The repair must not stack on top of an on-chain activate.
  const plan = planAgentActivation({ platformStatus: 'active', chainStatus: 'inactive' }, { toggleOnChain: true });
  assert.equal(plan.skip, false);
  assert.equal(plan.onChain, true);
  assert.equal(plan.repairChain, false, 'the activate already writes on-chain');
});

test('the on-chain opt-in never skips — the operator asked for the write', () => {
  const plan = planAgentActivation({ platformStatus: 'active', chainStatus: 'active' }, { toggleOnChain: true });
  assert.equal(plan.skip, false);
  assert.equal(plan.onChain, true);
});
