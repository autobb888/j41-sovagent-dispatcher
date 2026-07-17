/**
 * WP-D4 budget semantics on the Executor base class: exhaustion is
 * enforced state (not advisory), warnings are edge-triggered, and every
 * granted extension re-arms the edge so a second overrun asks again.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { Executor } = require('../src/executors/base');

function usage(total, prompt = null, completion = null) {
  const p = prompt ?? Math.floor(total / 2);
  const c = completion ?? (total - p);
  return { prompt_tokens: p, completion_tokens: c, total_tokens: total };
}

test('no budget set means not exhausted (legacy executors unaffected)', () => {
  const ex = new Executor();
  ex._trackUsage(usage(1000000));
  assert.equal(ex.isBudgetExhausted(), false);
  assert.equal(ex.budgetExhaustedSince(), null);
});

test('warning fires once at the threshold and carries usage + budget', () => {
  const ex = new Executor();
  const fired = [];
  ex.setBudget(1000, 80, (u, b) => fired.push({ total: u.totalTokens, budget: b }));
  ex._trackUsage(usage(700));
  assert.equal(fired.length, 0);
  ex._trackUsage(usage(150)); // 850 ≥ 80%
  assert.equal(fired.length, 1);
  assert.deepEqual(fired[0], { total: 850, budget: 1000 });
  ex._trackUsage(usage(100)); // still armed-off — no second fire
  assert.equal(fired.length, 1);
});

test('crossing the budget stamps exhaustion; within budget it stays null', () => {
  const ex = new Executor();
  ex.setBudget(1000, 80, null);
  ex._trackUsage(usage(999));
  assert.equal(ex.isBudgetExhausted(), false);
  assert.equal(ex.budgetExhaustedSince(), null);
  ex._trackUsage(usage(1));
  assert.equal(ex.isBudgetExhausted(), true);
  assert.ok(typeof ex.budgetExhaustedSince() === 'number');
});

test('increaseBudget re-arms warning, extension flag, and exhaustion (fix #5)', () => {
  const ex = new Executor();
  const fired = [];
  ex.setBudget(1000, 80, () => fired.push(true));
  ex._trackUsage(usage(1000));
  assert.equal(fired.length, 1);
  assert.equal(ex.isBudgetExhausted(), true);
  ex._extensionRequested = true; // an ask went out

  ex.increaseBudget(1000); // buyer approved
  assert.equal(ex.isBudgetExhausted(), false);
  assert.equal(ex.budgetExhaustedSince(), null);
  assert.equal(ex._extensionRequested, false);

  // Second overrun asks again — the one-shot bug is gone
  ex._trackUsage(usage(700)); // 1700 of 2000 = 85%
  assert.equal(fired.length, 2);
  ex._trackUsage(usage(300)); // 2000 — exhausted again
  assert.equal(ex.isBudgetExhausted(), true);
  assert.ok(ex.budgetExhaustedSince());
});

test('increaseBudget ignores garbage (fail closed: no free budget from bad input)', () => {
  const ex = new Executor();
  ex.setBudget(1000, 80, null);
  ex._trackUsage(usage(1000));
  for (const bad of [0, -500, NaN, Infinity, undefined, null]) {
    ex.increaseBudget(bad);
    assert.equal(ex.isBudgetExhausted(), true, `still exhausted after increaseBudget(${bad})`);
  }
});

test('an under-sized grant leaves the budget exhausted and the exhaustion stamp intact', () => {
  const ex = new Executor();
  ex.setBudget(1000, 80, null);
  ex._trackUsage(usage(1500)); // 500 over
  const stamp = ex.budgetExhaustedSince();
  ex.increaseBudget(100); // not enough to clear
  assert.equal(ex.isBudgetExhausted(), true);
  assert.equal(ex.budgetExhaustedSince(), stamp);
});

test('setBudget resets all edge state', () => {
  const ex = new Executor();
  ex.setBudget(100, 80, null);
  ex._trackUsage(usage(200));
  ex._extensionRequested = true;
  ex.setBudget(10000, 80, null);
  assert.equal(ex.isBudgetExhausted(), false);
  assert.equal(ex.budgetExhaustedSince(), null);
  assert.equal(ex._extensionRequested, false);
});

test('budgetExhaustedMessage is honest: states usage + delivery, NOT a fictional extension request', () => {
  const ex = new Executor();
  ex.setBudget(100, 80, null);
  ex._trackUsage(usage(150));
  const msg = ex.budgetExhaustedMessage();
  assert.match(msg, /150 tokens/);
  assert.match(msg, /deliver/i, 'must say what actually happens (partial delivery)');
  // Must NOT claim a budget-extension request — no such request is made (no
  // approval path). Narrating a mechanism that does not exist is the bug.
  assert.doesNotMatch(msg, /extension/i, 'must not narrate a budget-extension request that never happens');
});
