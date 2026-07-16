'use strict';
const test = require('node:test');
const assert = require('node:assert');

// Load nextPollSince from job-agent.js via the NODE_ENV=test seam.
process.env.NODE_ENV = 'test';
const { nextPollSince } = require('../src/job-agent.js');

const { selectBuyerMessages } = require('../src/message-poll.js');
const { markIfNew } = require('../src/message-dedup.js');

const BUYER = 'iC6bdkugcFbRuPXFsFcK3utr7custBw52i';
const OVERLAP_MS = 60000;

// Helper: parse backend space-format or nextPollSince-output timestamps to epoch ms.
// Handles:
//   "YYYY-MM-DD HH:MM:SS.ffffff+00"  → expand "+00" to "+00:00" (UTC)
//   "YYYY-MM-DD HH:MM:SS.fff"         → no tz suffix; nextPollSince output is UTC, add 'Z'
//   "YYYY-MM-DDTHH:MM:SS.fffZ"        → already ISO, use as-is
function parseTs(ts) {
  const s = String(ts).replace(' ', 'T');
  // Expand bare "+00" / "+05" at end to "+HH:00" for Date.parse compatibility.
  const normalised = s.replace(/([+-]\d{2})$/, '$1:00');
  // If no timezone indicator at all, treat as UTC (nextPollSince output is always UTC).
  const withTz = /[Z+\-]\d{2}:\d{2}$|Z$/.test(normalised) ? normalised : normalised + 'Z';
  return Date.parse(withTz);
}

// ── nextPollSince ────────────────────────────────────────────────────────────

test('nextPollSince: space-format high-water returns since OVERLAP_MS earlier, still space-format', () => {
  // A backend-style timestamp: "YYYY-MM-DD HH:MM:SS.ffffff+00"
  const highWater = '2026-07-16 12:00:00.000000+00';
  const since = nextPollSince(highWater, OVERLAP_MS);

  // Must be exactly OVERLAP_MS earlier
  const hwMs = parseTs(highWater);
  const sinceMs = parseTs(since);
  assert.ok(!isNaN(hwMs), `hwMs should be valid: ${hwMs}`);
  assert.ok(!isNaN(sinceMs), `sinceMs should be valid: ${sinceMs}`);
  assert.strictEqual(sinceMs, hwMs - OVERLAP_MS);

  // Must be space-separated (no 'T'), no trailing 'Z'
  assert.ok(!since.includes('T'), `should not contain 'T': ${since}`);
  assert.ok(!since.endsWith('Z'), `should not end with 'Z': ${since}`);
});

test('nextPollSince: falsy input returned unchanged', () => {
  assert.strictEqual(nextPollSince('', OVERLAP_MS), '');
  assert.strictEqual(nextPollSince(null, OVERLAP_MS), null);
  assert.strictEqual(nextPollSince(undefined, OVERLAP_MS), undefined);
});

test('nextPollSince: unparseable input returned unchanged', () => {
  const bad = 'not-a-date';
  assert.strictEqual(nextPollSince(bad, OVERLAP_MS), bad);
});

// ── selectBuyerMessages: score-agnostic ─────────────────────────────────────

test('selectBuyerMessages includes buyer message with safetyScore:0.4', () => {
  const msgs = [
    { id: 'm1', senderVerusId: BUYER, content: 'flagged msg', createdAt: '2026-07-16 11:00:00.000000+00', safetyScore: 0.4 },
    { id: 'a1', senderVerusId: 'iAgentX', content: 'agent reply', createdAt: '2026-07-16 11:00:01.000000+00' },
  ];
  const result = selectBuyerMessages(msgs, BUYER);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 'm1');
  assert.strictEqual(result[0].safetyScore, 0.4);
});

// ── Overlap re-inclusion + dedup ─────────────────────────────────────────────

test('overlap window re-includes a message just below high-water; markIfNew makes second observation a no-op', () => {
  // High-water from a previous poll tick that just missed this message.
  // The message arrived 30s before the high-water (within OVERLAP_MS=60s).
  const highWater = '2026-07-16 12:01:00.000000+00';
  const msgCreatedAt = '2026-07-16 12:00:30.000000+00'; // 30s before high-water

  // nextPollSince should produce a `since` <= msgCreatedAt
  const since = nextPollSince(highWater, OVERLAP_MS);
  const sinceMs = parseTs(since);
  const msgMs = parseTs(msgCreatedAt);
  assert.ok(!isNaN(sinceMs), `sinceMs should be valid: ${since}`);
  assert.ok(!isNaN(msgMs), `msgMs should be valid: ${msgCreatedAt}`);
  assert.ok(sinceMs <= msgMs, `since (${since}) should be <= message createdAt (${msgCreatedAt})`);

  // Simulate the dedup: first observation → new; second → dup (no-op)
  const processedIds = new Set();

  const msg = { id: 'msg-overlap-1', senderVerusId: BUYER, createdAt: msgCreatedAt, safetyScore: 0.4 };

  // First poll observation — markIfNew returns true → new
  const firstResult = markIfNew(processedIds, msg.id);
  assert.strictEqual(firstResult, true, 'first observation should be new');

  // Second poll observation (overlap re-fetch) — markIfNew returns false → dup no-op
  const secondResult = markIfNew(processedIds, msg.id);
  assert.strictEqual(secondResult, false, 'second observation should be a dup no-op');

  // The set has exactly one entry
  assert.strictEqual(processedIds.size, 1);
});

// Minor A (Task 3 review): suffix-less timestamps must be treated as UTC, not
// local time, so the poll cursor is machine-TZ-independent.
test('nextPollSince treats a suffix-less (no +00) timestamp as UTC', () => {
  const { nextPollSince } = require('../src/job-agent.js');
  // 18:00:00 UTC minus 60s = 17:59:00 UTC, regardless of the host TZ.
  const out = nextPollSince('2026-07-16 18:00:00.000', 60000);
  assert.equal(out, '2026-07-16 17:59:00.000');
});
