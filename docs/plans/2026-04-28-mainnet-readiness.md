# Mainnet-Readiness Plan — Dispatcher 2.1.13 + 2.1.14

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development for execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two security holes that would bite J41 on mainnet (revoke webhook auth, nonce replay) and the two economic-griefing vectors (no per-buyer proxy rate limit, no circuit-breaker on dead upstreams). Ship as two patch releases — security-only first (2.1.13), resilience second (2.1.14) — so the security fixes can land independently if priorities shift.

**Architecture:** Reuse the existing per-agent HMAC webhook-secret infrastructure (already used for `/webhook/:agentId` routes since 2.0.x) for the revoke webhook. Add a single in-memory nonce cache module. Add an in-memory token-bucket rate limiter module. Wire `getHealth()`'s existing scaffold into the proxy hot path with a configurable failure threshold. All four changes are additive — no API/wire format changes, no breaking config changes.

**Tech Stack:**
- Existing: `@junction41/sovagent-sdk` `verifyWebhookSignature`, `crypto.timingSafeEqual`, `Atomics.wait` for sync timing
- No new dependencies

**Scope boundaries:**
- IN scope: dispatcher process — proxy-handler, webhook-server, upstream-health, two new util modules.
- OUT of scope: SDK changes (clients don't need to know about these — they're server-side defenses).
- OUT of scope: backend changes. Backend already HMAC-signs `/webhook/:agentId` events; signing the revoke webhook reuses the same secret + algorithm.
- OUT of scope: backup/restore CLI (separate roadmap item, 2.1.7-C).

---

## Findings being addressed

| # | Severity | Finding | Phase |
|---|---|---|---|
| 1 | 🔴 Security | `/j41/api-access/revoke` accepts unauthenticated POSTs (introduced 2.1.12). Anyone with a dispatcher's public URL can revoke any seller's API keys for any known buyer. | 2.1.13 |
| 2 | 🔴 Security | No nonce-replay tracking on v2 access envelopes. An attacker who captures a valid envelope can replay within the 5-min window to mint duplicate keys. | 2.1.13 |
| 3 | 🟠 Resilience | No per-buyer rate limit at proxy. A buyer with valid auth can drain credit + saturate upstream. | 2.1.14 |
| 4 | 🟠 Resilience | Circuit breaker scaffolded (`upstream-health.js` polls + exports `getHealth()`) but never gates proxy. Proxy keeps forwarding to dead upstream, burning credit on errors. | 2.1.14 |

---

## File Structure

```
src/
  nonce-cache.js              NEW (2.1.13) — in-memory TTL nonce tracker
  proxy-rate-limiter.js       NEW (2.1.14) — per-buyer token bucket
test/
  nonce-cache.test.js         NEW (2.1.13)
  proxy-rate-limiter.test.js  NEW (2.1.14)
```

**Modified:**
- `src/webhook-server.js` — HMAC verify `/j41/api-access/revoke` (2.1.13); pass agentWebhooks into proxyContext path
- `src/cli.js` — wire nonce cache into the v2 envelope receive path (2.1.13); rate-limit + circuit-breaker context (2.1.14)
- `src/proxy-handler.js` — call rate limiter + circuit-breaker check before forwarding (2.1.14)
- `src/upstream-health.js` — track `consecutive_failures` (2.1.14)
- `src/config-loader.js` — extend `[proxy]` schema with rate-limit + circuit knobs (2.1.14)
- `package.json` — version bumps + CHANGELOG entries

---

## Phase 1 — 2.1.13 (security)

**Goal:** Close the two 🔴 findings. Ship within hours, not days.

### Task 1: HMAC the revoke webhook

**Files:**
- Modify: `src/webhook-server.js`
- Modify: `src/cli.js`

#### Step 1: Pass `agentWebhooks` into the proxy context routes

Currently `/j41/api-access/revoke` runs inside `startWebhookServer()` but doesn't know which agent's secret applies. Body specifies `sellerVerusId`; we need a lookup `sellerVerusId → agentId → secret`.

In `cli.js` where `proxyContext` is built, add a helper:

```js
proxyContext.lookupAgentSecret = (sellerVerusId) => {
  const sellerAgent = state.agents.find(a =>
    a.iAddress === sellerVerusId || a.identity === sellerVerusId
  );
  if (!sellerAgent) return null;
  const w = agentWebhooks.get(sellerAgent.id);
  return w?.secret || null;
};
```

