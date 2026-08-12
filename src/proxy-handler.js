/**
 * API Proxy Handler — forwards buyer requests to seller's backend.
 * Validates API keys, checks credit, meters usage, adds J41 headers.
 * Supports both streaming (SSE) and non-streaming responses.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { findKeyOwner, recordUsage } = require('./api-key-manager');
const { reserveCredit, adjustCredit, refundReservation, checkAndFlagLow } = require('./credit-meter');
const { acquire: acquireInflight, release: releaseInflight } = require('./proxy-inflight.js');
const { loadDispatcherConfig } = require('./config-loader.js');

/**
 * Resolve the worst-case output tokens to RESERVE for a request (audit H3).
 *
 * The buyer must have balance covering the MAX they could consume, not a flat
 * 2000-token estimate. We take the larger of the configured output estimate and
 * the request's declared max_tokens, then bound a malicious huge max_tokens at
 * proxy.max_output_tokens_cap so it can't be used to demand an absurd
 * reservation (DoS) — the actual settle refunds back down to real usage anyway.
 *
 * @returns {number} output-token count to reserve against.
 */
function worstCaseOutputTokens(parsedBody, cfg) {
  const estOut = cfg.proxy.estimated_output_tokens;
  const cap = Number.isFinite(cfg.proxy.max_output_tokens_cap) && cfg.proxy.max_output_tokens_cap > 0
    ? cfg.proxy.max_output_tokens_cap
    : 200000;
  const raw = Number(parsedBody && parsedBody.max_tokens);
  // No / invalid max_tokens declared → fall back to the flat estimate (the buyer
  // didn't ask for more than the default). A declared value is bounded by cap.
  if (!Number.isFinite(raw) || raw <= 0) return estOut;
  return Math.max(estOut, Math.min(raw, cap));
}

/**
 * Resolve the seller-configured credit-low notify threshold (VRSC).
 * Defaults to suggested_topup_vrsc when unset (null/non-finite/<=0).
 */
function resolveCreditLowThreshold(cfg) {
  const t = cfg.proxy.credit_low_threshold_vrsc;
  if (Number.isFinite(t) && t > 0) return t;
  return cfg.proxy.suggested_topup_vrsc;
}

/**
 * Edge-triggered, debounced credit-low notify. Called from the post-request
 * settle path after adjustCredit. If `remaining` crossed below the threshold
 * and the buyer isn't already flagged, fires ONE seller-signed notify to J41.
 * Best-effort: never throws, never blocks the proxy response.
 */
function maybeNotifyCreditLow(agentId, buyerVerusId, remaining, cfg, config) {
  try {
    const threshold = resolveCreditLowThreshold(cfg);
    if (!checkAndFlagLow(agentId, buyerVerusId, remaining, threshold)) return;

    const { getNotifyContext, notifyJ41CreditLow } = require('./deposit-watcher.js');
    const ctx = getNotifyContext(agentId);
    if (!ctx) {
      // No signer context wired for this agent — can't sign the notify. The
      // flag is already set (debounced); re-arms on next deposit. Don't spam.
      return;
    }
    notifyJ41CreditLow(
      ctx.sellerWif,
      ctx.sellerVerusId,
      buyerVerusId,
      remaining,
      threshold,
      cfg.proxy.suggested_topup_vrsc,
      config.payAddress || '',
      ctx.network,
    ).catch(() => {});
  } catch {
    // Never let credit-low alerting break the proxy response.
  }
}

/**
 * Normalize an IPv6 address string to its canonical compressed form using
 * Node's net module so we can compare against well-known loopback/private
 * forms without maintaining a hand-rolled list of string variants.
 *
 * Returns null when the input is not a valid IPv6 address.
 */
function _canonicalizeIPv6(ip) {
  // net.isIPv6 accepts the input; Node normalizes via the underlying OS
  // inet_pton but doesn't expose a standalone normalize.  We use a
  // quick expand-then-compress approach in pure JS instead:
  //   1. Expand "::" shorthand to full 8 groups.
  //   2. Remove leading zeros in each group.
  //   3. Return the normalized form for comparison.
  try {
    // Split on "::" (at most one occurrence in valid v6)
    const halves = ip.split('::');
    if (halves.length > 2) return null;

    // Expand "::" shorthand into 8 full numeric groups for loopback/zero checks
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];

    const missing = 8 - left.length - right.length;
    if (missing < 0) return null; // malformed
    const full = [...left, ...Array(missing).fill('0'), ...right];
    if (full.length !== 8) return null;

    // Parse each group as hex (handles leading zeros)
    return full.map(g => parseInt(g, 16));
  } catch {
    return null;
  }
}

