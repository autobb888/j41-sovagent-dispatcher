'use strict';
// Child process for the send-lock race test. Spins to a shared start instant so
// every racer reaches acquireSendLock together — process startup jitter alone
// would serialise them and hide the race (it did, on the first attempt).
process.env.NODE_ENV = 'test';
const { acquireSendLock } = require('../../src/cli.js');
const startAt = Number(process.argv[3]);
(async () => {
  while (Date.now() < startAt) { /* barrier */ }
  const got = acquireSendLock(process.argv[2]);
  process.stdout.write(got ? 'ACQUIRED' : 'refused');
  if (got) await new Promise((r) => setTimeout(r, 800)); // hold, as a prompt would
})();