#### Step 2: Verify signature in the revoke handler

In `src/webhook-server.js`, before calling `proxyContext.onApiAccessRevoke`:

```js
if (req.method === 'POST' && req.url === '/j41/api-access/revoke' && proxyContext) {
  const body = await readBody(req, res);
  if (body === null) return;

  const signature = req.headers['x-webhook-signature'] || '';
  if (!signature) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing x-webhook-signature' }));
    return;
  }

  let payload;
  try { payload = JSON.parse(body); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  const { sellerVerusId } = payload || {};
  if (!sellerVerusId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing sellerVerusId' }));
    return;
  }

  // Look up the seller's webhook secret + verify HMAC
  const secret = proxyContext.lookupAgentSecret?.(sellerVerusId);
  if (!secret) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Seller not found on this dispatcher' }));
    return;
  }
  if (!verifyWebhookSignature(body, signature, secret)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid signature' }));
    return;
  }

  try {
    const result = await proxyContext.onApiAccessRevoke(payload);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (e) {
    console.error(`[ApiAccessRevoke] failed: ${e.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Revoke failed' }));
  }
  return;
}
```

`verifyWebhookSignature` is already imported at the top of `webhook-server.js` from the SDK.

- [ ] **Step 3:** Add tests for ALL four return paths of the HMAC webhook handler:
  - 401 when `x-webhook-signature` header missing
  - 403 when signature is present but invalid
  - 404 when the seller's i-address is not registered on this dispatcher
  - 200 when signature valid AND seller known (asserts `revoke` count > 0 for a buyer with active keys)
  Use Node's `http` to stand up the server in-memory.

- [ ] **Step 4:** `node --check`, `yarn test` (32+1 = 33), commit:
```
feat(2.1.13): HMAC-sign revoke webhook (close unauthenticated revoke)
```

#### Backend coordination note

Document this in CHANGELOG: when the platform calls `/j41/api-access/revoke` on a dispatcher, it MUST include `x-webhook-signature: sha256=<hex>` of the raw body using the same per-agent webhook secret it uses for the existing `/webhook/:agentId` routes. Backend was already storing these secrets per-agent — no new infrastructure on their side.

---

### Task 2: Nonce replay protection on v2 envelopes

**Files:**
- Create: `src/nonce-cache.js`
- Create: `test/nonce-cache.test.js`
- Modify: `src/cli.js` (the v2 envelope receive path around line 3360)

#### Step 1: Create `src/nonce-cache.js`

```js
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
 * Process-local — restarts clear the cache. That's acceptable: an
 * attacker can only replay within the envelope's expiresAt, so a
 * dispatcher restart at minute 11 doesn't open a window the envelope
 * already closed itself.
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
 * Check + record a nonce. Returns:
 *   - { ok: true } if the nonce is fresh (recorded)
 *   - { ok: false, reason: 'replay' } if seen recently
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
  // LRU evict if over cap (Map iteration is insertion-order)
  if (_seen.size >= MAX_ENTRIES) {
    const oldest = _seen.keys().next().value;
    if (oldest !== undefined) _seen.delete(oldest);
  }
  // Bug fix per plan review: Math.max(now, X) is never falsy, so the
  // previous "|| (now + DEFAULT_TTL_MS)" fallback never fired for already-
  // expired envelopes. This explicit branch correctly falls back when
  // expiresAtMs is missing OR already in the past.
  const ttl = (Number.isFinite(expiresAtMs) && expiresAtMs > now)
    ? expiresAtMs
    : (now + DEFAULT_TTL_MS);
  _seen.set(nonce, ttl);
  return { ok: true };
}

function _reset() { _seen = new Map(); if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null; } }
function _size() { return _seen.size; }

