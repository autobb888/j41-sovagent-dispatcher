/**
 * C1 + C2 — the two clusters where an earlier fix of mine made things worse.
 *
 * C1: 2.27.0 gated the SHUTDOWN on-chain deactivate against a pending inbox write but
 * left the STARTUP activation bare — the write most likely to collide with a sweep is
 * the one that happens seconds before the sweep timer first fires. It also used a flat
 * 8s sleep, which buys nothing against a ~60s Verus block, and left the inbox sweep
 * running through a drain that can last 120 minutes (the reverse collision).
 *
 * C2: 2.23.0's L2 fix moved getAgentSession + getJob + startJobContainer INSIDE the
 * bare 10s cleanup interval. `state.retries` is read-then-written across those awaits
 * with no lock, so two overlapping passes can each respawn the same job — a race that
 * was local-mode-only before, now reachable in the default Docker runtime.
 *
 * Source-level assertions: these live inside long interval bodies that cannot be
 * invoked in isolation, so pin the properties rather than the behaviour.
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const CLI = fs.readFileSync(require.resolve('../src/cli.js'), 'utf8');

test('C1a: the inbox sweep stops once shutdown begins', () => {
  const i = CLI.indexOf('async function checkPendingInbox');
  const body = CLI.slice(i, i + 900);
  assert.match(body, /state\.shuttingDown/,
    'a sweep running through a 120-minute drain double-spends the deactivate');
});

test('C1b: the shutdown deactivate uses the real confirmation gate, not a fixed sleep', () => {
  const i = CLI.indexOf("setOnChainStatus('inactive')");
  const before = CLI.slice(Math.max(0, i - 2600), i);
  assert.match(before, /shouldDeferForPendingWrite/,
    'a flat sleep is shorter than a block time and proves nothing');
  assert.ok(!/setTimeout\(r, 8000\)/.test(before), 'the 8s blind sleep must be gone');
});

test('C1c: the startup activation records its identity write', () => {
  const i = CLI.indexOf("agent.activate({ onChain: _toggleOnChain })");
  const after = CLI.slice(i, i + 900);
  assert.match(after, /_inboxLastWrite\.set/,
    'unrecorded, the first inbox sweep double-spends this prevOutput');
});

test('C2/S9: the cleanup loop is non-reentrant and counts its skips', () => {
  const i = CLI.indexOf('async function cleanupCompletedJobs');
  const body = CLI.slice(i, i + 900);
  // Pin the GUARD, not the identifier: asserting `_cleanupRunning` appears anywhere
  // passes even when the condition is `if (false)`, because the flag is still assigned
  // two lines later. Mutation-testing caught exactly that.
  assert.match(body, /if \(state\._cleanupRunning\)\s*\{/,
    'overlapping passes can double-respawn a job');
  assert.match(body, /state\._cleanupRunning\s*=\s*true/, 'the flag must actually be set');
  assert.match(body, /_cleanupSkips/, 'a silent skip is how capacity problems hide');
});

test('C2/L4: a Docker daemon error is not treated as a dead container', () => {
  assert.match(CLI, /cannot reach Docker \(\$\{e\.message\}\)/,
    'a dockerd blip must not tear down every in-flight job');
  const i = CLI.indexOf('cannot reach Docker');
  const near = CLI.slice(Math.max(0, i - 700), i);
  assert.match(near, /statusCode === 404/, 'only a genuine 404 means the container is gone');
  // And the classification must actually GATE the teardown — `if (false)` left the
  // string and the 404 check in place while restoring the original bug.
  assert.match(near, /if \(!_isGone\)\s*\{/,
    'the daemon-error branch must guard on the classification');
});
