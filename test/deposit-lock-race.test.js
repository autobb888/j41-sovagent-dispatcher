'use strict';
/**
 * M4 chunk 4 — the deposit ledger must survive two processes writing it.
 *
 * `deposits credit` runs out-of-band while the daemon is up; that is the
 * documented operator workflow, not an edge case. Meanwhile the poller
 * read-modify-writes deposits.json every 60 seconds and every proxied request
 * read-modify-writes credit-meters.json. Atomic tmp→rename protects against a
 * TORN file and does nothing about a lost update: two processes load the same
 * snapshot, both save, and the second silently erases the first.
 *
 * If the erased write was a dedup entry, that txid can be credited again. If it
 * was a reversal, the reconciler runs the whole miss cycle a second time and
 * debits the buyer twice.
 *
 * This needs REAL concurrent processes — the same false negative documented in
 * send-lock-race.test.js, where in-process calls let three broken
 * implementations of a sibling lock look fine.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RACER = path.join(__dirname, 'fixtures', 'deposit-racer.js');
const AGENT = 'agent-lock-race';

function raceRound({ racers, seedLock }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-deplock-'));
  const dir = path.join(home, '.j41', 'dispatcher', 'agents', AGENT);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'deposits.json');
  fs.writeFileSync(file, JSON.stringify({ processed: [], pending: [], reversed: [], creditedTxids: [] }));
  if (seedLock) fs.writeFileSync(path.join(dir, 'deposits.lock'), seedLock);

  const startAt = Date.now() + 1200;
  const kids = Array.from({ length: racers }, (_, i) =>
    spawn(process.execPath, [RACER, AGENT, String(i), String(startAt)],
      { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'ignore'] }));

  return new Promise((resolve) => {
    let exited = 0;
    const outs = new Array(kids.length).fill('');
    kids.forEach((c, i) => {
      c.stdout.on('data', (d) => { outs[i] += String(d); });
      c.on('exit', () => {
        if (++exited !== kids.length) return;
        let recorded = 0;
        try { recorded = JSON.parse(fs.readFileSync(file, 'utf8')).processed.length; } catch { recorded = 0; }
        const ok = outs.filter((o) => o.includes('RECORDED')).length;
        fs.rmSync(home, { recursive: true, force: true });
        // Carry the children's own reports out with the count. A bare "expected
        // 6, found 5" cannot distinguish a LOST WRITE (every child says
        // RECORDED, the file disagrees — a lock bug) from a child that never got
        // the lock (FAILED:DEPOSIT_LOCK_BUSY — contention, or a slow machine) or
        // one that never started at all. This race is rare enough that a failure
        // which discards its own evidence costs a whole diagnostic cycle.
        resolve({ recorded, ok, outs });
      });
    });
  });
}

test('concurrent processes do not lose a ledger write', async () => {
  const { recorded, ok, outs } = await raceRound({ racers: 8 });
  assert.equal(ok, 8, `every contender should have completed; children said ${JSON.stringify(outs)}`);
  assert.equal(recorded, 8,
    `expected 8 records on disk, found ${recorded} — a lost read-modify-write here ` +
    `either re-opens a credited txid for re-crediting or replays a reversal. ` +
    `children said ${JSON.stringify(outs)}`);
});

test('a lock left behind by a dead process is reclaimed, not deadlocked on', async () => {
  // Without a reclaim path a single crash jams that agent's deposits forever.
  const { recorded, ok, outs } = await raceRound({
    racers: 6,
    seedLock: `999997:${Date.now() - 60_000}:deadbeef`,
  });
  assert.equal(ok, 6, `children said ${JSON.stringify(outs)}`);
  assert.equal(recorded, 6, `expected 6 records, found ${recorded}; children said ${JSON.stringify(outs)}`);
});

test('a lock held by a LIVE process is never stolen', async () => {
  // The inverse guard: if a live holder can be robbed, the fix has traded one
  // lost-update path for another. Our own pid is unambiguously alive, and the
  // timestamp is old enough that a purely age-based implementation would take it.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-deplive-'));
  const dir = path.join(home, '.j41', 'dispatcher', 'agents', AGENT);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'deposits.json'), JSON.stringify({ processed: [], pending: [], reversed: [], creditedTxids: [] }));
  const lockPath = path.join(dir, 'deposits.lock');
  const content = `${process.pid}:${Date.now() - 60_000}:live`;
  fs.writeFileSync(lockPath, content);

  const kid = spawn(process.execPath, [RACER, AGENT, 'x', String(Date.now() + 300)],
    { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  kid.stdout.on('data', (d) => { out += String(d); });
  await new Promise((r) => kid.on('exit', r));

  const after = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null;
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(after, content, 'a live holder\'s lock must survive');
  assert.ok(out.includes('FAILED:DEPOSIT_LOCK_BUSY'),
    `the contender must fail closed rather than proceed unserialised; got ${JSON.stringify(out)}`);
});

test('a stale window at or above the acquire deadline is refused outright', async () => {
  // The withSendHistoryLock bug: a 10s stale window against a 5s deadline made
  // the reclaim path unreachable, so every contender timed out and fell through
  // to writing unserialised — code that reads as protected and is not. Enforced
  // rather than documented, because a comment cannot fail a build.
  const { acquireFileLock } = require('../src/file-lock.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-lockcfg-'));
  await assert.rejects(
    () => acquireFileLock(path.join(dir, 'x.lock'), { staleMs: 5000, timeoutMs: 5000 }),
    /must be below timeoutMs/);
  fs.rmSync(dir, { recursive: true, force: true });
});