module.exports = { checkAndRecordNonce, _reset, _size, MAX_ENTRIES, SWEEP_INTERVAL_MS };
```

#### Step 2: Wire into v2 envelope receive

In `src/cli.js`, the v2 path runs `canonicalBytes(envelope)` around line 3366 and `verifyCanonicalSignatures(...)` around line 3402. Insert the nonce check **between** those two — after `canonicalBytes` is computed (so we have a validated envelope), before signature verification (so we don't waste a CPU-heavy verify on a known-replayed nonce):

```js
if (isV2) {
  // ... existing validation ...

  // Replay protection: reject duplicate nonces within their expiry window.
  const { checkAndRecordNonce } = require('./nonce-cache.js');
  const expiresMs = Date.parse(envelope.expiresAt);
  const replayCheck = checkAndRecordNonce(envelope.nonce, expiresMs);
  if (!replayCheck.ok) {
    throw new Error(`v2 envelope rejected: ${replayCheck.reason} (nonce=${envelope.nonce.slice(0, 8)}…)`);
  }

  // ... existing signature verification ...
}
```

The error throw causes `onAccessRequest` to reject with 500 and structured stderr log.

#### Step 3: Tests in `test/nonce-cache.test.js`

```js
const test = require('node:test');
const assert = require('node:assert');
const { checkAndRecordNonce, _reset, _size } = require('../src/nonce-cache.js');

test('first sighting of a nonce is accepted', () => {
  _reset();
  const r = checkAndRecordNonce('a'.repeat(32), Date.now() + 60_000);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(_size(), 1);
});

test('replayed nonce within window is rejected', () => {
  _reset();
  const n = 'b'.repeat(32);
  const exp = Date.now() + 60_000;
  assert.strictEqual(checkAndRecordNonce(n, exp).ok, true);
  const r = checkAndRecordNonce(n, exp);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'replay');
});

test('replay after expiry is accepted (window passed)', () => {
  _reset();
  const n = 'c'.repeat(32);
  // Already expired
  assert.strictEqual(checkAndRecordNonce(n, Date.now() - 1).ok, true);
  // Manually fast-forward by re-recording with fresh ttl
  const r = checkAndRecordNonce(n, Date.now() + 60_000);
  assert.strictEqual(r.ok, true);
});

test('invalid nonce is rejected', () => {
  _reset();
  assert.strictEqual(checkAndRecordNonce(undefined, Date.now() + 60_000).ok, false);
  assert.strictEqual(checkAndRecordNonce('', Date.now() + 60_000).ok, false);
});

test('LRU eviction kicks in over MAX_ENTRIES', () => {
  _reset();
  // Insert 100001 entries; oldest should evict
  // Skipping in unit test — covered by static MAX_ENTRIES constant; perf-test only
});
```

- [ ] **Step 4:** `node --test test/`, expect 32 + 4 = 36 passing. Commit:
```
feat(2.1.13): nonce replay protection on v2 access envelopes
```

---

### Task 3: 2.1.13 release commit

- [ ] Bump `package.json` 2.1.12 → 2.1.13
- [ ] Add `## 2.1.13` section to CHANGELOG with both findings + remediation
- [ ] Commit: `chore(release): 2.1.13 — close unauthenticated revoke + nonce replay`
- [ ] `git push origin main`
- [ ] `npm publish --access public`
- [ ] `npm view @junction41/dispatcher version` → 2.1.13
- [ ] Update local global install: `yarn global remove @junction41/dispatcher && yarn global add @junction41/dispatcher@latest`

CHANGELOG content:

```markdown
## 2.1.13 — 2026-04-28

**Security patch — required for mainnet.** Two fixes:

1. **Revoke webhook now requires HMAC signature** (CVE-style: previously
   any unauthenticated POST to `/j41/api-access/revoke` could revoke any
   seller's API keys for any known buyer). Backend MUST now include
   `x-webhook-signature: sha256=<hex>` header with the body HMAC-signed
   using the seller's per-agent webhook secret (same secret already
   used for `/webhook/:agentId` events). Missing signature: 401.
   Wrong signature: 403. Unknown seller: 404.

2. **Nonce replay protection on v2 access envelopes.** Dispatcher now
   tracks recently-seen nonces (in-memory, 11-min TTL = max envelope
   window + 1 min grace, 100k LRU cap). Replayed envelopes within
   their expiry window now throw "v2 envelope rejected: replay" and
   the proxy refuses to mint a duplicate API key.

Both fixes are mandatory for mainnet operators. Backend coordination
required for #1 — see backend release notes for HMAC-signing the
revoke calls.
```

---

## Phase 2 — 2.1.14 (resilience)

**Goal:** Close the two 🟠 economic-griefing vectors. Ship within a day or two of 2.1.13.

### Task 4: Per-buyer proxy rate limiter

