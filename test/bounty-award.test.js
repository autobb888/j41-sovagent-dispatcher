/**
 * Canonical bounty-award signing message.
 *
 * Round 8 found the platform stored the `/select` signature without verifying it, and
 * that the SDK's message bound only a count — so the signature did not bind the award
 * to any recipient; the winner came from an unsigned body field. The platform now
 * verifies a canonical message that binds the sorted applicant VerusIDs, currently in
 * shadow mode and flipping to enforce once clients sign it.
 *
 * The trap this guards: the UI had `app.id` (an application row id) to hand, and the
 * old SDK message signed exactly that. Signing row ids commits to nothing a signer can
 * independently verify, and would silently fail verification the day enforcement lands.
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildBountyAwardMessage } = require('../src/bounty-award.js');

const BOUNTY = '0d7a81de-63ca-4452-adb0-68595db7cd57';
const A = 'i5WpjyEsnU1W93JezQTkL7SqXGHbe2ZZGg'; // dt3worker2
const B = 'iDP6VUHKfd5NwLgFuvdNc8PmRkZT6ayGJN'; // dt3worker3
const TS = 1786117581;

test('matches the platform canonical form exactly', () => {
  assert.equal(
    buildBountyAwardMessage(BOUNTY, [A], TS),
    `J41-BOUNTY-AWARD|Bounty:${BOUNTY}|Applicants:${A}|Ts:${TS}|I award this bounty to the listed applicants.`,
  );
});

test('applicants are sorted, so collection order cannot change the bytes', () => {
  const one = buildBountyAwardMessage(BOUNTY, [A, B], TS);
  const other = buildBountyAwardMessage(BOUNTY, [B, A], TS);
  assert.equal(one, other);
  const sorted = [A, B].sort();
  assert.ok(one.includes(`Applicants:${sorted.join(',')}`));
});

test('the caller\'s array is not mutated — the same array is reused for the request body', () => {
  const ids = [B, A];
  buildBountyAwardMessage(BOUNTY, ids, TS);
  assert.deepEqual(ids, [B, A], 'sorting must not reorder the body');
});

test('an application row id is refused, not silently signed', () => {
  // The exact mistake the old SDK message made. Failing at signing time beats a
  // signature the platform rejects once enforcement is on.
  assert.throws(
    () => buildBountyAwardMessage(BOUNTY, ['c0488c86-0340-4900-83cb-f4b033735f13'], TS),
    /application row id/,
  );
});

test('whitespace is trimmed before signing so it cannot change the bytes', () => {
  assert.equal(buildBountyAwardMessage(BOUNTY, [` ${A} `], TS), buildBountyAwardMessage(BOUNTY, [A], TS));
});

test('empty or malformed input is refused rather than producing a meaningless signature', () => {
  assert.throws(() => buildBountyAwardMessage('', [A], TS), /bountyId/);
  assert.throws(() => buildBountyAwardMessage(BOUNTY, [], TS), /at least one applicant/);
  assert.throws(() => buildBountyAwardMessage(BOUNTY, [''], TS), /non-empty/);
  assert.throws(() => buildBountyAwardMessage(BOUNTY, [A], 0), /timestamp/);
  assert.throws(() => buildBountyAwardMessage(BOUNTY, [A], 1.5), /timestamp/);
});
