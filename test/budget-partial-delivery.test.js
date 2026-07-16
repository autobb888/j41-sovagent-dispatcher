'use strict';
/**
 * Task 2: Deliver partial work on budget exhaustion.
 *
 * Tests cover:
 *   1. shouldDeliverOnBudget / markBudgetDelivered on the Executor base class.
 *   2. handleBudgetDelivery helper (extracted from job-agent.js):
 *      - calls deliver() exactly once with the finalize() content (not the canned line)
 *      - calls endSession() exactly once
 *      - a second call is a no-op (deliver-once invariant)
 *   3. Gate-1 exhaustion in LocalLLMExecutor.handleMessage does NOT push the
 *      canned budget line onto conversationLog.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ─── 1. Executor base-class methods ─────────────────────────────────────────

test('shouldDeliverOnBudget: false when budget not set (unlimited)', () => {
  const { Executor } = require('../src/executors/base');
  const ex = new Executor();
  assert.equal(ex.shouldDeliverOnBudget(), false);
});

test('shouldDeliverOnBudget: false when budget is set but not exhausted', () => {
  const { Executor } = require('../src/executors/base');
  const ex = new Executor();
  ex.setBudget(1000);
  assert.equal(ex.shouldDeliverOnBudget(), false);
});

test('shouldDeliverOnBudget: true when budget is exhausted and not yet delivered', () => {
  const { Executor } = require('../src/executors/base');
  const ex = new Executor();
  ex.setBudget(100);
  ex._trackUsage({ prompt_tokens: 50, completion_tokens: 60, total_tokens: 110 });
  assert.equal(ex.isBudgetExhausted(), true);
  assert.equal(ex.shouldDeliverOnBudget(), true);
});

test('shouldDeliverOnBudget: false after markBudgetDelivered (deliver-once invariant)', () => {
  const { Executor } = require('../src/executors/base');
  const ex = new Executor();
  ex.setBudget(100);
  ex._trackUsage({ prompt_tokens: 50, completion_tokens: 60, total_tokens: 110 });
  assert.equal(ex.shouldDeliverOnBudget(), true);
  ex.markBudgetDelivered();
  assert.equal(ex.shouldDeliverOnBudget(), false);
  // Budget is still exhausted — only the flag changed
  assert.equal(ex.isBudgetExhausted(), true);
});

// ─── 2. handleBudgetDelivery helper ─────────────────────────────────────────

function makeStubExecutor({ exhausted = true } = {}) {
  return {
    conversationLog: [
      { role: 'user', content: 'Please write a summary.' },
      { role: 'assistant', content: 'Here is the summary of the findings so far.' },
    ],
    _budgetDelivered: false,
    isBudgetExhausted() { return exhausted; },
    shouldDeliverOnBudget() { return this.isBudgetExhausted() && !this._budgetDelivered; },
    markBudgetDelivered() { this._budgetDelivered = true; },
    async finalize() {
      const content = this.conversationLog.map(m => `${m.role}: ${m.content}`).join('\n\n');
      return { content, hash: 'h' };
    },
    budgetExhaustedMessage() {
      return 'I\'ve reached the token budget for this job (110 tokens used) and have requested a budget extension.';
    },
  };
}

test('handleBudgetDelivery: no-op when budget not exhausted', async () => {
  process.env.NODE_ENV = 'test';
  const { handleBudgetDelivery } = require('../src/job-agent.js');

  const delivered = [];
  const sessions = [];
  const executor = makeStubExecutor({ exhausted: false });

  await handleBudgetDelivery(executor, {
    deliver: async (out) => delivered.push(out),
    endSession: async (reason) => sessions.push(reason),
  });

  assert.equal(delivered.length, 0, 'deliver must not be called when budget is not exhausted');
  assert.equal(sessions.length, 0, 'endSession must not be called when budget is not exhausted');
});

test('handleBudgetDelivery: calls deliver once with accumulated content (not canned line)', async () => {
  process.env.NODE_ENV = 'test';
  const { handleBudgetDelivery } = require('../src/job-agent.js');

  const delivered = [];
  const sessions = [];
  const executor = makeStubExecutor({ exhausted: true });

  await handleBudgetDelivery(executor, {
    deliver: async (out) => delivered.push(out),
    endSession: async (reason) => sessions.push(reason),
  });

  assert.equal(delivered.length, 1, 'deliver must be called exactly once');
  assert.equal(sessions.length, 1, 'endSession must be called exactly once');
  assert.equal(sessions[0], 'budget-exhausted');

  // Content must be the REAL accumulated work from finalize(), not the canned budget line
  const canned = executor.budgetExhaustedMessage();
  assert.ok(
    delivered[0].content.includes('summary of the findings'),
    'delivered content must contain the real accumulated work'
  );
  assert.ok(
    !delivered[0].content.includes(canned),
    'delivered content must NOT be the canned budget message'
  );
  assert.equal(delivered[0].hash, 'h');
});

test('handleBudgetDelivery: second call is a no-op (deliver-once invariant)', async () => {
  process.env.NODE_ENV = 'test';
  const { handleBudgetDelivery } = require('../src/job-agent.js');

  const delivered = [];
  const sessions = [];
  const executor = makeStubExecutor({ exhausted: true });
  const deps = {
    deliver: async (out) => delivered.push(out),
    endSession: async (reason) => sessions.push(reason),
  };

  // First call — should deliver
  await handleBudgetDelivery(executor, deps);
  assert.equal(delivered.length, 1);
  assert.equal(sessions.length, 1);

  // Second call — budget still exhausted, but _budgetDelivered is now true
  await handleBudgetDelivery(executor, deps);
  assert.equal(delivered.length, 1, 'deliver must NOT be called a second time');
  assert.equal(sessions.length, 1, 'endSession must NOT be called a second time');
});

// ─── 3. Gate 1: exhaustion does not push canned line to conversationLog ──────

test('gate 1: budget exhaustion returns status string without pushing to conversationLog', async () => {
  // Set env before requiring local-llm.js so LLM_CONFIG.apiKey is truthy.
  // This causes handleMessage to enter the apiKey branch and exercise gate 1.
  process.env.J41_LLM_API_KEY = 'test-fake-key-budget-gate';
  // Disable buyer-chat scanning so the test doesn't need the SDK scanner
  process.env.J41_SCAN_BUYER_CHAT = '0';

  // Clear local-llm from the cache so it picks up our env override
  const cacheKey = require.resolve('../src/executors/local-llm.js');
  const savedModule = require.cache[cacheKey];
  delete require.cache[cacheKey];

  let LocalLLMExecutor;
  try {
    ({ LocalLLMExecutor } = require('../src/executors/local-llm.js'));
  } finally {
    // Restore cache state and env so nothing leaks into other tests
    delete require.cache[cacheKey];
    if (savedModule) require.cache[cacheKey] = savedModule;
    delete process.env.J41_LLM_API_KEY;
    delete process.env.J41_SCAN_BUYER_CHAT;
  }

  const ex = new LocalLLMExecutor();
  ex.setBudget(100);
  // Exhaust the budget directly (bypass _trackUsage to avoid warning callbacks)
  ex._tokenUsage = { totalTokens: 200, promptTokens: 100, completionTokens: 100, llmCalls: 1 };
  ex._exhaustedAt = Date.now();
  ex.job = { id: 'j1', description: 'test', buyer: 'buyer', amount: '1', currency: 'VRSC' };

  const response = await ex.handleMessage('hello', { jobId: 'j1', senderVerusId: 'buyer' });

  // Gate must return a non-empty status string
  assert.ok(typeof response === 'string' && response.length > 0,
    'handleMessage must return a status string when budget is exhausted');
  assert.ok(response.includes('token budget') || response.includes('budget'),
    'returned string should mention the token budget');

  // Critical: the canned response must NOT be in conversationLog — only the user message
  const assistantEntries = ex.conversationLog.filter(m => m.role === 'assistant');
  assert.equal(
    assistantEntries.length,
    0,
    'gate 1 must not push the canned budget line to conversationLog'
  );
});
