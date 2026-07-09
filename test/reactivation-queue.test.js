'use strict';
const test = require('node:test');
const assert = require('node:assert');
const rq = require('../src/reactivation-queue.js');

const entry = (id, pausedAt, ready = false, pauseTtlMin = 60) =>
  ({ job: { id, description: 'd', buyerVerusId: 'b' }, agentId: 'agent-5', pausedAt, pauseTtlMin, readyToRespawn: ready });

test('enqueue adds once; has reflects membership; no duplicate by job.id', () => {
  let q = [];
  q = rq.enqueue(q, entry('j1', 1000));
  q = rq.enqueue(q, entry('j1', 2000)); // duplicate id — ignored
  assert.strictEqual(q.length, 1);
  assert.ok(rq.has(q, 'j1'));
  assert.ok(!rq.has(q, 'jX'));
});

test('markReady flips the flag and returns found', () => {
  let q = rq.enqueue([], entry('j1', 1000));
  assert.strictEqual(rq.markReady(q, 'j1'), true);
  assert.strictEqual(q[0].readyToRespawn, true);
  assert.strictEqual(rq.markReady(q, 'nope'), false);
});

test('nextReady returns the oldest ready entry, null if none ready', () => {
  let q = [];
  q = rq.enqueue(q, entry('old', 1000, true));
  q = rq.enqueue(q, entry('new', 5000, true));
  q = rq.enqueue(q, entry('notready', 500, false));
  assert.strictEqual(rq.nextReady(q).job.id, 'old');
  const q2 = [entry('a', 1, false)];
  assert.strictEqual(rq.nextReady(q2), null);
});

test('removeJob drops the entry', () => {
  let q = rq.enqueue([], entry('j1', 1000));
  q = rq.removeJob(q, 'j1');
  assert.strictEqual(q.length, 0);
});

test('findExpired returns entries past pauseTtlMin from pausedAt', () => {
  const now = 100 * 60000; // 100 min in ms
  let q = [];
  q = rq.enqueue(q, entry('fresh', 90 * 60000, false, 60));   // aged 10 min < 60 → not expired
  q = rq.enqueue(q, entry('stale', 30 * 60000, false, 60));   // aged 70 min >= 60 → expired
  const exp = rq.findExpired(q, now);
  assert.deepStrictEqual(exp.map(e => e.job.id), ['stale']);
});
