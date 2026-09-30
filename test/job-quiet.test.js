'use strict';

process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hireAnswerStartsQuiet, quietDeliverReady, skipsFirstWork, answeredHireCanClose, ACCEPTED_QUIET_MS } = require('../src/job-agent.js');

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

const SELLER = 'iR7vcjyjdA1RpynjzBggBt7fHe2wmA4gyN';

test('a paid hire with only the idle notice still does the first work', () => {
  const idle = {
    senderVerusId: SELLER,
    content: 'Session going idle — I\'ll be here when you\'re ready to continue.',
  };
  assert.equal(skipsFirstWork({
    status: 'in_progress', messages: [idle], speakerIds: [SELLER], hasDelivery: false,
  }), false);
  assert.equal(skipsFirstWork({
    status: 'in_progress',
    messages: [{ senderVerusId: SELLER, content: 'Hello! I\'m your Verus agent. I\'ve accepted your job: "shielded hire review". How can I help you?' }],
    speakerIds: [SELLER],
  }), false);
  assert.equal(skipsFirstWork({
    status: 'in_progress',
    messages: [{ senderVerusId: SELLER, content: 'I experienced a temporary issue. Please try sending your message again.' }],
    speakerIds: [SELLER],
  }), false);
  assert.equal(skipsFirstWork({
    status: 'accepted',
    messages: [{ senderVerusId: SELLER, content: 'The crate name is FujiKeeper. pong' }],
    speakerIds: [SELLER],
  }), false);
});

test('a paid hire that already has a seller answer is a reconnect', () => {
  assert.equal(skipsFirstWork({
    status: 'in_progress',
    messages: [{ senderVerusId: SELLER, content: 'The crate name is FujiKeeper. pong' }],
    speakerIds: [SELLER],
    hasDelivery: false,
  }), true);
  assert.equal(skipsFirstWork({
    status: 'in_progress', messages: [], speakerIds: [SELLER], hasDelivery: true,
  }), true);
  assert.equal(skipsFirstWork({
    status: 'in_progress',
    messages: [{ senderVerusId: 'iBuyer', content: 'hello' }],
    speakerIds: [SELLER],
  }), false);
  assert.equal(skipsFirstWork({
    status: 'in_progress',
    messages: [{ sender_verus_id: SELLER, content: 'done' }],
    speakerIds: [],
  }), false);
});

test('an answered hire can close while accepted or in progress', () => {
  assert.equal(answeredHireCanClose('accepted'), true);
  assert.equal(answeredHireCanClose('in_progress'), true);
  assert.equal(answeredHireCanClose('paused'), false);
  assert.equal(answeredHireCanClose('delivered'), false);
  assert.equal(answeredHireCanClose('disputed'), false);
  assert.equal(answeredHireCanClose(null), false);
});