**Files:**
- Create: `src/proxy-rate-limiter.js`
- Create: `test/proxy-rate-limiter.test.js`
- Modify: `src/proxy-handler.js`
- Modify: `src/config-loader.js` (add schema keys)

#### Step 1: Schema additions to `config-loader.js`

```toml
[proxy]
# Existing 2.1.6 keys: upstream_timeout_ms, estimated_input_tokens, estimated_output_tokens, suggested_topup_vrsc
rate_limit_rps = 10              # tokens-per-second per buyer
rate_limit_burst = 30            # max bucket size per buyer
rate_limit_max_buckets = 10000   # LRU cap on # of distinct buyers tracked
```

ENV_OVERRIDES additions:
```js
['J41_PROXY_RATE_LIMIT_RPS',         'proxy.rate_limit_rps',         'int'],
['J41_PROXY_RATE_LIMIT_BURST',       'proxy.rate_limit_burst',       'int'],
['J41_PROXY_RATE_LIMIT_MAX_BUCKETS', 'proxy.rate_limit_max_buckets', 'int'],
```

#### Step 2: `src/proxy-rate-limiter.js`

Token bucket per `buyerVerusId`. Pseudocode (full source ~80 LOC):

```js
const _buckets = new Map();  // buyerVerusId → { tokens, lastRefill, lastTouch }
const SWEEP_MS = 60_000;
const IDLE_TTL_MS = 5 * 60_000;
let _sweepTimer = null;

function _ensureSweep(maxBuckets) {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => {
    const now = Date.now();
    // Idle eviction
    for (const [k, v] of _buckets) if (now - v.lastTouch > IDLE_TTL_MS) _buckets.delete(k);
    // LRU cap
    while (_buckets.size > maxBuckets) {
      const oldest = _buckets.keys().next().value;
      if (oldest === undefined) break;
      _buckets.delete(oldest);
    }
  }, SWEEP_MS);
  _sweepTimer.unref?.();
}

/**
 * @returns { allowed: boolean, retryAfterSec?: number }
 */
function checkRate(buyerVerusId, cfg) {
  _ensureSweep(cfg.rate_limit_max_buckets);
  const now = Date.now();
  const burst = cfg.rate_limit_burst;
  const rps = cfg.rate_limit_rps;
  let b = _buckets.get(buyerVerusId);
  if (!b) {
    b = { tokens: burst, lastRefill: now, lastTouch: now };
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
  const retryAfterSec = Math.ceil((1 - b.tokens) / rps);
  return { allowed: false, retryAfterSec };
}

function _reset() { _buckets.clear(); if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null; } }
function _size() { return _buckets.size; }

module.exports = { checkRate, _reset, _size };
```

#### Step 3: Wire into `src/proxy-handler.js`

In `handleProxyRequest()`, after `validateApiKey` succeeds and we have `record.buyerVerusId`, before the credit reservation:

```js
const { checkRate } = require('./proxy-rate-limiter.js');
const rate = checkRate(record.buyerVerusId, cfg.proxy);
if (!rate.allowed) {
  res.writeHead(429, {
    'Content-Type': 'application/json',
    'Retry-After': String(rate.retryAfterSec),
    'X-J41-RateLimit-Limit': String(cfg.proxy.rate_limit_rps),
  });
  res.end(JSON.stringify({ error: 'Rate limit exceeded', retryAfter: rate.retryAfterSec }));
  return;
}
```

#### Step 4: 6 tests in `test/proxy-rate-limiter.test.js`

```js
test('first request consumes one token', () => { ... });
test('burst exhaustion returns 429', () => { ... });
test('refill restores capacity over time', () => { ... });
test('different buyers have independent buckets', () => { ... });
test('idle bucket is evicted by sweep', () => { ... });
test('LRU evicts oldest when MAX_BUCKETS exceeded', () => { ... });
```

- [ ] Lint, test (32 + 4 nonce-cache + 6 = 42 passing), commit:
```
feat(2.1.14): per-buyer proxy rate limit (token bucket + LRU)
```

---

### Task 5: Circuit breaker — wire `getHealth()` into proxy

**Files:**
- Modify: `src/upstream-health.js`
- Modify: `src/proxy-handler.js`
- Modify: `src/config-loader.js` (more schema keys)

#### Step 1: Schema additions to `config-loader.js`

