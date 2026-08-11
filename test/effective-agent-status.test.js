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

const { effectiveAgentStatus } = require('../src/cli');

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
