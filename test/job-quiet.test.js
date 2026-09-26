'use strict';

process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hireAnswerStartsQuiet, quietDeliverReady, ACCEPTED_QUIET_MS } = require('../src/job-agent.js');

test('a real hire answer starts the 90s close; the outage line and a silent executor do not', () => {
  assert.equal(hireAnswerStartsQuiet({
    conversationLog: [{ role: 'assistant', content: 'Keep the Fuji in the crisper. pong' }],
  }), true);
  assert.equal(hireAnswerStartsQuiet({
    conversationLog: [{ role: 'assistant', content: 'I experienced a temporary issue. Please try sending your message again.' }],
  }), false);
  assert.equal(hireAnswerStartsQuiet({ conversationLog: [] }), false);
  assert.equal(hireAnswerStartsQuiet(null), false);
  assert.equal(hireAnswerStartsQuiet({
    conversationLog: [{ role: 'assistant', content: 'Hi, I am your assistant. How can I help?', greeting: true }],
  }), false);
});

test('the short close runs after the hire answer without a later buyer chat', () => {
  assert.equal(quietDeliverReady({
    messageCount: 0, hireAnswered: true, idleMs: ACCEPTED_QUIET_MS, idleLimit: 480000,
  }), true);
  assert.equal(quietDeliverReady({
    messageCount: 0, hireAnswered: false, idleMs: ACCEPTED_QUIET_MS, idleLimit: 480000,
  }), false);
  assert.equal(quietDeliverReady({
    messageCount: 1, hireAnswered: false, idleMs: ACCEPTED_QUIET_MS - 1, idleLimit: 480000,
  }), false);
  assert.equal(quietDeliverReady({
    messageCount: 0, hireAnswered: true, idleMs: 480000, idleLimit: 480000,
  }), false);
});
