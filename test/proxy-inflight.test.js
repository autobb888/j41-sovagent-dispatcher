'use strict';
/**
 * Per-buyer in-flight concurrency cap (audit H3).
 *
 * N concurrent proxy requests for the same buyer must not collectively
 * over-commit the balance: each one reserves the worst case, but the worst-case
 * reservation only protects a SINGLE request unless concurrency is bounded.
 * This limiter caps how many requests a buyer can have in flight at once.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { acquire, release, _reset, _count } = require('../src/proxy-inflight.js');

const AGENT = 'agent-1';
const BUYER = 'iBuyerInflight';

test('acquire succeeds up to the cap, then is denied', () => {
  _reset();
  const cap = 4;
  for (let i = 0; i < cap; i++) {
    assert.equal(acquire(AGENT, BUYER, cap), true, `slot ${i} should be granted`);
  }
  // cap+1 must be denied
  assert.equal(acquire(AGENT, BUYER, cap), false, 'over-cap request must be denied');
  assert.equal(_count(AGENT, BUYER), cap);
});

test('release frees a slot for a subsequent acquire', () => {
  _reset();
  const cap = 2;
  assert.equal(acquire(AGENT, BUYER, cap), true);
  assert.equal(acquire(AGENT, BUYER, cap), true);
  assert.equal(acquire(AGENT, BUYER, cap), false);
  release(AGENT, BUYER);
  assert.equal(_count(AGENT, BUYER), 1);
  assert.equal(acquire(AGENT, BUYER, cap), true);
});

test('different buyers have independent counters', () => {
  _reset();
  const cap = 1;
  assert.equal(acquire(AGENT, 'buyerA', cap), true);
  assert.equal(acquire(AGENT, 'buyerA', cap), false);
  // buyerB is unaffected
  assert.equal(acquire(AGENT, 'buyerB', cap), true);
});

test('same buyer on different agents has independent counters', () => {
  _reset();
  const cap = 1;
  assert.equal(acquire('agent-1', BUYER, cap), true);
  assert.equal(acquire('agent-1', BUYER, cap), false);
  // same buyer, different seller agent → independent
  assert.equal(acquire('agent-2', BUYER, cap), true);
});

test('release never drives the counter below zero', () => {
  _reset();
  release(AGENT, BUYER); // release with nothing acquired
  assert.equal(_count(AGENT, BUYER), 0);
  // and a fresh acquire still works
  assert.equal(acquire(AGENT, BUYER, 1), true);
  assert.equal(_count(AGENT, BUYER), 1);
});

test('counter drops the key entirely when it returns to zero (no leak)', () => {
  _reset();
  acquire(AGENT, BUYER, 2);
  release(AGENT, BUYER);
  assert.equal(_count(AGENT, BUYER), 0);
});
