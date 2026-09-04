'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dispatcherLogPath, stdoutIsLogFile, attachDispatcherLog } = require('../src/dispatcher-log');

test('dispatcherLogPath is under ~/.j41/dispatcher/dispatcher.log', () => {
  assert.equal(dispatcherLogPath('/home/xd322'), '/home/xd322/.j41/dispatcher/dispatcher.log');
});

test('stdoutIsLogFile is true when inodes match', () => {
  assert.equal(stdoutIsLogFile('/tmp/x', () => ({ dev: 1, ino: 9 }), () => ({ dev: 1, ino: 9 })), true);
  assert.equal(stdoutIsLogFile('/tmp/x', () => ({ dev: 1, ino: 9 }), () => ({ dev: 1, ino: 8 })), false);
});

test('attachDispatcherLog tees when stdout is not the log file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-dlog-'));
  const writes = [];
  const stdout = { write(chunk, enc, cb) { return true; } };
  const stderr = { write(chunk, enc, cb) { return true; } };
  const r = attachDispatcherLog({
    homedir: home,
    stdout,
    stderr,
    fstatSync: () => ({ dev: 1, ino: 1 }),
    statSync: () => ({ dev: 1, ino: 2 }),
    writeSync: (fd, chunk) => { writes.push(String(chunk)); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.tee, true);
  stdout.write('hello');
  assert.ok(writes.some((w) => w.includes('hello')));
  fs.rmSync(home, { recursive: true, force: true });
});

test('attachDispatcherLog does not tee when stdout is already the log inode', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-dlog-'));
  const r = attachDispatcherLog({
    homedir: home,
    fstatSync: () => ({ dev: 7, ino: 11 }),
    statSync: () => ({ dev: 7, ino: 11 }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.tee, false);
  fs.rmSync(home, { recursive: true, force: true });
});
