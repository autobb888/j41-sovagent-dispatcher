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
const MAX_ENTRIES = 100_000;

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

module.exports = { checkAndRecordNonce, _reset, _size, MAX_ENTRIES, SWEEP_INTERVAL_MS, DEFAULT_TTL_MS };
