'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { liveLogPath, archiveLogPath } = require('../src/job-log.js');
test('liveLogPath builds JOBS_DIR/_live/<id>.log', () => {
  assert.equal(liveLogPath('/j/jobs', 'abc'), '/j/jobs/_live/abc.log');
});
test('archiveLogPath builds JOBS_DIR/_logs/<id>.log', () => {
  assert.equal(archiveLogPath('/j/jobs', 'abc'), '/j/jobs/_logs/abc.log');
});

// ── isPrivateIp — IPv6 loopback + private address coverage ──────────────────
const { isPrivateIp } = require('../src/proxy-handler.js');
for (const ip of [
  '::1',
  '0:0:0:0:0:0:0:1',
  '0::1',
  '::ffff:7f00:1',
  '::ffff:127.0.0.1',
  '127.0.0.1',
  '169.254.169.254',
  '10.0.0.1',
  '192.168.1.1',
]) {
  test(`isPrivateIp blocks ${ip}`, () => assert.equal(isPrivateIp(ip), true));
}
for (const ip of ['1.1.1.1', '8.8.8.8']) {
  test(`isPrivateIp allows ${ip}`, () => assert.equal(isPrivateIp(ip), false));
}
