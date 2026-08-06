'use strict';
/**
 * Back off when the platform says it is unavailable.
 *
 * Measured 2026-07-31: a fleet-wide auth outage (`503 CHAIN_SYNCING`) ran from
 * ~04:03 to 16:37 and produced **~908 auth failures**. `getAgentSession` calls
 * `authenticate()` with no backoff and does not cache a failed session, so every
 * poll cycle re-authenticated every agent — roughly 43 calls a minute, sustained
 * for 46 minutes, which the platform eventually answered with `429 Too many
 * requests`. We turned their degradation into our rate-limit ban.
 *
 * The platform's own 503 says "try again shortly". Hammering it is both rude and
 * self-defeating: the 429 outlasts the 503.
 *
 * Two things this must get right, and they pull in opposite directions:
 *
 *  - **Back off hard enough to stop hammering.** Exponential, from 5s.
 *  - **Recover fast when the outage ends.** The window is ~50 minutes, so the
 *    delay is capped at 5 minutes: about 10 probes across an outage instead of
 *    ~2000, while never leaving the fleet idle for more than 5 minutes after
 *    recovery. An uncapped exponential would still be asleep an hour later.
 *
 * Jitter is not decoration here. The outage hits all agents at once, so without
 * it the whole fleet would retry in the same instant and reproduce the burst
 * that earned the 429 — just less often. Each agent's delay is spread ±25%.
 *
 * Pure over caller-supplied records and clock: no I/O, no timers, no Date.now().
 * The caller owns the Map, exactly as with the inbox failure maps.
 */

/** First delay after a single failure. */
const BASE_DELAY_MS = 5000;

/** Ceiling on a single wait. Recovery latency matters more than politeness. */
const MAX_DELAY_MS = 5 * 60 * 1000;

/** Fraction of the delay to spread randomly, so a fleet does not retry in lockstep. */
const JITTER_RATIO = 0.25;

/**
 * Is this failure the platform telling us it is temporarily unavailable?
 *
 * Deliberately narrow. A 401 (bad key), a 403 or a malformed identity is NOT
 * something waiting fixes — backing off on those would hide a misconfiguration
 * behind a slowly-retrying loop, which is the silent-failure pattern this
 * codebase keeps getting bitten by. Only wait for things that end by themselves.
 */
function isRetryableAuthFailure(err) {
  if (!err) return false;
  const status = typeof err.statusCode === 'number' ? err.statusCode : null;
  if (status === 429) return true;               // explicitly rate-limited
  if (status !== null && status >= 500) return true; // 502/503/504 — their side
  const code = String((err && err.code) || '').toUpperCase();
  if (code === 'CHAIN_SYNCING' || code === 'SERVICE_UNAVAILABLE') return true;
  const msg = String((err && err.message) || '').toLowerCase();
  return /chain_syncing|temporarily unavailable|too many requests|service unavailable|econnrefused|etimedout|socket hang up|fetch failed/.test(msg);
}

/**
 * Honour a server-supplied Retry-After when there is one.
 *
 * If the platform tells us how long to wait, arguing with it is how you get
 * banned. Accepts seconds (the common form) and clamps to the same ceiling so a
 * hostile or mistaken header cannot park the fleet for an hour.
 */
function retryAfterMs(err, maxDelayMs = MAX_DELAY_MS) {
  const raw = err && (err.retryAfter ?? err.retry_after
    ?? (err.headers && (err.headers['retry-after'] ?? err.headers['Retry-After'])));
  if (raw === undefined || raw === null) return null;
  const secs = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  return Math.min(secs * 1000, maxDelayMs);
}

/**
 * Fold a failure into an agent's backoff record.
 *
 * Returns a NEW record; the caller stores it. `rand` is injectable so tests are
 * deterministic — jitter must not make a test flaky.
 */
function recordAuthFailure(prev, err, {
  now = 0,
  baseDelayMs = BASE_DELAY_MS,
  maxDelayMs = MAX_DELAY_MS,
  rand = Math.random,
} = {}) {
  const failures = ((prev && prev.failures) || 0) + 1;

  // A non-retryable failure is recorded for visibility but must NOT delay the
  // next attempt: a wrong WIF should fail loudly every cycle, not quietly once
  // every five minutes.
  if (!isRetryableAuthFailure(err)) {
    return {
      failures,
      until: 0,
      retryable: false,
      lastError: String((err && err.message) || err || '').slice(0, 200),
    };
  }

  const server = retryAfterMs(err, maxDelayMs);
  let delay;
  if (server !== null) {
    delay = server;
  } else {
    const exp = baseDelayMs * Math.pow(2, failures - 1);
    const capped = Math.min(exp, maxDelayMs);
    // ±JITTER_RATIO around the capped delay.
    const spread = capped * JITTER_RATIO;
    const r = typeof rand === 'function' ? rand() : 0.5;
    delay = Math.max(0, Math.round(capped - spread + (r * 2 * spread)));
  }

  return {
    failures,
    until: now + delay,
    retryable: true,
    delayMs: delay,
    lastError: String((err && err.message) || err || '').slice(0, 200),
  };
}

/**
 * May we attempt an authentication for this agent right now?
 *
 * Returns { attempt, waitMs, failures }. Fails OPEN — an absent, malformed or
 * non-finite record means "go ahead". A bug in the bookkeeping must never be
 * able to park the whole fleet permanently; the worst case of attempting too
 * early is one wasted request, the worst case of refusing forever is a
 * dispatcher that silently stops working.
 */
function shouldAttemptAuth(record, now = 0) {
  if (!record || typeof record !== 'object') return { attempt: true, waitMs: 0, failures: 0 };
  const until = Number(record.until);
  const failures = Number.isFinite(record.failures) ? record.failures : 0;
  if (!Number.isFinite(until) || until <= 0) return { attempt: true, waitMs: 0, failures };
  if (!Number.isFinite(now)) return { attempt: true, waitMs: 0, failures };
  if (now >= until) return { attempt: true, waitMs: 0, failures };
  return { attempt: false, waitMs: until - now, failures };
}

/** Success clears the record entirely — the next failure starts from scratch. */
function clearAuthFailure(map, agentId) {
  if (map && typeof map.delete === 'function') map.delete(agentId);
}

/**
 * Human summary for the health document: which agents are waiting, and for how
 * long. An outage the operator cannot see is indistinguishable from a hang.
 */
function summarizeAuthBackoff(map, now = 0) {
  if (!map || typeof map.entries !== 'function') return { waiting: 0, agents: [] };
  const agents = [];
  for (const [agentId, rec] of map.entries()) {
    const s = shouldAttemptAuth(rec, now);
    if (!s.attempt) {
      agents.push({
        agentId,
        failures: s.failures,
        retryInMs: s.waitMs,
        lastError: (rec && rec.lastError) || null,
      });
    }
  }
  return { waiting: agents.length, agents };
}

module.exports = {
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  JITTER_RATIO,
  isRetryableAuthFailure,
  retryAfterMs,
  recordAuthFailure,
  shouldAttemptAuth,
  clearAuthFailure,
  summarizeAuthBackoff,
};
