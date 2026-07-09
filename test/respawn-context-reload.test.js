'use strict';
/**
 * Task 8 — Stateless-respawn context reload
 *
 * Verifies that a cold-respawned worker (LocalLLMExecutor with isReconnect=true)
 * seeds conversationLog from platform message history instead of starting empty.
 */
const test = require('node:test');
const assert = require('node:assert');

// Require the executor; suppress the LLM-config console log from module load.
const { LocalLLMExecutor } = require('../src/executors/local-llm.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

const AGENT_IADDRESS = 'iAgentXXXXXXXXXXXXXXXXXXXXXXXXXX';
const AGENT_NAME = 'myagent@';
const BUYER_ID = 'iBuyerYYYYYYYYYYYYYYYYYYYYYYYYYY';

function makeAgent(messages = []) {
  return {
    iAddress: AGENT_IADDRESS,
    identityName: AGENT_NAME,
    client: {
      async getChatMessages(jobId, params) {
        return { data: messages, meta: { total: messages.length, limit: 100, offset: 0 } };
      },
    },
    sendChatMessage() {},
  };
}

function makeJob(id = 'job-1') {
  return { id, description: 'test job', buyer: 'buyer@', amount: 1, currency: 'VRSC' };
}

// ── seedConversationLog unit tests ────────────────────────────────────────────

test('seedConversationLog: maps buyer messages to role=user', () => {
  const ex = new LocalLLMExecutor();
  const msgs = [
    { senderVerusId: BUYER_ID, content: 'Hello agent', type: 'text' },
  ];
  const count = ex.seedConversationLog(msgs, AGENT_IADDRESS, AGENT_NAME);
  assert.strictEqual(count, 1);
  assert.deepStrictEqual(ex.conversationLog, [{ role: 'user', content: 'Hello agent' }]);
});

test('seedConversationLog: maps agent messages to role=assistant by iAddress', () => {
  const ex = new LocalLLMExecutor();
  const msgs = [
    { senderVerusId: AGENT_IADDRESS, content: 'I can help!', type: 'text' },
  ];
  ex.seedConversationLog(msgs, AGENT_IADDRESS, AGENT_NAME);
  assert.deepStrictEqual(ex.conversationLog, [{ role: 'assistant', content: 'I can help!' }]);
});

test('seedConversationLog: maps agent messages to role=assistant by identityName', () => {
  const ex = new LocalLLMExecutor();
  const msgs = [
    { senderVerusId: AGENT_NAME, content: 'Sure, here you go.', type: 'text' },
  ];
  ex.seedConversationLog(msgs, AGENT_IADDRESS, AGENT_NAME);
  assert.deepStrictEqual(ex.conversationLog, [{ role: 'assistant', content: 'Sure, here you go.' }]);
});

test('seedConversationLog: skips system messages', () => {
  const ex = new LocalLLMExecutor();
  const msgs = [
    { senderVerusId: BUYER_ID, content: 'Job started', type: 'system' },
    { senderVerusId: BUYER_ID, content: 'Hi there', type: 'text' },
  ];
  const count = ex.seedConversationLog(msgs, AGENT_IADDRESS, AGENT_NAME);
  assert.strictEqual(count, 1);
  assert.strictEqual(ex.conversationLog.length, 1);
  assert.strictEqual(ex.conversationLog[0].content, 'Hi there');
});

test('seedConversationLog: preserves message order (oldest first)', () => {
  const ex = new LocalLLMExecutor();
  const msgs = [
    { senderVerusId: BUYER_ID, content: 'First', type: 'text' },
    { senderVerusId: AGENT_IADDRESS, content: 'Second', type: 'text' },
    { senderVerusId: BUYER_ID, content: 'Third', type: 'text' },
  ];
  ex.seedConversationLog(msgs, AGENT_IADDRESS, AGENT_NAME);
  assert.deepStrictEqual(ex.conversationLog.map(m => m.content), ['First', 'Second', 'Third']);
  assert.deepStrictEqual(ex.conversationLog.map(m => m.role), ['user', 'assistant', 'user']);
});

test('seedConversationLog: sorts unordered (out-of-order createdAt) oldest-first', () => {
  const ex = new LocalLLMExecutor();
  const msgs = [
    { senderVerusId: BUYER_ID, content: 'Third', type: 'text', createdAt: '2026-07-09T10:03:00Z' },
    { senderVerusId: BUYER_ID, content: 'First', type: 'text', createdAt: '2026-07-09T10:01:00Z' },
    { senderVerusId: AGENT_IADDRESS, content: 'Second', type: 'text', createdAt: '2026-07-09T10:02:00Z' },
  ];
  ex.seedConversationLog(msgs, AGENT_IADDRESS, AGENT_NAME);
  assert.deepStrictEqual(ex.conversationLog.map(m => m.content), ['First', 'Second', 'Third']);
  assert.deepStrictEqual(ex.conversationLog.map(m => m.role), ['user', 'assistant', 'user']);
});

test('seedConversationLog: skips file-type messages', () => {
  const ex = new LocalLLMExecutor();
  const msgs = [
    { senderVerusId: BUYER_ID, content: 'https://opaque/file/id', type: 'file', createdAt: '2026-07-09T10:00:00Z' },
    { senderVerusId: BUYER_ID, content: 'Please review', type: 'text', createdAt: '2026-07-09T10:01:00Z' },
  ];
  const count = ex.seedConversationLog(msgs, AGENT_IADDRESS, AGENT_NAME);
  assert.strictEqual(count, 1);
  assert.strictEqual(ex.conversationLog.length, 1);
  assert.strictEqual(ex.conversationLog[0].content, 'Please review');
});

test('seedConversationLog: empty message list → empty conversationLog', () => {
  const ex = new LocalLLMExecutor();
  const count = ex.seedConversationLog([], AGENT_IADDRESS, AGENT_NAME);
  assert.strictEqual(count, 0);
  assert.strictEqual(ex.conversationLog.length, 0);
});

// ── Cold-respawn integration: init() with isReconnect=true ───────────────────

test('init with isReconnect=true seeds conversationLog from platform history', async () => {
  const ex = new LocalLLMExecutor();
  const platformMessages = [
    { senderVerusId: BUYER_ID, content: 'Can you help?', type: 'text' },
    { senderVerusId: AGENT_IADDRESS, content: 'Of course!', type: 'text' },
    { senderVerusId: BUYER_ID, content: 'Great, let us continue.', type: 'text' },
  ];
  const agent = makeAgent(platformMessages);
  const job = makeJob();

  await ex.init(job, agent, 'You are a helpful agent.', { isReconnect: true });

  assert.strictEqual(ex.conversationLog.length, 3, 'all 3 prior messages seeded');
  assert.strictEqual(ex.conversationLog[0].role, 'user');
  assert.strictEqual(ex.conversationLog[1].role, 'assistant');
  assert.strictEqual(ex.conversationLog[2].role, 'user');
  assert.strictEqual(ex.conversationLog[0].content, 'Can you help?');
  assert.strictEqual(ex.conversationLog[1].content, 'Of course!');
});

test('init with isReconnect=true does NOT send greeting', async () => {
  const ex = new LocalLLMExecutor();
  const sent = [];
  const agent = makeAgent([]);
  agent.sendChatMessage = (jobId, msg) => sent.push(msg);

  await ex.init(makeJob(), agent, 'You are helpful.', { isReconnect: true });

  assert.strictEqual(sent.length, 0, 'no greeting sent on respawn');
});

test('init with isReconnect=false still sends greeting (fresh job)', async () => {
  // Guard against regression: first-connect path must still greet.
  const ex = new LocalLLMExecutor();
  const sent = [];
  const agent = makeAgent([]);
  agent.sendChatMessage = (jobId, msg) => { sent.push(msg); };

  // No LLM API key set → template greeting path
  await ex.init(makeJob(), agent, 'You are helpful.', { isReconnect: false });

  assert.ok(sent.length >= 1, 'greeting sent on first connect');
});

test('init with isReconnect=true is non-fatal when getChatMessages throws', async () => {
  const ex = new LocalLLMExecutor();
  const agent = {
    iAddress: AGENT_IADDRESS,
    identityName: AGENT_NAME,
    client: {
      async getChatMessages() { throw new Error('network error'); },
    },
    sendChatMessage() {},
  };

  // Should not throw — fail-open with empty context
  await assert.doesNotReject(() => ex.init(makeJob(), agent, 'soul', { isReconnect: true }));
  assert.strictEqual(ex.conversationLog.length, 0, 'empty context on fetch failure');
});
