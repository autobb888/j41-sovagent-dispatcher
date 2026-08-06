'use strict';
// Child process for the send-lock race test.
//
// Spins to a shared start instant so every racer reaches acquireSendLock
// together — process startup jitter alone would serialise them and hide the
// race (it did, on the first attempt).
//
// A winner then holds the lock until the PARENT kills it. Earlier versions held
// for a fixed duration, which made the test flaky in the one direction that
// matters: on a loaded machine the 12 spawns could spread wider than the hold,
// so a late starter found the lock genuinely free and won it legitimately —
// reported as a second winner. That is a test artifact, but a flaky test on the
// sole guard protecting a money lock is worse than no test, because it teaches
// people to dismiss the failure that counts. Holding until killed removes
// timing from the assertion entirely.
process.env.NODE_ENV = 'test';
const { acquireSendLock } = require('../../src/cli.js');
const startAt = Number(process.argv[3]);
(async () => {
  while (Date.now() < startAt) { /* barrier */ }
  const got = acquireSendLock(process.argv[2]);
  process.stdout.write(got ? 'ACQUIRED\n' : 'refused\n');
  if (got) {
    // Hold until the parent kills us — and keep the event loop ALIVE while doing
    // it. `await new Promise(() => {})` does NOT keep Node running: with no
    // pending handles the loop empties and the process exits immediately. The
    // winner then died, its lock went stale (dead pid), and the next racer
    // legitimately stole it — reported as a second winner. That was the entire
    // source of this test's flakiness, not the lock.
    const keepAlive = setInterval(() => {}, 1000);
    await new Promise(() => {});
    clearInterval(keepAlive); // unreachable; documents intent
  }
  else process.exit(0);
})();
