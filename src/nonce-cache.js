'use strict';
/**
 * In-memory nonce cache for replay protection on v2 access envelopes.
 *
 * Tracks recently-seen nonces and rejects any envelope whose nonce we've
 * already accepted. TTL = max envelope window (10 min default) + 1 min
 * grace, so even an envelope replayed at the very edge of its expiry
 * window is caught.
 *
 * Memory bound: Map size capped at MAX_ENTRIES (default 100k). When the
 * cap is hit, oldest entry by insertion order is evicted (Map iteration
 * preserves insertion order in V8). Periodic sweep reclaims expired
 * entries every SWEEP_INTERVAL_MS.
 *
 * Process-local — restarts clear the cache. Acceptable: an attacker can
 * only replay within the envelope's expiresAt, so a dispatcher restart
 * at minute 11 doesn't open a window the envelope already closed itself.
 */
const DEFAULT_TTL_MS = 11 * 60_000;        // envelope window + grace
const SWEEP_INTERVAL_MS = 60_000;
// Audit 2026-06-02 L-DISPATCHER-bridge-1: env-overridable. 100k entries × 11min
// TTL covers any realistic dispatcher load (≈150 nonces/sec sustained for 11
// min before LRU eviction starts dropping the oldest). Operators with higher
// throughput tune via env; tests use a much smaller cap to exercise eviction.
const MAX_ENTRIES = Number(process.env.J41_NONCE_CACHE_MAX_ENTRIES || 100_000);

let _seen = new Map();    // nonce → expiresAtMs
let _sweepTimer = null;

function _ensureSweep() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [nonce, exp] of _seen) {
      if (exp <= now) _seen.delete(nonce);
    }
  }, SWEEP_INTERVAL_MS);
  _sweepTimer.unref?.();
}

/**
 * Check + record a nonce.
 *   - { ok: true } if the nonce is fresh (recorded)
 *   - { ok: false, reason: 'replay' } if seen recently
 *   - { ok: false, reason: 'invalid-nonce' } for empty/non-string input
 */
function checkAndRecordNonce(nonce, expiresAtMs) {
  if (typeof nonce !== 'string' || nonce.length === 0) {
    return { ok: false, reason: 'invalid-nonce' };
  }
  _ensureSweep();
  const now = Date.now();
  const existing = _seen.get(nonce);
  if (existing && existing > now) {
    return { ok: false, reason: 'replay' };
  }
  // LRU evict if at cap (Map iteration is insertion-order)
  if (_seen.size >= MAX_ENTRIES) {
    const oldest = _seen.keys().next().value;
    if (oldest !== undefined) _seen.delete(oldest);
  }
  // Bug fix per review: explicit branch — Math.max(now, X) is never falsy,
  // so the previous `|| (now + DEFAULT_TTL_MS)` fallback never fired for
  // already-expired envelopes. This correctly falls back when expiresAtMs
  // is missing OR already in the past.
  const ttl = (Number.isFinite(expiresAtMs) && expiresAtMs > now)
    ? expiresAtMs
    : (now + DEFAULT_TTL_MS);
  _seen.set(nonce, ttl);
  return { ok: true };
}

function _reset() {
  _seen = new Map();
  if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null; }
}
function _size() { return _seen.size; }

/**
 * Verify-gated nonce check for v2 access-request envelopes.
 *
 * The nonce cache must NEVER be populated before the caller's signature has
 * been verified — recording first lets an unauthenticated caller burn/churn
 * the (bounded, 100k-entry) nonce cache with junk nonces, either evicting
 * legitimate entries early or wasting the cache on requests that were never
 * going to be honored. This helper makes that ordering an explicit, testable
 * gate: the cache is touched ONLY when `verified` is true.
 *
 * @param {boolean} verified - result of the caller's signature verification,
 *   computed and checked BEFORE this is called.
 * @param {string} nonce
 * @param {number} expiresAtMs
 * @returns {{ok: boolean, reason?: string}}
 */
function checkNonceAfterVerify(verified, nonce, expiresAtMs) {
  if (!verified) return { ok: false, reason: 'signature-invalid' };
  return checkAndRecordNonce(nonce, expiresAtMs);
}

module.exports = { checkAndRecordNonce, checkNonceAfterVerify, _reset, _size, MAX_ENTRIES, SWEEP_INTERVAL_MS, DEFAULT_TTL_MS };