function isPrivateIp(ip) {
  if (!ip) return false;
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    return false;
  }
  if (v === 6) {
    const lo = ip.toLowerCase();

    // Fast-path: already-compressed canonical loopback / unspecified
    if (lo === '::1' || lo === '::') return true;

    // Link-local, ULA (fc00::/7)
    if (lo.startsWith('fe80:') || lo.startsWith('fc') || lo.startsWith('fd')) return true;

    // IPv4-mapped IPv6 in DOTTED notation: ::ffff:a.b.c.d
    const mDotted = lo.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mDotted) return isPrivateIp(mDotted[1]);

    // IPv4-mapped IPv6 in HEX notation: ::ffff:7f00:1 (= ::ffff:127.0.0.1)
    // Groups are 0000:ffff followed by two hex groups encoding the IPv4 addr.
    const groups = _canonicalizeIPv6(lo);
    if (groups) {
      // Loopback: all-zeros then 1  (0:0:0:0:0:0:0:1)
      // Note: deprecated IPv4-compatible ::1.x.x.x forms may over-match here — blocked safe-side (RFC 4291 deprecates them).
      if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
          groups[3] === 0 && groups[4] === 0 && groups[5] === 0 &&
          groups[6] === 0 && groups[7] === 1) return true;

      // IPv4-mapped: 0:0:0:0:0:ffff:<hi16>:<lo16>
      if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
          groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
        // Reconstruct the embedded IPv4 address
        const hi = groups[6];
        const lo16 = groups[7];
        const a4 = (hi >>> 8) & 0xff;
        const b4 = hi & 0xff;
        const c4 = (lo16 >>> 8) & 0xff;
        const d4 = lo16 & 0xff;
        return isPrivateIp(`${a4}.${b4}.${c4}.${d4}`);
      }

      // Unspecified address (::)
      if (groups.every(g => g === 0)) return true;
    }

    return false;
  }
  return false;
}

/**
 * Resolve and SSRF-check an upstream hostname.
 *
 * Returns { safe: true, resolvedIp: string } on success so the caller can
 * PIN the http.request `lookup` option to the already-validated address,
 * closing the DNS-rebind TOCTOU window (Fix 2 — DNS pin).
 *
 * When the hostname is already a bare IP literal we skip dns.lookup and
 * return the literal as resolvedIp.
 */
async function checkUpstreamHostSafe(hostname, cfg) {
  if (cfg.runtime.allow_local_upstream) return { safe: true, resolvedIp: null };
  const lc = hostname.toLowerCase();
  if (lc === 'localhost' || lc.endsWith('.localhost') || lc.endsWith('.local') || lc.endsWith('.internal')) {
    return { safe: false, reason: `hostname "${hostname}" is a local/internal name` };
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) return { safe: false, reason: `upstream IP ${hostname} is private/loopback/link-local` };
    return { safe: true, resolvedIp: hostname };
  }
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    for (const a of addrs) {
      if (isPrivateIp(a.address)) {
        return { safe: false, reason: `hostname ${hostname} resolves to private address ${a.address}` };
      }
    }
    // Use the first resolved address for the DNS pin so http.request skips
    // its own re-resolution (DNS-rebind TOCTOU).
    const pinnedIp = addrs.length > 0 ? addrs[0].address : null;
    return { safe: true, resolvedIp: pinnedIp };
  } catch (e) {
    return { safe: false, reason: `DNS lookup failed for ${hostname}: ${e.message}` };
  }
}

// Safe response headers to forward from upstream (allowlist)
const SAFE_HEADERS = new Set([
  'content-type', 'content-length', 'cache-control', 'vary',
  'x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining',
  'x-ratelimit-reset', 'openai-model', 'openai-processing-ms',
]);

