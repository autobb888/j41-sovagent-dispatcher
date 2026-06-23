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
