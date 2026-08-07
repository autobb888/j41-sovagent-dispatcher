/**
 * resumeJob — what the buyer actually receives after a dispute → rework.
 *
 * Round 6 (2026-08-06) reported that a reworked job re-delivered the head of the
 * ORIGINAL transcript, and that the concrete reworked content appeared in
 * neither the deliverable nor chat. Three independent defects stacked to produce
 * that, and each gets a test here:
 *
 *   1. The rework token grant was ABSOLUTE, not additive. `_tokenUsage` is
 *      cumulative for the executor's life and is never reset, so granting
 *      "30% of the job" as a ceiling is already exhausted by the original job's
 *      own spend — the rework LLM call never runs.
 *   2. `resumeJob` computed the reworked answer and returned `executor.finalize()`
 *      anyway, so the answer was discarded and a transcript delivered.
 *   3. The reworked answer was never posted to chat, so the rework was invisible
 *      to the buyer even when it worked.
 *
 * These run against the real `Executor` base class, not a stub, so the budget
 * arithmetic under test is the arithmetic that ships.
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Executor } = require('../src/executors/base');
const { resumeJob } = require('../src/job-agent');

const JOB = { id: 'f5c7c467-1d66-4c2d-b59d-9b0b44b6c775', amount: 0.005 };
const REWORK = 'Answer was too generic — give concrete hazards and entry/exit times.';
const ANSWER = 'Concrete hazards: sinkholes near the north bank. Packing list: rope, boots. Entry 07:00, exit 16:00.';

/** An executor that answers if and only if it has budget left to do so. */
function makeExecutor({ alreadyUsed, answer = ANSWER }) {
  const ex = new Executor();
  ex.job = JOB;
  ex._trackUsage({ prompt_tokens: alreadyUsed, completion_tokens: 0, total_tokens: alreadyUsed });
  ex.handleMessage = async () => {
    if (ex.isBudgetExhausted()) return ex.budgetExhaustedMessage
      ? ex.budgetExhaustedMessage()
      : `I've reached the token budget for this job (${ex.getTokenUsage().totalTokens} tokens used) — no further work is possible.`;
    ex._trackUsage({ prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 });
    return answer;
  };
  ex.finalize = async () => ({ content: 'user: original question\n\nassistant: original answer', hash: 'transcript-hash' });
  return ex;
}

/**
 * @param connected  whether the chat socket survived the dispute window
 * @param reauth     whether re-authentication succeeds when it did not
 */
function makeAgent({ connected = true, reauth = true } = {}) {
  const sent = [];
  const calls = [];
  const agent = {
    sent,
    calls,
    // Mirrors the real SDK: a live socket that was auto-joined to this room while
    // the job was in_progress. `joinedRooms` is a Set on ChatClient.
    chatClient: { isConnected: connected, joinedRooms: new Set(connected ? [JOB.id] : []) },
    authenticate: async () => {
      calls.push('authenticate');
      if (!reauth) throw new Error('Authentication required');
      return true;
    },
    connectChat: async () => { calls.push('connectChat'); agent.chatClient.isConnected = true; },
    joinJobChat: (id) => { calls.push(`joinJobChat:${id}`); agent.chatClient.joinedRooms.add(id); },
    sendChatMessage: async (_id, text) => {
      if (!agent.chatClient.isConnected) throw new Error('Chat not connected');
      sent.push(text);
    },
  };
  return agent;
}

test('rework budget is additive — a job that spent its original budget can still be reworked', async () => {
  // 3,400 of an original 3,599-token budget already spent; rework share is 1,080.
  // As an ABSOLUTE ceiling, 3,400 >= 1,080 is exhausted before the first token.
  const ex = makeExecutor({ alreadyUsed: 3400 });
  const agent = makeAgent();

  const result = await resumeJob(JOB, agent, 'soul', ex, () => {}, REWORK, 1080);

  assert.equal(result.content, ANSWER, 'the reworked answer must be the deliverable');
  assert.notEqual(result.hash, 'transcript-hash', 'must not fall back to the transcript');
  // The grant must be usage-offset, not the bare share.
  assert.equal(ex._budgetTokens, 3400 + 1080);
});

test('the reworked answer is delivered, not the conversation transcript', async () => {
  const ex = makeExecutor({ alreadyUsed: 0 });
  const agent = makeAgent();

  const result = await resumeJob(JOB, agent, 'soul', ex, () => {}, REWORK, 1080);

  assert.equal(result.content, ANSWER);
  assert.ok(!result.content.startsWith('user:'), 'a transcript dump must never be the rework deliverable');
  const crypto = require('crypto');
  assert.equal(result.hash, crypto.createHash('sha256').update(ANSWER).digest('hex'),
    'the signed hash must commit to the delivered content');
});

test('the reworked answer is posted to chat so the buyer knows rework happened', async () => {
  const ex = makeExecutor({ alreadyUsed: 0 });
  const agent = makeAgent();

  await resumeJob(JOB, agent, 'soul', ex, () => {}, REWORK, 1080);

  assert.equal(agent.sent.length, 1);
  assert.ok(agent.sent[0].includes('Concrete hazards'), 'the buyer must receive the rework in chat');
});

