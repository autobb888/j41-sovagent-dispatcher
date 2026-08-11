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
  const i = CLI.indexOf("agent.activate({ onChain: _plan.onChain })");
  assert.ok(i > -1, 'the activation call must exist');
  const after = CLI.slice(i, i + 3500); // window must survive comments being added between
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

test('a failed on-chain activate is reported as a failure, not a tick', () => {
  // Observed live on 2.28.0: nine consecutive "Transaction rejected by the network"
  // printed as "✅ active (on-chain txid: skipped)". The SDK returns null for a failed
  // write, so a null txid is a failure — and on-chain status is the lever backend's
  // hire gate reads, so hiding it means a hire can land on a stopped agent.
  const i = CLI.indexOf("agent.activate({ onChain: _plan.onChain })");
  assert.ok(i > -1, 'the activation call must exist');
  const after = CLI.slice(i, i + 3500);
  assert.match(after, /ON-CHAIN activate FAILED/, 'a rejected write must not read as success');
  assert.match(after, /!\(result && result\.onChainTxid\)/, 'null txid IS the failure signal');
  // And the chain axis must be repaired when it is stale, or the fleet is
  // unhireable with every local surface reporting green (the 2.28.x upgrade case).
  assert.match(after, /_plan\.repairChain/, 'a stale chain axis must be repaired, not ignored');
});

test('startup waits for its own deactivates to CONFIRM before re-activating', () => {
  // The collision is self-inflicted: stop writes N deactivates, start writes N
  // activates seconds later against the same prevOutputs, before any can confirm.
  // Anchor on the unique guard text. Two earlier attempts anchored on strings that
  // occur more than once ("Setting agents active" appears in a comment; the
  // readyAgents for-loop appears twice) and silently read a window tens of thousands
  // of characters from the code under test — a test that asserts against the wrong
  // region is worse than none.
  const i = CLI.indexOf('shutdown deactivate(s) to confirm');
  assert.ok(i > -1, 'the self-collision guard must exist');
  const block = CLI.slice(Math.max(0, i - 900), i + 1800);
  // Per-TXID confirmation, not a wall-clock guess: a flat 75s wait left 5 of 9
  // activates rejected because Verus block time varies.
  assert.match(block, /const _dtxids = _shutdownDeactivateTxids/, 'the wait must read real txids');
  assert.match(block, /prevOut === _dtxids\[id\]/, 'confirmation is prevOutput matching the txid');
  assert.ok(!/_blockMs/.test(block), 'the wall-clock guess must be gone');

  // The txids MUST be captured before the marker-clearing block, which either
  // unlinks the file or rewrites it without them. Reading them at the wait site
  // returned `{}` every time, making this whole guard dead code in every
  // configuration — including the one 2.28.2 shipped it for.
  const capture = CLI.indexOf('const _shutdownDeactivateTxids = readShutdownDeactivatedTxids()');
  const clear = CLI.indexOf('clearShutdownDeactivated()');
  assert.ok(capture > -1, 'the txids must be captured explicitly');
  assert.ok(capture < clear, 'capture must happen BEFORE the marker is cleared');
  assert.ok(clear < i, 'and the marker is cleared before the wait — hence the capture');
});
