'use strict';
// Child process for the send-history lock race test.
//
// Spins to a shared start instant so every racer enters withSendHistoryLock
// together — process startup jitter alone would serialise them and hide the race
// (that is documented as the exact false negative that let three broken versions
// of the sibling send lock look fine).
//
// Each child records ONE send and exits. The parent then counts the records on
// disk: the lock's whole job is that N concurrent recorders leave N records, and
// a lost read-modify-write shows up as a missing one. That measures the actual
// harm — an under-counted per-job cap grants an extra refund broadcast — rather
// than an intermediate notion of "who held the lock".
process.env.NODE_ENV = 'test';
const { recordDispatcherSend } = require('../../src/cli.js');

const jobId = process.argv[2];
const startAt = Number(process.argv[3]);

while (Date.now() < startAt) { /* barrier */ }
try {
  recordDispatcherSend(jobId, 0.1);
  process.stdout.write('RECORDED\n');
} catch (e) {
  process.stdout.write(`ERROR ${e && e.message}\n`);
}
process.exit(0);
