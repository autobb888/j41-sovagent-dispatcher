'use strict';
/**
 * Per-(agent,buyer) in-flight concurrency cap for the proxy hot path (audit H3).
 *
 * The worst-case credit reservation (reserve the max the request could consume)
 * only protects a SINGLE request: N concurrent requests each pass the balance
 * check against the *current* balance, so without a concurrency bound a buyer
 * could fan out many requests that collectively over-commit a thin balance and
 * settle deeply negative (the seller eats the overage). This module caps how
 * many requests a buyer may have in flight against a given seller at once.
 *
 * Keyed by `agentId\0buyerVerusId` so a buyer's concurrency to one seller can't
 * influence another seller. In-memory only — reset on process restart is
 * acceptable (same trade-off as the token-bucket rate limiter): on restart there
 * are no in-flight requests anyway.
 */

const _counts = new Map(); // key → integer count of in-flight requests

function _key(agentId, buyerVerusId) {
  // Length-prefix the agentId so ('a','bc') and ('ab','c') can't collide.
  return `${String(agentId).length}:${agentId}\0${buyerVerusId}`;
}

/**
 * Try to reserve an in-flight slot for (agentId, buyerVerusId).
 * @param {string} agentId
 * @param {string} buyerVerusId
 * @param {number} cap - Max concurrent in-flight requests for this buyer.
 * @returns {boolean} true if a slot was granted (caller MUST release in finally);
 *                    false if the cap is already reached (caller returns 429).
 */
function acquire(agentId, buyerVerusId, cap) {
  const limit = Number.isFinite(cap) && cap >= 1 ? Math.floor(cap) : 1;
  const k = _key(agentId, buyerVerusId);
  const cur = _counts.get(k) || 0;
  if (cur >= limit) return false;
  _counts.set(k, cur + 1);
  return true;
}

/**
 * Release a previously-acquired in-flight slot. Idempotent-safe: never drives
 * the counter below zero, and drops the key entirely at zero to avoid leaks.
 * Call exactly once per successful acquire(), in a finally block.
 */
function release(agentId, buyerVerusId) {
  const k = _key(agentId, buyerVerusId);
  const cur = _counts.get(k) || 0;
  const next = cur - 1;
  if (next <= 0) _counts.delete(k);
  else _counts.set(k, next);
}

function _reset() { _counts.clear(); }
function _count(agentId, buyerVerusId) { return _counts.get(_key(agentId, buyerVerusId)) || 0; }

module.exports = { acquire, release, _reset, _count };
