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

// ── Round-3 findings: three mutations that survived the whole 1057-test suite ──

test('the startup wait has no out-of-scope watchdog reference', () => {
  // `kickWatchdog` is declared inside gracefulShutdown. Referencing it from the
  // `start` action is a ReferenceError, NOT a no-op — optional chaining guards a
  // null value, never an undeclared binding. It threw on the wait's first sleep,
  // the rejection was logged "non-fatal", and startup silently stopped: no
  // activation, no repair, no signal handlers, no startupComplete (so /health
  // stayed green) — a zombie process on exactly the upgrade this release performs.
  // Strip line comments first — the fix's own explanation names the identifier,
  // and a scan that cannot tell code from prose would fail on the documentation.
  const CODE = CLI.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  const i = CODE.indexOf('const kickWatchdog = (label) => {');
  assert.ok(i > -1, 'the shutdown watchdog must still exist');
  assert.ok(!/kickWatchdog\s*[(?]/.test(CODE.slice(0, i)),
    'kickWatchdog must not be referenced before its declaration — optional chaining ' +
    'does not make an undeclared binding safe');
});

test('the confirmation wait has a real deadline', () => {
  // `Date.now() + 0` makes the wait exit on its first check and go straight to
  // "activating anyway" — dead in place, with every log line still present. The
  // suite passed against exactly that.
  const i = CLI.indexOf('shutdown deactivate(s) to confirm');
  assert.match(CLI.slice(i, i + 400), /_deadline = Date\.now\(\) \+ 180000/,
    'the wait must actually wait');
});

test('the marker retains agents whose chain state could not be established', () => {
  // Retention keyed only on a positive `inactive` read dropped exactly the agents
  // whose wait timed out — so a deactivate landing after the deadline left them
  // unhireable AND unrestorable, since the next start skips anything not in the
  // marker.
  const i = CLI.indexOf('const _stillBroken = new Set(');
  assert.ok(i > -1);
  const body = CLI.slice(i, i + 700);
  assert.match(body, /_normStatus\(a\.chainStatus\) === 'inactive'/, 'positively-inactive agents are retained');
  assert.match(body, /\.\.\._unresolvedWaits/, 'so are agents whose wait never resolved');
  assert.match(CLI, /_unresolvedWaits\.add\(id\)/,
    'a timed-out wait must record which agents were unresolved');
});

test('the repair aborts — does not broadcast — when the pending write never clears', () => {
  // Removing the `continue` lets the repair broadcast on top of an unconfirmed
  // identity write: the -25 double-spend class this release exists to remove.
  const i = CLI.indexOf("if (_plan.repairChain && agentInfo.chainStatus !== 'active') {");
  const body = CLI.slice(i, i + 2600);
  const gate = body.indexOf('SKIPPING the');
  const write = body.indexOf("setOnChainStatus('active')");
  assert.ok(gate > -1 && write > gate, 'the skip path must precede the broadcast');
  assert.match(body.slice(gate, write), /continue;/,
    'the gate-timeout path must abort the iteration, not fall through to the write');
});

test('the inbox startup gate is BOUNDED — a wedged startup cannot silence it forever', () => {
  // `startupComplete` is set at exactly one line, at the very end of startup. A
  // plain `!== true` gate therefore meant that ANY error before that point silently
  // disabled on-chain reputation writes — reviews, attestations, job records — for
  // the life of the process. That trades a narrow, self-healing double-spend window
  // for a permanent, invisible data-loss one. A rejected identity tx is retried; a
  // review that is never written is simply gone.
  const i = CLI.indexOf('async function checkPendingInbox');
  const body = CLI.slice(i, i + 2200);
  assert.match(body, /state\.startupComplete !== true/, 'the gate must exist');
  assert.match(body, /INBOX_STARTUP_GRACE_MS/, 'and it must be time-bounded');
  assert.match(body, /_warnedInboxUngated/, 'and it must say so when it gives up waiting');
  // The bound is only real if the fallback compares against something that exists.
  const si = CLI.indexOf('const state = {');
  assert.match(CLI.slice(si, si + 2600), /startedAt:/,
    'state.startedAt must exist or the bound silently never defers');
});

test('an unresolvable deactivate txid is dropped, not re-armed every restart', () => {
  // If a later identity write superseded our deactivate, neither release condition
  // can ever match it — chain reads `active`, prevOutput is the other write. Keeping
  // the txid in the marker re-armed the same three-minute wait on every subsequent
  // start, forever. The agent stays retained (its chain state is genuinely unknown);
  // only the dead txid is dropped.
  // Anchor on the unique statement, not on the loop header — there are TWO
  // `for (const id of _left)` loops now (this one and the timeout re-read), and
  // indexOf finds the wrong one. Same distance-anchor trap as three earlier tests.
  const i = CLI.indexOf('_unresolvedWaits.add(id)');
  assert.ok(i > -1, 'the unresolved-wait handler must exist');
  const body = CLI.slice(i, i + 900);
  assert.match(body, /delete _shutdownDeactivateTxids\[id\]/, 'the unmatched txid is dropped');
});

test('every activation error branch marks the pass, so none is silently cleared', () => {
  // The success line clears `_agentErrors`. If an error branch forgets to record
  // that it set one, its diagnostic is erased seconds later and /health degrades
  // with no stated reason — the round-4 defect. The first fix was
  // `if (!has(id)) delete(id)`, a no-op dressed as a guard. This pins the real one.
  // Bound the region precisely: from the flag's declaration to the guarded clear.
  // Only writers BEFORE the clear can have their diagnostic erased by it — the one
  // in the outer catch runs after, and requiring it to mark would be wrong. A fixed
  // char window got this wrong in both directions before landing here.
  const i = CLI.indexOf('let _errorRecordedThisPass = false;');
  assert.ok(i > -1, 'the activation loop must track whether this pass recorded an error');
  const g = CLI.indexOf('if (!_errorRecordedThisPass)', i);
  assert.ok(g > i, 'the guarded clear must follow the declaration');
  const region = CLI.slice(i, g);

  const setsErr = (region.match(/state\._agentErrors\.set\(agentInfo\.id/g) || []).length;
  const marksPass = (region.match(/_errorRecordedThisPass = true;/g) || []).length;
  assert.ok(setsErr > 0, 'sanity: the loop does record errors before the clear');
  assert.equal(marksPass, setsErr,
    `every _agentErrors.set before the clear must mark the pass (${setsErr} sets, ${marksPass} marks)`);
  // Asserted against the whole file, not a window: the guard sits well past the
  // error branches and a fixed window is the anchor trap this file keeps hitting.
  assert.match(CLI, /if \(!_errorRecordedThisPass\)\s*\{\s*\n\s*state\._agentErrors\.delete/,
    'the clear must be guarded on the flag');
});

test('the on-chain default is derived from the backend, and env still overrides', () => {
  // Pin the wiring, not just the helper: the helper being correct is worthless if
  // the call site ignores it. Both explicit env values must still win — an operator
  // who knows their situation outranks our probe.
  const i = CLI.indexOf("const _envToggle = process.env.J41_STATUS_TOGGLE_ONCHAIN;");
  assert.ok(i > -1, 'the toggle must read the env var');
  const body = CLI.slice(i, i + 1400);
  assert.match(body, /_envToggle === '1' \|\| _envToggle === '0'/, 'both explicit values override');
  assert.match(body, /await backendSupportsPlatformStatus\(J41_API_URL\)/,
    'otherwise the default is asked of the backend');
  assert.match(body, /_toggleOnChain = !_sup\.supported/,
    'and an unsupported/unknown backend keeps on-chain writes ON');
});