function filterHeaders(upstreamHeaders) {
  const filtered = {};
  for (const [key, value] of Object.entries(upstreamHeaders)) {
    if (SAFE_HEADERS.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Handle a proxied API request.
 */
async function handleProxyRequest(req, res, agentConfigs, body) {
  const cfg = loadDispatcherConfig();
  const requestId = crypto.randomBytes(8).toString('hex');

  // Extract API key from Authorization header
  const authHeader = req.headers['authorization'] || '';
  const key = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!key || !key.startsWith('sk-')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or missing API key' }));
    return;
  }

  // Find which agent owns this key
  const owner = findKeyOwner(key);
  if (!owner) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unknown or expired API key' }));
    return;
  }

  const { agentId, record } = owner;
  const config = agentConfigs.get(agentId);
  if (!config || !config.endpointUrl) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Seller endpoint not configured' }));
    return;
  }

  // Parse request body for model
  let parsedBody;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  const model = parsedBody.model || '';
  const isStreaming = parsedBody.stream === true;

  // Reject unpriced models up front. calculateCost returns 0 for unknown models, which would
  // let requests through for free — the seller explicitly declared which models they serve by
  // pricing them, so anything not in that list is an unsupported model.
  const priced = (config.modelPricing || []).map(p => p.model);
  if (!priced.includes(model)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: `Model '${model}' is not offered by this seller`,
      supportedModels: priced,
    }));
    return;
  }

  // Per-(agent,buyer) rate limit. Token bucket keyed by agentId+buyerVerusId so
  // a buyer's traffic to one seller can't influence/evict another seller's bucket.
  {
    const { checkRate } = require('./proxy-rate-limiter.js');
    const rate = checkRate(agentId, record.buyerVerusId, cfg.proxy);
    if (!rate.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(rate.retryAfterSec),
        'X-J41-RateLimit-Limit': String(cfg.proxy.rate_limit_rps),
      });
      res.end(JSON.stringify({ error: 'Rate limit exceeded', retryAfter: rate.retryAfterSec }));
      return;
    }
  }

  // Circuit breaker (2.1.14): if upstream-health has tripped the circuit
  // for this agent and we're still inside the open window, fail fast with 503.
  // circuitOpenedAt is set when consecutive_failures first crosses
  // cfg.proxy.circuit_threshold; reset to null on next successful probe.
  // After circuit_open_ms elapses we let traffic through (half-open: probe via real requests).
  {
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
  }

  // Per-buyer in-flight concurrency cap (audit H3). The worst-case reservation
  // below only protects a SINGLE request; without a concurrency bound N parallel
  // requests each pass the balance check against the current balance and can
  // collectively over-commit, settling deeply negative. Acquire a slot now and
  // release it on EVERY terminal path via releaseOnce().
  const inflightCap = cfg.proxy.max_inflight_per_buyer;
  if (!acquireInflight(agentId, record.buyerVerusId, inflightCap)) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': '1',
      'X-J41-Inflight-Limit': String(inflightCap),
    });
    res.end(JSON.stringify({ error: 'Too many concurrent requests', maxInflight: inflightCap }));
    return;
  }
  let _inflightReleased = false;
  const releaseOnce = () => {
    if (_inflightReleased) return;
    _inflightReleased = true;
    releaseInflight(agentId, record.buyerVerusId);
  };

  // Reserve credit atomically (deducts upfront, adjusted after response).
  // Audit H3: reserve the WORST CASE — the buyer must have balance covering the
  // max output they could consume (declared max_tokens, bounded by the cap),
  // not a flat 2000-token estimate. adjustCredit refunds down to actual usage.
  const estimatedInput = cfg.proxy.estimated_input_tokens;
  const estimatedOutput = cfg.proxy.estimated_output_tokens;
  const reserveOutput = worstCaseOutputTokens(parsedBody, cfg);
  const creditCheck = reserveCredit(agentId, record.buyerVerusId, model, estimatedInput, reserveOutput, config.modelPricing || []);
  if (!creditCheck.allowed) {
    releaseOnce();
    res.writeHead(402, {
      'Content-Type': 'application/json',
      'X-J41-Credit-Remaining': '0',
      'X-J41-Credit-SuggestedTopup': String(cfg.proxy.suggested_topup_vrsc),
      'X-J41-Seller-PayAddress': config.payAddress || '',
    });
    res.end(JSON.stringify({
      error: 'Insufficient credit',
      balance: creditCheck.balance,
      estimatedCost: creditCheck.estimatedCost,
      topupAddress: config.payAddress || '',
    }));
    return;
  }

  // Build upstream URL — SSRF protection: validate hostname matches configured endpoint
  const upstreamPath = req.url.replace(/^\/j41\/proxy/, '');
  let upstreamUrl;
  try {
    upstreamUrl = new URL(upstreamPath, config.endpointUrl);
  } catch {
    refundReservation(agentId, record.buyerVerusId, creditCheck.reserved);
    releaseOnce();
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request path' }));
    return;
  }

  // SSRF check: resolved hostname must match configured endpoint
  const configuredHost = new URL(config.endpointUrl).hostname;
  if (upstreamUrl.hostname !== configuredHost) {
    refundReservation(agentId, record.buyerVerusId, creditCheck.reserved);
    releaseOnce();
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Request path resolves to unauthorized host' }));
    return;
  }

  // SSRF hardening: block private IPs unless J41_ALLOW_LOCAL_UPSTREAM=1 (dev)
  const safety = await checkUpstreamHostSafe(upstreamUrl.hostname, cfg);
  if (!safety.safe) {
    refundReservation(agentId, record.buyerVerusId, creditCheck.reserved);
    releaseOnce();
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Upstream blocked: ${safety.reason}` }));
    return;
  }

  // Audit H2 — streaming under-billing. The upstream emits a final usage frame
  // only when stream_options.include_usage:true is set. If the buyer omits it,
  // no usage frame arrives and the settle keeps the flat estimate → a huge
  // completion is billed at 2000 output tokens. Force-inject include_usage for
  // every stream:true request before forwarding. forwardBody is what we send
  // upstream (the original `body` is left intact for callers/logging).
  let forwardBody = body;
  if (isStreaming) {
    const so = (parsedBody.stream_options && typeof parsedBody.stream_options === 'object')
      ? { ...parsedBody.stream_options, include_usage: true }
      : { include_usage: true };
    forwardBody = JSON.stringify({ ...parsedBody, stream_options: so });
  }

  // Forward request to seller's backend
  const isHttps = upstreamUrl.protocol === 'https:';
  const transport = isHttps ? https : http;

  // Fix 2 — DNS-rebind pin: supply the already-validated IP as the `lookup`
  // callback so http.request never re-resolves the hostname via DNS.
  // This closes the TOCTOU window between our SSRF check (above) and the
  // actual TCP connect.  When allow_local_upstream is set (dev/test) or the
  // host was already a bare IP literal, resolvedIp may be null — fall back
  // to Node's default lookup in those cases only.
  const pinnedIp = safety.resolvedIp;
  const pinnedLookup = pinnedIp
    ? (hostname, opts, cb) => cb(null, pinnedIp, pinnedIp.includes(':') ? 6 : 4)
    : undefined;

  // Set once a streaming response is in flight, so the request-level error handler
  // below settles through the SAME policy instead of its own.
  let settleActiveStream = null;

  // ONE refund, whoever gets there first. A TCP reset mid-response fires BOTH
  // `proxyReq.on('error')` (headers not yet sent → refunds, writes 502, which makes
  // headersSent true) and then `proxyRes.on('error')` (its own local `settled` still
  // false → refunds AGAIN). Reproduced during review: the buyer GAINED a full
  // worst-case reservation of free credit. The two handlers each had a guard; neither
  // guard was shared, which is the same "one control, two sites" shape as the
  // streaming settle — fixed there in this release, missed here.
  let _refunded = false;
  const refundOnce = () => {
    if (_refunded) return;
    _refunded = true;
    refundReservation(agentId, record.buyerVerusId, creditCheck.reserved);
  };

  const proxyReq = transport.request(upstreamUrl.href, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'j41-proxy/1.0',
      ...(config.upstreamAuth ? { 'Authorization': config.upstreamAuth } : {}),
    },
    timeout: cfg.proxy.upstream_timeout_ms,
    ...(pinnedLookup ? { lookup: pinnedLookup } : {}),
  }, (proxyRes) => {
    const j41Headers = {
      'X-J41-Request-Id': requestId,
      'X-J41-Session': `${record.buyerVerusId}:${requestId}`,
      'X-J41-Model': model,
    };

    if (isStreaming) {
      // Stream response through, count tokens at the end.
      // Emit X-J41-Credit-Remaining now (before the body starts) using the
      // post-reservation balance (worst-case). adjustCredit at stream end may
      // refund part of the reservation, so the true final balance can only be
      // known after EOF — but headers must be sent before the first byte.
      j41Headers['X-J41-Credit-Remaining'] = creditCheck.balance.toFixed(4);
      if (creditCheck.balance < 1) {
        j41Headers['X-J41-Credit-SuggestedTopup'] = String(cfg.proxy.suggested_topup_vrsc);
        j41Headers['X-J41-Seller-PayAddress'] = config.payAddress || '';
      }
      const safeHeaders = filterHeaders(proxyRes.headers);
      res.writeHead(proxyRes.statusCode, { ...safeHeaders, ...j41Headers });

      let fullResponse = '';
      let deducted = false;

      proxyRes.on('data', (chunk) => {
        if (res.writableEnded) return;
        fullResponse += chunk.toString();
        res.write(chunk);
      });

      // ONE settle policy for the streaming response, shared by BOTH terminal
      // events. `end` and `error` used to implement different rules: `error`
      // charged `estimatedInput + reserveOutput` flat, with no statusCode check and
      // ignoring any usage frames already received — so a 503 stream that died
      // before a clean `end` billed the entire worst-case reservation (the exact
      // 204,000-token scenario M1 fixed), while the same 503 reaching `end` billed
      // zero. Three settle sites had three policies. The bug class this whole
      // change addresses is "a control applied at one of two sites"; leaving a
      // third site with its own rules reproduces it.
      const settleStream = (why, aborted = false) => {
        if (deducted) return;
        deducted = true;

        // Parse SSE chunks for usage data — scan each `data: {...}` frame with JSON.parse
        // so nested objects like completion_tokens_details survive (the old regex broke on them).
        let inputTok = estimatedInput;
        let outputTok = estimatedOutput;
        // Track a finite completion_tokens specifically — see the mirrored comment on
        // the non-streaming path. A usage frame carrying only prompt_tokens must still
        // fall through to the worst-case output settle.
        let sawOutput = false;
        for (const line of fullResponse.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const json = line.slice(5).trim();
          if (!json || json === '[DONE]') continue;
          try {
            const frame = JSON.parse(json);
            if (frame && frame.usage && typeof frame.usage === 'object') {
              if (Number.isFinite(frame.usage.prompt_tokens)) { inputTok = frame.usage.prompt_tokens; }
              if (Number.isFinite(frame.usage.completion_tokens)) { outputTok = frame.usage.completion_tokens; sawOutput = true; }
            }
          } catch {
            // Malformed frame — skip. Upstream may send keep-alive comments starting with `:` too.
          }
        }

        // Audit H2 — defensive settle. We forced stream_options.include_usage=true,
        // but an upstream that IGNORES it produces no usage frame. Falling back to
        // the flat estimate here would let such an upstream serve a huge completion
        // for the price of 2000 output tokens. Instead settle against the WORST
        // CASE the buyer declared (max_tokens, bounded by the cap = the same value
        // we reserved) so a non-compliant upstream can't be exploited for free
        // output. Input falls back to the estimate (no per-stream input signal).
        // M1 — the worst-case settle is an anti-abuse measure against a non-compliant
        // upstream that returns real output without a usage frame. It must NOT apply to
        // an upstream that returned an ERROR: a 503 has no usage frame either, and the
        // buyer received an error page, not tokens. `proxyRes.statusCode` was passed
        // through to the client but never consulted before billing, so a buyer sending
        // `stream:true, max_tokens:200000` was charged the full 204,000-token
        // reservation for a failed request. `proxyReq.on('error')` does not fire —
        // the connection succeeded. The circuit breaker only opens after N consecutive
        // failures, so the first N are billed in full.
        // The error check comes FIRST and is unconditional. It used to sit inside
        // `if (!sawUsage)`, so an error response that happened to carry a usage frame
        // was billed its reported tokens — the buyer paying for a 4xx/5xx, which is
        // the very thing M1 fixed for the no-usage case. The non-streaming path zeroes
        // on non-2xx regardless; these two must agree.
        const _upstreamOk = proxyRes.statusCode >= 200 && proxyRes.statusCode < 300;
        if (!_upstreamOk) {
          // No completion was delivered. Charge nothing for output, and nothing for
          // input either — the buyer got an error, not a service. This applies to a
          // mid-stream abort too: the status line already told us it was an error.
          outputTok = 0;
          inputTok = 0;
          console.warn(`[proxy] upstream ${proxyRes.statusCode} on a streaming request (${why}) — not billing (job ${key ? String(key).slice(0, 8) : '?'})`);
        } else if (aborted) {
          // A 2xx whose socket died mid-stream. Bill only what a usage frame
          // actually proved. With no usage frame that means zero OUTPUT; input still
          // settles at the estimate, which is the one quantity we know was sent.
          //
          // Not the worst-case settle, deliberately. That settle is an anti-abuse
          // measure against an upstream that returns real output while withholding
          // its usage count — a party gaming US. An abort is a failure the BUYER did
          // not cause and cannot cause: they have no way to make the seller's
          // upstream drop its socket. Charging them the full `max_tokens`
          // reservation for a broken response would be the only place in this file
          // where the victim of a fault pays for it. The inverse risk is a seller
          // whose upstream serves output and then kills the socket to avoid
          // billing — that costs the seller their own revenue, so it is self-limiting.
          if (!sawOutput) { outputTok = 0; }
          console.warn(`[proxy] streaming abort after ${proxyRes.statusCode} — billing ${inputTok}+${outputTok} (job ${key ? String(key).slice(0, 8) : '?'})`);
        } else if (!sawOutput) {
          outputTok = reserveOutput;
        }

        const result = adjustCredit(agentId, record.buyerVerusId, model, inputTok, outputTok, creditCheck.reserved, config.modelPricing || []);
        recordUsage(agentId, key, inputTok, outputTok);
        releaseOnce();
        maybeNotifyCreditLow(agentId, record.buyerVerusId, result.remaining, cfg, config);
        console.log(`[PROXY] ${agentId} ${model} ${inputTok}+${outputTok} tok, cost ${result.cost.toFixed(6)} VRSC, remaining ${result.remaining.toFixed(4)}`);
      };

      proxyRes.on('end', () => {
        if (!res.writableEnded) res.end();
        settleStream('end');
      });

      proxyRes.on('error', () => {
        if (!res.writableEnded) res.end();
        // Same policy as `end`, including the statusCode check and any usage frames
        // that did arrive before the socket failed. `deducted` inside settleStream
        // guards against double-settling if both events fire.
        settleStream('stream error', true);
      });

      // Publish the settle so `proxyReq.on('error')` can call it. A socket that dies
      // mid-response fires BOTH `proxyRes.on('error')` and `proxyReq.on('error')`,
      // and they used to implement different outcomes — worst-case billing vs. a
      // full refund — so the price a buyer paid for an aborted stream depended on
      // which listener Node happened to reach first. Same event, two prices.
      settleActiveStream = settleStream;
    } else {
      // Non-streaming: read full response, adjust reservation, then send
      let chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      let settled = false;
      proxyRes.on('error', (err) => {
        console.error(`[PROXY] Upstream response error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json', 'X-J41-Request-Id': requestId });
          res.end(JSON.stringify({ error: 'Upstream response interrupted' }));
        }
        if (!settled) {
          settled = true;
          refundOnce();
          releaseOnce();
        }
      });
      proxyRes.on('end', () => {
        if (settled) return;
        settled = true;
        // Billing has happened; no later handler may hand the reservation back.
        _refunded = true;
        const responseBody = Buffer.concat(chunks);
        let inputTok = estimatedInput;
        let outputTok = estimatedOutput;

        // `sawOutputNS` tracks a finite completion_tokens SPECIFICALLY, not "a usage
        // object was present". Two reasons:
        //   • `||` treated a legitimate 0 as absent, so an upstream that genuinely
        //     produced no output (a refusal, an empty choices array) billed the flat
        //     ~2000-token estimate. The streaming path already used Number.isFinite;
        //     this one never got the same treatment.
        //   • `{usage: {prompt_tokens: 900}}` with no completion_tokens set the old
        //     sawUsage flag and so escaped the worst-case settle below — the exact
        //     hole that settle exists to close, reachable by omitting one field.
        let sawOutputNS = false;
        try {
          const parsed = JSON.parse(responseBody.toString());
          if (parsed && parsed.usage && typeof parsed.usage === 'object') {
            if (Number.isFinite(parsed.usage.prompt_tokens)) inputTok = parsed.usage.prompt_tokens;
            if (Number.isFinite(parsed.usage.completion_tokens)) {
              outputTok = parsed.usage.completion_tokens;
              sawOutputNS = true;
            }
          }
        } catch {}

        // M2 — this path never received the hardening the streaming path did, and it
        // is wrong in BOTH directions:
        //   • an upstream that omits usage was billed a flat `estimatedOutput`
        //     (~2000 tokens) regardless of how much it actually returned — a buyer
        //     just sets `stream:false` to get cheap unmetered output; and
        //   • an ERROR response was billed the same estimate, so the buyer paid for a
        //     503 exactly as the streaming path did.
        const _okNS = proxyRes.statusCode >= 200 && proxyRes.statusCode < 300;
        if (!_okNS) {
          inputTok = 0;
          outputTok = 0;
          console.warn(`[proxy] upstream ${proxyRes.statusCode} — not billing (job ${key ? String(key).slice(0, 8) : '?'})`);
        } else if (!sawOutputNS) {
          // Mirror the streaming defence: settle against the declared worst case so a
          // non-compliant upstream cannot serve a large completion for a flat estimate.
          outputTok = reserveOutput;
        }

        const result = adjustCredit(agentId, record.buyerVerusId, model, inputTok, outputTok, creditCheck.reserved, config.modelPricing || []);
        recordUsage(agentId, key, inputTok, outputTok);
        releaseOnce();

        j41Headers['X-J41-Credit-Remaining'] = result.remaining.toFixed(4);
        if (result.remaining < 1) {
          j41Headers['X-J41-Credit-SuggestedTopup'] = String(cfg.proxy.suggested_topup_vrsc);
          j41Headers['X-J41-Seller-PayAddress'] = config.payAddress || '';
        }

        const safeHeaders = filterHeaders(proxyRes.headers);
        res.writeHead(proxyRes.statusCode, { ...safeHeaders, ...j41Headers });
        res.end(responseBody);

        maybeNotifyCreditLow(agentId, record.buyerVerusId, result.remaining, cfg, config);
        console.log(`[PROXY] ${agentId} ${model} ${inputTok}+${outputTok} tok, cost ${result.cost.toFixed(6)} VRSC, remaining ${result.remaining.toFixed(4)}`);
      });
    }
  });

  proxyReq.on('error', (err) => {
    // Always free the in-flight slot, even if the response already started
    // streaming (releaseOnce is idempotent). Only refund/respond when the
    // request never produced a (billable) response.
    if (res.headersSent || res.writableEnded) {
      // A streaming response was already in flight. A socket that dies mid-response
      // fires this AND `proxyRes.on('error')`, and the two used to disagree — this
      // one refunded in full, that one billed the worst case — so an aborted stream
      // cost the buyer either nothing or the entire `max_tokens` reservation
      // depending on which listener Node reached first. Route both through the one
      // settle; `deducted` makes the second call a no-op.
      if (settleActiveStream) settleActiveStream('request error', true);
      releaseOnce();
      return;
    }
    console.error(`[PROXY] Upstream error: ${err.message}`);
    refundOnce();
    releaseOnce();
    res.writeHead(502, { 'Content-Type': 'application/json', 'X-J41-Request-Id': requestId });
    res.end(JSON.stringify({ error: 'Upstream endpoint unavailable' }));
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (res.headersSent || res.writableEnded) { releaseOnce(); return; }
    refundOnce();
    releaseOnce();
    res.writeHead(504, { 'Content-Type': 'application/json', 'X-J41-Request-Id': requestId });
    res.end(JSON.stringify({ error: 'Upstream endpoint timed out' }));
  });

  proxyReq.write(forwardBody);
  proxyReq.end();
}

module.exports = { handleProxyRequest, maybeNotifyCreditLow, resolveCreditLowThreshold, isPrivateIp };
