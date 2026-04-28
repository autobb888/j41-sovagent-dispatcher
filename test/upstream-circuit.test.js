const test = require('node:test');
const assert = require('node:assert');

// Drive circuit state directly via test-only `_setHealth`/`_reset` helpers.
// Avoids spinning up real fetch calls and lets us isolate transition logic.
const uh = require('../src/upstream-health.js');

function reset() {
  if (uh._reset) uh._reset();
}

test('healthy upstream — circuit stays closed', () => {
  reset();
  uh._setHealth('agent-1', { healthy: true, status: 200 }, 3);
  const h = uh.getHealth('agent-1');
  assert.strictEqual(h.consecutive_failures, 0);
  assert.strictEqual(h.circuitOpenedAt, null);
});

test('threshold failures trip the breaker', () => {
  reset();
  uh._setHealth('agent-2', { healthy: false, status: 500 }, 3);
  uh._setHealth('agent-2', { healthy: false, status: 500 }, 3);
  let h = uh.getHealth('agent-2');
  assert.strictEqual(h.consecutive_failures, 2);
  assert.strictEqual(h.circuitOpenedAt, null, 'still closed at 2 failures');
  uh._setHealth('agent-2', { healthy: false, status: 500 }, 3);
  h = uh.getHealth('agent-2');
  assert.strictEqual(h.consecutive_failures, 3);
  assert.ok(h.circuitOpenedAt > 0, 'circuit opened on threshold cross');
});

test('successful probe after trip closes the circuit', () => {
  reset();
  // Trip
  for (let i = 0; i < 3; i++) uh._setHealth('agent-3', { healthy: false, status: 500 }, 3);
  assert.ok(uh.getHealth('agent-3').circuitOpenedAt > 0);
  // Recover
  uh._setHealth('agent-3', { healthy: true, status: 200 }, 3);
  const h = uh.getHealth('agent-3');
  assert.strictEqual(h.circuitOpenedAt, null);
  assert.strictEqual(h.consecutive_failures, 0);
});

test('circuitOpenedAt does not advance on subsequent failures while already open', () => {
  reset();
  for (let i = 0; i < 3; i++) uh._setHealth('agent-4', { healthy: false, status: 500 }, 3);
  const firstOpen = uh.getHealth('agent-4').circuitOpenedAt;
  // Wait briefly, then more failures
  const wait = Date.now() + 5;
  while (Date.now() < wait) {} // tiny sync wait
  uh._setHealth('agent-4', { healthy: false, status: 500 }, 3);
  uh._setHealth('agent-4', { healthy: false, status: 500 }, 3);
  const h = uh.getHealth('agent-4');
  assert.strictEqual(h.circuitOpenedAt, firstOpen, 'circuitOpenedAt is sticky once tripped');
  assert.strictEqual(h.consecutive_failures, 5);
});
