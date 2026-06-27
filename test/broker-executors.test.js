'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validateContainerRecord } = require('../src/broker-executors.js');

test('validateContainerRecord rejects non-objects and oversize', () => {
  assert.throws(() => validateContainerRecord('not-an-object', 'job-1'));
  assert.throws(() => validateContainerRecord({ blob: 'x'.repeat(20000) }, 'job-1'));
});
test('validateContainerRecord rejects a record bound to a different job', () => {
  assert.throws(() => validateContainerRecord({ jobId: 'other' }, 'job-1'));
});
test('validateContainerRecord accepts a well-formed self-record', () => {
  assert.deepEqual(validateContainerRecord({ jobId: 'job-1', note: 'ok' }, 'job-1'), { jobId: 'job-1', note: 'ok' });
});
