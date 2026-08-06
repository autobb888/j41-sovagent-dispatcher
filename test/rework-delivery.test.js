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

function makeAgent() {
  const sent = [];
  return { sent, sendChatMessage: async (_id, text) => { sent.push(text); } };
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
  const agent = { sent: [], sendChatMessage: async () => { throw new Error('platform 503'); } };

  const result = await resumeJob(JOB, agent, 'soul', ex, () => {}, REWORK, 1080);

  assert.equal(result.content, ANSWER, 'a chat outage must not discard the reworked answer');
});
