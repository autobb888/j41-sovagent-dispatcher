'use strict';
/**
 * Per-buyer token bucket rate limiter for the proxy hot path.
 *
 * Keyed by buyerVerusId. Each bucket: { tokens, lastRefill, lastTouch }.
 * Refills at cfg.rate_limit_rps tokens/sec, capped at cfg.rate_limit_burst.
 *
 * Memory bound: idle buckets (no touch in IDLE_TTL_MS) evicted by sweep;
 * hard cap at cfg.rate_limit_max_buckets (LRU evicts oldest by insertion order).
 *
 * Reset on process restart is acceptable — same trade-off as nonce-cache.
 */
const SWEEP_MS = 60_000;
const IDLE_TTL_MS = 5 * 60_000;

const _buckets = new Map();   // buyerVerusId → { tokens, lastRefill, lastTouch }
let _sweepTimer = null;
let _sweepCap = 10_000;       // updated by checkRate based on cfg

function _ensureSweep() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => {
    const now = Date.now();
    // Idle eviction
    for (const [k, v] of _buckets) {
      if (now - v.lastTouch > IDLE_TTL_MS) _buckets.delete(k);
    }
    // LRU cap (Map iteration is insertion-order)
    while (_buckets.size > _sweepCap) {
      const oldest = _buckets.keys().next().value;
      if (oldest === undefined) break;
      _buckets.delete(oldest);
    }
  }, SWEEP_MS);
  _sweepTimer.unref?.();
}

/**
 * Check + consume one token for the given buyer.
 * @param {string} buyerVerusId
 * @param {{rate_limit_rps: number, rate_limit_burst: number, rate_limit_max_buckets: number}} cfg
 * @returns {{ allowed: true } | { allowed: false, retryAfterSec: number }}
 */
function checkRate(buyerVerusId, cfg) {
  if (typeof buyerVerusId !== 'string' || buyerVerusId.length === 0) {
    return { allowed: false, retryAfterSec: 1 };
  }
  _sweepCap = Math.max(1, cfg.rate_limit_max_buckets || 10_000);
  _ensureSweep();
  const burst = Math.max(1, cfg.rate_limit_burst);
  const rps = Math.max(0.001, cfg.rate_limit_rps);
  const now = Date.now();
  let b = _buckets.get(buyerVerusId);
  if (!b) {
    b = { tokens: burst, lastRefill: now, lastTouch: now };
    // Eviction only if strictly over cap — avoids evicting on the insert that takes us TO the cap
    if (_buckets.size >= _sweepCap) {
      const oldest = _buckets.keys().next().value;
      if (oldest !== undefined) _buckets.delete(oldest);
    }
    _buckets.set(buyerVerusId, b);
  } else {
    const elapsed = (now - b.lastRefill) / 1000;
    b.tokens = Math.min(burst, b.tokens + elapsed * rps);
    b.lastRefill = now;
    b.lastTouch = now;
  }
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { allowed: true };
  }
  const retryAfterSec = Math.max(1, Math.ceil((1 - b.tokens) / rps));
  return { allowed: false, retryAfterSec };
}

function _reset() {
  _buckets.clear();
  if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null; }
  _sweepCap = 10_000;
}
function _size() { return _buckets.size; }

module.exports = { checkRate, _reset, _size, IDLE_TTL_MS, SWEEP_MS };
