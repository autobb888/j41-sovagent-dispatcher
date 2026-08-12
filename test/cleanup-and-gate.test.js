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
  // Anchor on the C1 recording's OWN guard, not on a window measured from the
  // activate call. The window approach broke silently when the chain-repair block
  // was inserted between them: the repair has its own `_inboxLastWrite.set` at
  // +1367, so a 3500-char window matched THAT and stopped testing this. Widening
  // the window is what caused it — the fix is to stop using distance as an anchor.
  const i = CLI.indexOf('if (_toggleOnChain && result && result.onChainTxid) {');
  assert.ok(i > -1, 'the C1 recording guard must exist');
  assert.match(CLI.slice(i, i + 300), /_inboxLastWrite\.set/,
    'unrecorded, the first inbox sweep double-spends this prevOutput');
});

test('_inboxLastWrite exists before the activation loop can write to it', () => {
  // It was created lazily inside the inbox sweep, whose interval first fires at
  // +60s — well after the activation loop reaches every agent. The repair's
  // `.set` therefore threw, the catch reported a SUCCESSFUL on-chain write as
  // "repair FAILED", and the operator was told to run `activate` — broadcasting a
  // second identity write on top of the unconfirmed first. Our own error message
  // instructing the double-spend the release exists to remove.
  const i = CLI.indexOf('const state = {');
  assert.ok(i > -1);
  assert.match(CLI.slice(i, i + 3000), /_inboxLastWrite: new Map\(\)/,
    'must be initialized in the state literal, not lazily by a timer');
});

test('the chain-axis repair is GUARDED, gated, and recorded', () => {
  // The highest-risk code in the release: it broadcasts a blockchain transaction.
  // Pin the guard condition, not the identifier — `if (false && _plan.repairChain)`
  // leaves every identifier in place while restoring the stranded-fleet bug, and
  // the whole 1047-test suite passed against exactly that mutation.
  const i = CLI.indexOf("if (_plan.repairChain && agentInfo.chainStatus !== 'active') {");
  assert.ok(i > -1, 'the repair must be guarded on the plan AND a non-active chain axis');
  const body = CLI.slice(i, i + 2600);
  assert.match(body, /shouldDeferForPendingWrite/,
    'broadcasting without the pending-write gate is the -25 double-spend');
  // Pin the SOURCE of the gate value, not just the call. `const _pwr = null` leaves
  // every identifier and the call site intact while disabling the gate entirely —
  // a mutant that survived the first version of this assertion.
  assert.match(body, /const _pwr = state\._inboxLastWrite\.get\(agentInfo\.id\)/,
    'the gate must read the real pending write');
  assert.match(body, /setOnChainStatus\('active'\)/, 'the repair must actually write');
  assert.match(body, /_inboxLastWrite\.set/, 'the repair write must be recorded for the next sweep');
});

test('the startup read captures the chain axis from the profile, not a constant', () => {
  // Hardcoding `_lastSeenChainStatus = 'active'` disables every downstream repair
  // decision while leaving the variable, the field and the plan intact. This is the
  // mutation class that motivated extracting planAgentActivation in the first place,
  // and it still survived the extraction — because nothing pinned the READ.
  assert.match(CLI, /_lastSeenChainStatus = chainAgentStatus\(profile\)/,
    'the chain axis must come from the profile');
  assert.match(CLI, /chainStatus: _lastSeenChainStatus \|\| 'unknown'/,
    'and must be carried onto the agent record');
});

test('the confirmation wait REFRESHES the chain snapshot it invalidates', () => {
  // The wait exists because the deactivate has not confirmed yet — so by the time
  // it does, the snapshot read ~1000 lines earlier says `active` while the chain
  // says `inactive`. Planning against the stale value skipped the repair and left
  // the agent unhireable with every local surface green. On a real upgrade the
  // deactivates confirm at different times, producing a MIX of repaired and
  // silently stranded agents.
  const i = CLI.indexOf('shutdown deactivate(s) to confirm');
  const block = CLI.slice(i, i + 3000);
  assert.match(block, /ai\.chainStatus = chainNow/, 'the snapshot must be refreshed during the wait');
  assert.match(block, /ai\.chainStatus = 'inactive'/, 'a confirmed deactivate means the chain axis IS inactive');
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
  // Anchored on the guard itself, not on a distance from the activate call. Two
  // tests in this file silently stopped testing their subject when the repair block
  // was inserted and pushed it out of a fixed-size window — including this one.
  const i = CLI.indexOf('if (_toggleOnChain && !(result && result.onChainTxid)) {');
  assert.ok(i > -1, 'null txid IS the failure signal, and must be the guard condition');
  assert.match(CLI.slice(i, i + 500), /ON-CHAIN activate FAILED/,
    'a rejected write must not read as success');
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
  // Pin the GUARD. `if (false && _pendingIds.length)` leaves the log line, the
  // txid capture and the whole loop body in place while making the wait dead code
  // again — which is how it stayed dead from 2.28.2 through two reviews.
  assert.match(CLI, /\n      if \(_pendingIds\.length\) \{/,
    'the wait must be guarded on real pending txids, not disabled in place');
  const block = CLI.slice(Math.max(0, i - 900), i + 3400);
  // Per-TXID confirmation, not a wall-clock guess: a flat 75s wait left 5 of 9
  // activates rejected because Verus block time varies.
  assert.match(block, /const _dtxids = _shutdownDeactivateTxids/, 'the wait must read real txids');
  assert.match(block, /prevOut === _dtxids\[id\]/, 'confirmation is prevOutput matching the txid');
  // Release on the real condition too. Txid equality alone never releases once any
  // later identity write has superseded that output, so it burned the full three
  // minutes in exactly the recovery situations that are already confusing.
  assert.match(block, /chainNow === 'inactive'/, 'the wait must also release on the chain axis');
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