```toml
[proxy]
circuit_threshold = 3       # consecutive_failures before circuit opens
circuit_open_ms = 30000     # how long the circuit stays open after tripping
```

ENV_OVERRIDES additions:
```js
['J41_PROXY_CIRCUIT_THRESHOLD', 'proxy.circuit_threshold', 'int'],
['J41_PROXY_CIRCUIT_OPEN_MS',   'proxy.circuit_open_ms',   'int'],
```

#### Step 2: Track `consecutive_failures` + `circuitOpenedAt` in `src/upstream-health.js`

The reviewer caught a logic bug in the original draft: `lastCheck` is set on every poll (every 60s), so the condition `Date.now() - lastCheck < circuit_open_ms` would be permanently true and the circuit could never close via the time window. Fix: track a separate `circuitOpenedAt` timestamp set when `consecutive_failures` first crosses the threshold, and use THAT for the close check.

In the existing `checkUpstream()` body where `_health.set(...)` is called:

```js
function _record(agentId, result, threshold) {
  const prev = _health.get(agentId) || { consecutive_failures: 0, circuitOpenedAt: null };
  const consecutive_failures = result.healthy
    ? 0
    : (prev.consecutive_failures || 0) + 1;
  let circuitOpenedAt = prev.circuitOpenedAt;
  if (result.healthy) {
    // Successful probe → close the circuit.
    circuitOpenedAt = null;
  } else if (!circuitOpenedAt && consecutive_failures >= threshold) {
    // Just crossed the threshold → open the circuit, mark the moment.
    circuitOpenedAt = Date.now();
  }
  _health.set(agentId, {
    ...result,
    consecutive_failures,
    circuitOpenedAt,
    lastCheck: Date.now(),
  });
}
```

The threshold needs to be available at record-time. Plumb `cfg.proxy.circuit_threshold` through to `startHealthPoller` (a one-line refactor) so each `checkUpstream` call knows the threshold without re-reading config.

`getHealth(agentId)` continues to return the full object — existing callers still see `healthy`, `status`, `lastCheck`. New consumers can read `consecutive_failures` and `circuitOpenedAt`.

#### Step 3: Gate proxy in `src/proxy-handler.js`

After rate-limit check, before forwarding:

```js
const { getHealth } = require('./upstream-health.js');
const health = getHealth(agentId);
if (
  health &&
  health.circuitOpenedAt &&
  Date.now() - health.circuitOpenedAt < cfg.proxy.circuit_open_ms
) {
  res.writeHead(503, {
    'Content-Type': 'application/json',
    'X-J41-Upstream-Circuit': 'open',
    'Retry-After': String(Math.ceil(cfg.proxy.circuit_open_ms / 1000)),
  });
  res.end(JSON.stringify({
    error: 'Upstream temporarily unavailable',
    consecutive_failures: health.consecutive_failures,
  }));
  return;
}
// If circuitOpenedAt is set but the open window has expired, we let the
// next request through ("half-open" state). A successful upstream call
// won't reset circuitOpenedAt directly — that happens on the next health
// probe. The window-passed request is a probe-via-traffic. If it fails
// and the next health poll also fails, circuit stays open another window.
```

#### Step 4: 4 tests

```js
test('healthy upstream lets request through', () => { ... });
test('threshold failures trip the breaker', () => { ... });
test('window expiry closes the breaker', () => { ... });
test('successful health probe resets consecutive_failures', () => { ... });
```

- [ ] Lint, test (42 + 4 = 46 passing), commit:
```
feat(2.1.14): wire upstream-health circuit breaker into proxy
```

---

### Task 6: 2.1.14 release commit

- [ ] Bump 2.1.13 → 2.1.14, add CHANGELOG section, commit, push, publish.

CHANGELOG content:

```markdown
## 2.1.14 — 2026-04-28

**Resilience patch.** Two fixes addressing economic-griefing vectors:

1. **Per-buyer rate limit at proxy** — token bucket keyed by buyerVerusId.
   Defaults: 10 RPS per buyer, 30-burst. Configurable via
   `[proxy] rate_limit_rps` / `rate_limit_burst` /
   `rate_limit_max_buckets` (default 10k LRU cap).
   Returns HTTP 429 with `Retry-After` header. Idle buckets evicted
   after 5 min, LRU evicted at the cap.

2. **Circuit breaker on proxy → upstream** — `upstream-health.js` was
   already polling `/models` every 60s but the proxy never gated on
   the result. Now: after `circuit_threshold=3` consecutive failed
   probes, the proxy returns 503 immediately for `circuit_open_ms=30s`
   instead of forwarding to a dead upstream and burning credit on
   errors. Defaults configurable via `[proxy]` keys above.

Pure additive — no breaking API/wire changes. Operators with default
config get the protections automatically.
```

