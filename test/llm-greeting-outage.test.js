'use strict';
/**
 * The greeting and the hire answer must not keep the abort sentence.
 * undici is what the worker calls. Stub that, not global fetch.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.J41_LLM_API_KEY = 'test-key-greeting';
process.env.J41_LLM_BASE_URL = 'http://127.0.0.1:9';
process.env.J41_LLM_MODEL = 'test-model';
process.env.J41_LLM_PROVIDER = '';

const undici = require('undici');
const origFetch = undici.fetch;

function abortFetch() {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return Promise.reject(err);
}

const { LocalLLMExecutor } = require('../src/executors/local-llm.js');

const JOB = {
  id: '1bd31b39-b2a0-4da6-8bb1-ca16f4569961',
  description: 'Reply with the single word pong.',
  buyer: 'iBuyer',
  amount: 0.05,
  currency: 'VRSCTEST',
};

test('an aborted greeting is the template, and the hire answer is not stored', async () => {
  let fetches = 0;
  undici.fetch = () => {
    fetches += 1;
    return abortFetch();
  };
  const sent = [];
  const agent = {
    sendChatMessage: async (_id, text) => { sent.push(text); },
    iAddress: 'iSeller',
    identityName: 'labour-1',
  };
  try {
    const ex = new LocalLLMExecutor();
    await ex.init(JOB, agent, 'soul');
    assert.ok(fetches >= 3, 'the greeting call must reach the provider');
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Hello! I'm your Verus agent/);
    assert.equal(sent.some((line) => /temporary issue/i.test(line)), false);
    assert.equal(ex.conversationLog.length, 1);
    assert.equal(ex.conversationLog[0].greeting, true);
    assert.equal(/temporary issue/i.test(ex.conversationLog[0].content), false);

    const before = fetches;
    const reply = await ex.handleMessage(JOB.description, {});
    assert.match(reply, /temporary issue/);
    assert.ok(fetches > before);
    assert.equal(ex.conversationLog.length, 1, 'the outage turn and its question are not kept');
    assert.equal(ex.conversationLog.some((row) => row.role === 'user'), false);
  } finally {
    undici.fetch = origFetch;
  }
});
