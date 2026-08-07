'use strict';

/**
 * Canonical bounty-award signing message.
 *
 * The platform verifies `/select` signatures against this exact string as of its
 * 2026-08-07 deploy. It currently runs in shadow mode (`BOUNTY_AWARD_SIG_MODE=log`) —
 * mismatches are logged, not rejected — and flips to `enforce` once clients sign it.
 *
 * What changed, and why each part matters:
 *
 *   - The SDK's `buildSelectClaimantsMessage` produced
 *     `J41-BOUNTY-SELECT|Bounty:<id>|Selected:<application row ids>|Ts:<ts>`.
 *     Different prefix, different field name, and — the substantive difference —
 *     it bound the **application row IDs**, which are opaque server primary keys a
 *     signer cannot independently verify. Signing them commits to nothing a human
 *     or a third party can check.
 *   - The canonical form binds the **applicant VerusIDs** (i-addresses): the actual
 *     recipients of the money. Previously the signature covered only a count, so it
 *     did not bind the award to anyone — the winner came from an unsigned body field.
 *   - IDs are **sorted** so the same award always produces the same bytes regardless
 *     of the order a UI happened to collect them in.
 *
 * Pure: no clock, no I/O. The caller supplies the timestamp so it can be reused for
 * both the signature and the request body.
 */

const BOUNTY_AWARD_PREFIX = 'J41-BOUNTY-AWARD';
const BOUNTY_AWARD_SUFFIX = 'I award this bounty to the listed applicants.';

/**
 * @param {string} bountyId
 * @param {string[]} applicantVerusIds  recipient i-addresses (NOT application row ids)
 * @param {number} timestamp            unix seconds
 * @returns {string}
 */
function buildBountyAwardMessage(bountyId, applicantVerusIds, timestamp) {
  if (typeof bountyId !== 'string' || !bountyId) {
    throw new Error('buildBountyAwardMessage: bountyId is required');
  }
  if (!Array.isArray(applicantVerusIds) || applicantVerusIds.length === 0) {
    throw new Error('buildBountyAwardMessage: at least one applicant VerusID is required');
  }
  for (const id of applicantVerusIds) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error('buildBountyAwardMessage: every applicant VerusID must be a non-empty string');
    }
    // An application row id would silently produce a signature the platform rejects
    // once enforcement is on. Fail loudly at signing time instead — a UUID here means
    // the caller passed `app.id` where `app.applicant_verus_id` was needed.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim())) {
      throw new Error(
        `buildBountyAwardMessage: "${id}" looks like an application row id, not a VerusID. ` +
        'The signature must bind the applicant i-addresses.',
      );
    }
  }
  if (!Number.isInteger(timestamp) || timestamp <= 0) {
    throw new Error('buildBountyAwardMessage: timestamp must be a positive integer (unix seconds)');
  }

  // Sort a copy — never mutate the caller's array, which is also used for the body.
  const sorted = [...applicantVerusIds].map(s => s.trim()).sort();
  return `${BOUNTY_AWARD_PREFIX}|Bounty:${bountyId}|Applicants:${sorted.join(',')}|Ts:${timestamp}|${BOUNTY_AWARD_SUFFIX}`;
}

module.exports = { buildBountyAwardMessage, BOUNTY_AWARD_PREFIX, BOUNTY_AWARD_SUFFIX };