test('a genuinely budget-gated rework falls back to the transcript rather than delivering nothing', async () => {
  // No grant at all (tokenBudget null) and an already-exhausted executor: the
  // guard must catch the budget-gate reply, not ship it as the deliverable.
  const ex = makeExecutor({ alreadyUsed: 5000 });
  ex.setBudget(1000);
  const agent = makeAgent();

  const result = await resumeJob(JOB, agent, 'soul', ex, () => {}, REWORK, null);

  assert.equal(result.hash, 'transcript-hash', 'must fall back');
  assert.ok(!/token budget/i.test(result.content), 'the budget-gate line must never be the deliverable');
  assert.equal(agent.sent.length, 0, 'nothing to tell the buyer when no rework was produced');
});

test('an empty rework reply falls back rather than delivering an empty artifact', async () => {
  const ex = makeExecutor({ alreadyUsed: 0, answer: '   ' });
  const agent = makeAgent();

  const result = await resumeJob(JOB, agent, 'soul', ex, () => {}, REWORK, 1080);

  assert.equal(result.hash, 'transcript-hash');
  assert.equal(agent.sent.length, 0);
});

test('a chat failure does not lose the rework — the deliverable still carries it', async () => {
  const ex = makeExecutor({ alreadyUsed: 0 });
  const agent = makeAgent();
  agent.sendChatMessage = async () => { throw new Error('platform 503'); };

  const result = await resumeJob(JOB, agent, 'soul', ex, () => {}, REWORK, 1080);

  assert.equal(result.content, ANSWER, 'a chat outage must not discard the reworked answer');
});

// ── D3: the chat socket does not survive the dispute window ──────────────────
//
// Round-6 re-test on 2.13.0: the answer reached the deliverable but chat stayed
// silent. The container logged `[CHAT] Disconnected: transport close` then
// `Connection error: Authentication required` — the session expired during the
// (multi-day) dispute deadline, so `sendChatMessage` threw `Chat not connected`.
// Because the deliverable is capped at 200 chars, chat is the ONLY channel that
// can carry a full answer, so a dead socket makes the rework unreadable.

test('a chat socket that died during the dispute window is re-authenticated and re-joined', async () => {
  const ex = makeExecutor({ alreadyUsed: 0 });
  const agent = makeAgent({ connected: false });

  const result = await resumeJob(JOB, agent, 'soul', ex, () => {}, REWORK, 1080);

  assert.equal(agent.sent.length, 1, 'the buyer must still receive the rework in chat');
  assert.ok(agent.sent[0].includes('Concrete hazards'));
  assert.deepEqual(agent.calls, ['authenticate', 'connectChat', `joinJobChat:${JOB.id}`],
    'must re-auth, reconnect, THEN join — a fresh socket is not in the room');
  assert.equal(result.content, ANSWER);
});

test('a live chat socket is not re-joined — re-joining a room duplicates every message', async () => {
  const ex = makeExecutor({ alreadyUsed: 0 });
  const agent = makeAgent({ connected: true });

  await resumeJob(JOB, agent, 'soul', ex, () => {}, REWORK, 1080);

  assert.deepEqual(agent.calls, [], 'no reconnect and no re-join when the socket is already live');
  assert.equal(agent.sent.length, 1, 'exactly one copy of the rework');
});

test('a rework job must be joined explicitly — connectChat only auto-joins accepted/in_progress', async () => {
  // Regression pin: dropping joinJobChat leaves a connected socket that is not in
  // the room, so the send silently reaches nobody.
  const ex = makeExecutor({ alreadyUsed: 0 });
  const agent = makeAgent({ connected: false });

  await resumeJob(JOB, agent, 'soul', ex, () => {}, REWORK, 1080);

  assert.ok(agent.calls.includes(`joinJobChat:${JOB.id}`));
});

test('a failed re-auth degrades to the deliverable rather than losing the rework', async () => {
  const ex = makeExecutor({ alreadyUsed: 0 });
  const agent = makeAgent({ connected: false, reauth: false });

  const result = await resumeJob(JOB, agent, 'soul', ex, () => {}, REWORK, 1080);

  assert.equal(result.content, ANSWER, 'the reworked answer must survive a dead chat');
  assert.equal(agent.sent.length, 0);
});

test('rework DOES request a budget extension — the platform allows them during rework since 2026-08-07', async () => {
  // Was the opposite assertion until backend fixed it: both the create and approve
  // endpoints allowlisted only in_progress/paused, so a rework extension could never
  // be granted. The previous version of this test mocked `agent.requestExtension`,
  // which nothing in the code calls — it could not fail. This asserts on
  // `_lastExtensionAttemptAt`, which requestBudgetExtension sets before any pricing
  // lookup, so it proves the attempt happened without depending on a configured rate.
  const ex = makeExecutor({ alreadyUsed: 0 });
  const agent = makeAgent();
  ex.handleMessage = async () => {
    ex._trackUsage({ prompt_tokens: 1000, completion_tokens: 60, total_tokens: 1060 }); // >80% of 1080
    return ANSWER;
  };

  await resumeJob(JOB, agent, 'soul', ex, () => {}, REWORK, 1080);

  assert.ok(ex._lastExtensionAttemptAt, 'crossing the rework warning threshold must attempt an extension');
});

test('staying under the warning threshold asks for nothing', async () => {
  const ex = makeExecutor({ alreadyUsed: 0 });
  const agent = makeAgent();
  ex.handleMessage = async () => {
    ex._trackUsage({ prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 });
    return ANSWER;
  };

  await resumeJob(JOB, agent, 'soul', ex, () => {}, REWORK, 1080);

  assert.equal(ex._lastExtensionAttemptAt, undefined, 'no extension ask below the threshold');
});
