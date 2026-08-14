'use strict';
/**
 * The send-history lock must not lose a write, even under a true race.
 *
 * `withSendHistoryLock` serializes the read-modify-write of send-history.json,
 * which backs the LIFETIME "max 3 sends per job" cap and the hourly global cap.
 * A lost update is not a cosmetic counter glitch: it under-counts sends, and the
 * cap then permits an extra refund broadcast to a buyer.
 *
 * This needs REAL concurrent processes. Sequential in-process calls cannot
 * reproduce it — each one sees the previous call's committed file and appends
 * correctly. That is the same false negative documented in send-lock-race.test.js,
 * where it let three broken implementations of the sibling lock look fine.
 *
 * The two seeded scenarios matter more than the clean one: an unheld lock file
 * left by a crashed process is what pushes contenders down the STEAL path, and
 * the steal is where the defect lived — it judged the holder by age and then
 * unlink-then-created, so a second contender's unlink could delete the FIRST's
 * freshly created live lock and put both inside the critical section.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RACER = path.join(__dirname, 'fixtures', 'send-history-racer.js');
const JOB = 'job-history-race';

/** A pid that is certainly not running, so the lock reads as stealable. */
const DEAD_PID = 999997;

function raceRound({ racers, seedLock }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-histrace-'));
  const dispatcherDir = path.join(home, '.j41', 'dispatcher');
  fs.mkdirSync(dispatcherDir, { recursive: true, mode: 0o700 });
  const historyPath = path.join(dispatcherDir, 'send-history.json');
  if (seedLock) fs.writeFileSync(`${historyPath}.lock`, seedLock);

  const startAt = Date.now() + 1200; // children spin to this instant
  const kids = Array.from({ length: racers }, () =>
    spawn(process.execPath, [RACER, JOB, String(startAt)],
      // stderr was 'ignore', which threw away the only evidence that
      // distinguishes the two ways this test can fail. withSendHistoryLock has a
      // DELIBERATE fallback: past a 5s acquire deadline it runs the write
      // UNSERIALIZED rather than dropping a send record, and announces that on
      // stderr. So "7 records from 8 writers" means either the lock is broken or
      // the documented fallback fired under load — and without stderr the two are
      // indistinguishable. Observed 2/18 under full-suite CPU contention.
      { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] }));

  return new Promise((resolve) => {
    let exited = 0;
    const outs = new Array(kids.length).fill('');
    const errs = new Array(kids.length).fill('');
    const finish = () => {
      let recorded = 0;
      try {
        const H = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        recorded = (H.perJob && Array.isArray(H.perJob[JOB])) ? H.perJob[JOB].length : 0;
      } catch { recorded = 0; }
      const reported = outs.filter((o) => o.includes('RECORDED')).length;
      const unserialized = errs.filter((e) => e.includes('UNSERIALIZED')).length;
      fs.rmSync(home, { recursive: true, force: true });
      resolve({ recorded, reported, unserialized, errs });
    };
    kids.forEach((c, i) => {
      c.stdout.on('data', (d) => { outs[i] += String(d); });
      c.stderr.on('data', (d) => { errs[i] += String(d); });
      c.on('exit', () => { if (++exited === kids.length) finish(); });
    });
  });
}

test('concurrent recorders do not lose a send record (clean lock)', async () => {
  const { recorded, reported, unserialized, errs } = await raceRound({ racers: 8 });
  assert.equal(reported, 8, 'every child should have completed its record call');
  assert.equal(recorded, 8,
    `expected 8 records on disk, found ${recorded} — a lost read-modify-write ` +
    `under-counts the per-job cap and grants an extra refund send. ` +
    `${unserialized} writer(s) fell back to UNSERIALIZED; stderr: ${JSON.stringify(errs)}`);
});

test('concurrent recorders do not lose a send record when a DEAD holder must be stolen', async () => {
  // The steal path: a crashed process left its lock behind. Every contender
  // judges it dead at the same instant and races to reclaim it — which is where
  // unlink-then-create let two of them into the critical section at once.
  const { recorded, reported, unserialized, errs } = await raceRound({
    racers: 8,
    seedLock: `${DEAD_PID}:${Date.now() - 60_000}:1`,
  });
  assert.equal(reported, 8);
  assert.equal(recorded, 8,
    `expected 8 records on disk, found ${recorded} — the steal path lost a write. ` +
    `${unserialized} writer(s) fell back to UNSERIALIZED; stderr: ${JSON.stringify(errs)}`);
});

test('a stale lock with unparseable content is still reclaimed by age', async () => {
  // Legacy or torn content: no usable pid, so the liveness check cannot apply and
  // the age fallback is all there is.
  //
  // This is the case that caught a real defect. The window was 10s against a 5s
  // acquire deadline, so the reclaim could never fire — every contender spun out
  // and wrote UNSERIALIZED, and 4 recorders left 3 records. The window is now
  // shorter than the deadline so the path is actually reachable.
  const { recorded, reported, unserialized, errs } = await raceRound({ racers: 4, seedLock: 'garbage-no-pid' });
  assert.equal(reported, 4);
  assert.equal(recorded, 4, `expected 4 records, found ${recorded}; ${unserialized} UNSERIALIZED; stderr: ${JSON.stringify(errs)}`);
});

test('a lock held by a LIVE process is never stolen', async () => {
  // The inverse guard. A live holder's lock must survive: if contenders steal it,
  // the fix has traded one lost-update path for another.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-histlive-'));
  const dispatcherDir = path.join(home, '.j41', 'dispatcher');
  fs.mkdirSync(dispatcherDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dispatcherDir, 'send-history.json.lock');
  // Our own pid is unambiguously alive, and the timestamp is old enough that a
  // purely age-based implementation would steal it.
  const content = `${process.pid}:${Date.now() - 60_000}:1`;
  fs.writeFileSync(lockPath, content);

  const startAt = Date.now() + 400;
  const kid = spawn(process.execPath, [RACER, JOB, String(startAt)],
    { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((r) => kid.on('exit', r));

  const after = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null;
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(after, content, 'a live holder\'s lock must not be stolen or replaced');
});
