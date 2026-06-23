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
      // Stream response through, count tokens at the end
      const safeHeaders = filterHeaders(proxyRes.headers);
      res.writeHead(proxyRes.statusCode, { ...safeHeaders, ...j41Headers });

      let fullResponse = '';
      let deducted = false;

      proxyRes.on('data', (chunk) => {
        if (res.writableEnded) return;
        fullResponse += chunk.toString();
        res.write(chunk);
      });

      proxyRes.on('end', () => {
        if (!res.writableEnded) res.end();

        // Parse SSE chunks for usage data — scan each `data: {...}` frame with JSON.parse
        // so nested objects like completion_tokens_details survive (the old regex broke on them).
        let inputTok = estimatedInput;
        let outputTok = estimatedOutput;
        let sawUsage = false;
        for (const line of fullResponse.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const json = line.slice(5).trim();
          if (!json || json === '[DONE]') continue;
          try {
            const frame = JSON.parse(json);
            if (frame && frame.usage && typeof frame.usage === 'object') {
              if (Number.isFinite(frame.usage.prompt_tokens)) { inputTok = frame.usage.prompt_tokens; sawUsage = true; }
              if (Number.isFinite(frame.usage.completion_tokens)) { outputTok = frame.usage.completion_tokens; sawUsage = true; }
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
        if (!sawUsage) {
          outputTok = reserveOutput;
        }

        // Adjust reservation with actual token counts (or worst case if usage absent)
        if (!deducted) {
          deducted = true;
          const result = adjustCredit(agentId, record.buyerVerusId, model, inputTok, outputTok, creditCheck.reserved, config.modelPricing || []);
          recordUsage(agentId, key, inputTok, outputTok);
          releaseOnce();
          maybeNotifyCreditLow(agentId, record.buyerVerusId, result.remaining, cfg, config);
          console.log(`[PROXY] ${agentId} ${model} ${inputTok}+${outputTok} tok, cost ${result.cost.toFixed(6)} VRSC, remaining ${result.remaining.toFixed(4)}`);
        }
      });

      proxyRes.on('error', () => {
        if (!res.writableEnded) res.end();
        // Settle defensively at the worst case so a mid-stream abort after the
        // upstream already served output can't escape billing. Guard with
        // `deducted` so we don't double-settle if 'end' also fires.
        if (!deducted) {
          deducted = true;
          adjustCredit(agentId, record.buyerVerusId, model, estimatedInput, reserveOutput, creditCheck.reserved, config.modelPricing || []);
          releaseOnce();
        }
      });
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
          refundReservation(agentId, record.buyerVerusId, creditCheck.reserved);
          releaseOnce();
        }
      });
      proxyRes.on('end', () => {
        if (settled) return;
        settled = true;
        const responseBody = Buffer.concat(chunks);
        let inputTok = estimatedInput;
        let outputTok = estimatedOutput;

        try {
          const parsed = JSON.parse(responseBody.toString());
          if (parsed.usage) {
            inputTok = parsed.usage.prompt_tokens || estimatedInput;
            outputTok = parsed.usage.completion_tokens || estimatedOutput;
          }
        } catch {}

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
    if (res.headersSent || res.writableEnded) { releaseOnce(); return; }
    console.error(`[PROXY] Upstream error: ${err.message}`);
    refundReservation(agentId, record.buyerVerusId, creditCheck.reserved);
    releaseOnce();
    res.writeHead(502, { 'Content-Type': 'application/json', 'X-J41-Request-Id': requestId });
    res.end(JSON.stringify({ error: 'Upstream endpoint unavailable' }));
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (res.headersSent || res.writableEnded) { releaseOnce(); return; }
    refundReservation(agentId, record.buyerVerusId, creditCheck.reserved);
    releaseOnce();
    res.writeHead(504, { 'Content-Type': 'application/json', 'X-J41-Request-Id': requestId });
    res.end(JSON.stringify({ error: 'Upstream endpoint timed out' }));
  });

  proxyReq.write(forwardBody);
  proxyReq.end();
}

module.exports = { handleProxyRequest, maybeNotifyCreditLow, resolveCreditLowThreshold, isPrivateIp };
