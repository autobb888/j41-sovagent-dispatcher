'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isModelOutageText,
  buyerGreeting,
  reworkAnswerUsable,
  holdOpenForModelOutage,
} = require('../src/model-outage');

const ABORT = 'I experienced a temporary issue. Please try sending your message again.';
const GENERATE = 'I encountered an issue generating a response. Let me try to help directly — could you rephrase your question?';
const TOOLS = 'I encountered an issue processing your request. Please try again.';
const TEMPLATE = 'Hello! I\'m your Verus agent. I\'ve accepted your job: "Reply with the single word pong." How can I help you?';

test('the canned model lines are outages and a real answer is not', () => {
  assert.equal(isModelOutageText(ABORT), true);
  assert.equal(isModelOutageText('I experienced a temporary issue. Please try again.'), true);
  assert.equal(isModelOutageText('I could not generate a response.'), true);
  assert.equal(isModelOutageText(GENERATE), true);
  assert.equal(isModelOutageText(TOOLS), true);
  assert.equal(isModelOutageText('pong'), false);
  assert.equal(isModelOutageText(''), false);
  assert.equal(isModelOutageText('The!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'), true);
  assert.equal(isModelOutageText('!!!!!!!!!!!!'), true);
  assert.equal(isModelOutageText('Hello. The crate keeps the apple crisp.'), false);
});

test('an outage greeting is replaced by the template', () => {
  assert.equal(buyerGreeting(ABORT, TEMPLATE), TEMPLATE);
  assert.equal(buyerGreeting('   ', TEMPLATE), TEMPLATE);
  assert.equal(buyerGreeting('', TEMPLATE), TEMPLATE);
  assert.equal(buyerGreeting(null, TEMPLATE), TEMPLATE);
  assert.equal(buyerGreeting('Hello. I can answer this hire.', TEMPLATE), 'Hello. I can answer this hire.');
});

test('an outage is not a usable rework answer', () => {
  assert.equal(reworkAnswerUsable('Concrete hazards: sinkholes.'), true);
  assert.equal(reworkAnswerUsable(ABORT), false);
  assert.equal(reworkAnswerUsable(GENERATE), false);
  assert.equal(reworkAnswerUsable(TOOLS), false);
  assert.equal(reworkAnswerUsable('   '), false);
  assert.equal(reworkAnswerUsable('I received your message — one moment while I finish my current thought.'), false);
  assert.equal(reworkAnswerUsable('I\'ve reached the token budget for this job (5000 tokens used) — no further work is possible.'), false);
  assert.equal(reworkAnswerUsable('Concrete hazards: sinkholes.', { budgetGateHit: true }), false);
});

test('a hire stays open when the only model result is an outage', () => {
  assert.equal(holdOpenForModelOutage({ hireAnswered: false, outage: true }), true);
  assert.equal(holdOpenForModelOutage({ hireAnswered: true, outage: true }), false);
  assert.equal(holdOpenForModelOutage({ hireAnswered: false, outage: false }), false);
});

test('the worker stamps the idle clock after the model wait and will not publish an outage rework', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/job-agent.js'), 'utf8');
  const stamp = src.indexOf('the first tick does not see');
  const idleAt = src.indexOf('const idleCheck = setInterval');
  assert.ok(stamp > 0 && idleAt > stamp);
  assert.match(src.slice(stamp, stamp + 500), /_lastActivityAt = Date\.now\(\)/);
  assert.match(src.slice(idleAt, idleAt + 800), /holdOpenForModelOutage\(/);
  assert.match(src, /The canned fallback was not delivered/);
});