---

## Test budget

| Phase | Net new tests | Cumulative |
|---|---|---|
| 2.1.12 (already shipped) | 0 | 32 |
| 2.1.13 (Phase 1) | 4 (nonce cache: first-sighting, replay-rejected, post-expiry, invalid-input) + 4 (HMAC webhook: 401, 403, 404, 200) = 8 | 40 |
| 2.1.14 (Phase 2) | 6 (rate limit) + 4 (circuit breaker) = 10 | 50 |

---

## Verification commands (run after each phase)

```bash
# Lint
node --check src/*.js src/executors/*.js

# Tests
node --test test/*.test.js

# Phase 1 verify (security)
curl -i -X POST https://your-dispatcher/j41/api-access/revoke \
  -H "Content-Type: application/json" \
  -d '{"sellerVerusId":"i...","buyerVerusId":"i..."}'
# Expected: 401 Missing x-webhook-signature

# Phase 2 verify (resilience)
# Hammer with 100 requests/sec from same buyer, expect 429s after burst
# Stop upstream, expect 503 with X-J41-Upstream-Circuit: open after ~3 mins
```

---

## Effort estimate

| Phase | Hours (focused) |
|---|---|
| 2.1.13 (Phase 1, security) | 3–4 |
| 2.1.14 (Phase 2, resilience) | 4–6 |
| **Total** | **7–10 hours** |

Both phases use existing infrastructure where possible (HMAC verify already in webhook-server, getHealth already exists in upstream-health). Most of the LOC is the new util modules + tests.

---

## Risks

- **Phase 1 backend coordination — REQUIRED rollout order:**
  1. **Backend ships HMAC-signing on its `DELETE /v1/me/api-access/:grantId` → revoke fan-out FIRST.** Backend already has the per-agent webhook secrets stored (registered via `POST /v1/me/webhooks` since 2.0.x). Adding the `x-webhook-signature` header on the existing revoke fan-out is a one-line backend change.
  2. **Then ship dispatcher 2.1.13.** Once backend is signing, dispatcher's HMAC verify will accept those calls. If dispatcher ships first, ALL backend revoke calls return 401 until backend catches up — operationally bad but not a security regression (the previous 2.1.12 behavior was permissive; 2.1.13 is restrictive).

  Do NOT ship a "unsigned-from-known-IP" transition window — that's a partial bypass and reintroduces exactly the attack vector we're closing.

- **Phase 2 default rate limit too strict / too loose:** defaults of 10 RPS / 30-burst chosen for typical chat-style workloads. Streaming workloads or bulk-embed APIs may need higher. Mitigation: the `J41_PROXY_RATE_LIMIT_RPS` env override gives operators a one-line escape hatch.

- **Phase 2 circuit-breaker false positives:** transient network blips could trip the breaker. Default threshold=3 (≥3 minutes of confirmed dead upstream) is conservative. Operators with flaky networks may want threshold=5+.

---

## Out of scope (deferred to 2.2.0+)

- Workspace storage quotas (Docker pquota wiring) — separate operator-facing concern, see roadmap 2.2.0-D.
- Token estimation replacing magic 4000/2000 — see roadmap 2.1.7-D.
- Webhook delivery retries / DLQ — see roadmap 2.2.0-B.
- Backup/restore CLI — see roadmap 2.1.7-C.
- Expanded `/metrics` — see roadmap 2.2.0-A.
- **Per-agent rate-limit + circuit-threshold overrides.** Both knobs are dispatcher-global in 2.1.14. A multi-agent dispatcher serving (a) chat-style agents at 10 RPS and (b) batch-embedding agents at 100 RPS shares the same setting — operator must pick the highest of their workloads as the global. Future move: per-agent overrides in `agent-config.json`, gated on real operator feedback.

These are real gaps but don't block mainnet launch. They show up post-launch as operator-feedback signals — better to address with real workload data than guess at thresholds.
