'use strict';
/**
 * The send lock must admit exactly one process, even under a true race.
 *
 * `acquireSendLock` guards `attemptPendingRefund` (money to an EXTERNAL buyer
 * address) and `wallet send`. Two holders means two broadcasts.
 *
 * This needs REAL concurrent processes. In-process sequential calls cannot
 * reproduce it — the second call sees the first's completed state and correctly
 * refuses, which is exactly the false negative that let three broken
 * implementations look fine:
 *
 *   unlink-then-create        12/15 rounds had 2-5 winners
 *   rename-ours + read back   15/15 rounds had 7-9 winners
 *   rename-the-stale-lock-away 15/20 rounds had 2-7 winners
 *
 * All three decided "stale" against the old lock and then acted on whatever
 * occupied the path by that point — often a peer's fresh, live lock.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RACER = path.join(__dirname, 'fixtures', 'lock-racer.js');

function raceRound({ racers, lockContent, gateContent }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-lockrace-'));
  const locks = path.join(home, '.j41', 'dispatcher', 'refund-locks');
  fs.mkdirSync(locks, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(locks, 'job-race.lock'), lockContent);
  // Optionally seed an ORPHANED steal gate — the reclaim path, which the
  // original stress never touched because a gate is only ever held for
  // microseconds and never survives a clean run.
  if (gateContent) fs.writeFileSync(path.join(locks, 'job-race.lock.steal'), gateContent);

  const startAt = Date.now() + 700; // all children spin to this instant
  const kids = Array.from({ length: racers }, () =>
    require('child_process').spawn(process.execPath, [RACER, 'job-race', String(startAt)],
      { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'ignore'] }));

  return Promise.all(kids.map((c) => new Promise((resolve) => {
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', () => resolve(out));
  }))).then((outs) => {
    fs.rmSync(home, { recursive: true, force: true });
    return outs.filter((o) => o.includes('ACQUIRED')).length;
  });
}

test('exactly one process wins a race for a STALE lock', async () => {
  // A lock left behind by a dead process — the only case a steal is allowed.
  const deadHolder = `999999:${Date.now()}`;
  for (let round = 0; round < 6; round++) {
    const winners = await raceRound({ racers: 10, lockContent: deadHolder });
    assert.equal(winners, 1, `round ${round + 1}: ${winners} processes believed they held the lock`);
  }
});

test('NO process wins a race for a lock held by a LIVE process', async () => {
  // The live holder here is this very test process, with a deliberately ancient
  // timestamp: `wallet send` holds the lock across an interactive prompt, so a
  // slow human must never look like a crash.
  const liveButSlow = `${process.pid}:${Date.now() - 60 * 60 * 1000}`;
  const winners = await raceRound({ racers: 10, lockContent: liveButSlow });
  assert.equal(winners, 0, `${winners} processes robbed a live holder`);
});

test('exactly one process wins when the STEAL GATE itself was orphaned', async () => {
  // Reclaiming an orphaned gate is a steal too, and the first implementation
  // reclaimed it with unlink-then-create — the very pattern this file exists to
  // prove wrong one layer down. It measured 2 bad rounds in 25.
  //
  // The decisive defect found while fixing it: openSync(wx) CREATES the lock
  // file and writeSync fills it a moment later, so a contender reading in that
  // gap sees '' — and an empty lock was being classified as stale. A process
  // could therefore steal a lock that was in the act of being created. Caught by
  // printing which pid each winner's own lock file named: one winner's lock
  // named somebody else.
  const deadHolder = `999999:${Date.now()}`;
  const deadGate = '999998.deadbeefcafe';
  for (let round = 0; round < 6; round++) {
    const winners = await raceRound({ racers: 12, lockContent: deadHolder, gateContent: deadGate });
    assert.equal(winners, 1, `round ${round + 1}: ${winners} processes believed they held the lock`);
  }
});

test('an orphaned gate does not permanently wedge the agent', async () => {
  // Failing closed forever would be safe for money and useless in practice: the
  // refund would never be paid. Exactly one contender must get through.
  const winners = await raceRound({
    racers: 4, lockContent: `999999:${Date.now()}`, gateContent: '999998.abc',
  });
  assert.equal(winners, 1, 'a dead gate must be reclaimable, not a permanent block');
});
