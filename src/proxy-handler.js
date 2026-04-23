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
const { reserveCredit, adjustCredit, refundReservation } = require('./credit-meter');

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
    if (lo === '::1' || lo === '::') return true;
    if (lo.startsWith('fe80:') || lo.startsWith('fc') || lo.startsWith('fd')) return true;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d)
    const m = lo.match(/^::ffff:([0-9.]+)$/);
    if (m && isPrivateIp(m[1])) return true;
    return false;
  }
  return false;
}

async function checkUpstreamHostSafe(hostname) {
  if (process.env.J41_ALLOW_LOCAL_UPSTREAM === '1') return { safe: true };
  const lc = hostname.toLowerCase();
  if (lc === 'localhost' || lc.endsWith('.localhost') || lc.endsWith('.local') || lc.endsWith('.internal')) {
    return { safe: false, reason: `hostname "${hostname}" is a local/internal name` };
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) return { safe: false, reason: `upstream IP ${hostname} is private/loopback/link-local` };
    return { safe: true };
  }
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    for (const a of addrs) {
      if (isPrivateIp(a.address)) {
        return { safe: false, reason: `hostname ${hostname} resolves to private address ${a.address}` };
      }
    }
  } catch (e) {
    return { safe: false, reason: `DNS lookup failed for ${hostname}: ${e.message}` };
  }
  return { safe: true };
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

  // Reserve credit atomically (deducts upfront, adjusted after response)
  const estimatedInput = 4000;
  const estimatedOutput = 2000;
  const creditCheck = reserveCredit(agentId, record.buyerVerusId, model, estimatedInput, estimatedOutput, config.modelPricing || []);
  if (!creditCheck.allowed) {
    res.writeHead(402, {
      'Content-Type': 'application/json',
      'X-J41-Credit-Remaining': '0',
      'X-J41-Credit-SuggestedTopup': '10',
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
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request path' }));
    return;
  }

  // SSRF check: resolved hostname must match configured endpoint
  const configuredHost = new URL(config.endpointUrl).hostname;
  if (upstreamUrl.hostname !== configuredHost) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Request path resolves to unauthorized host' }));
    return;
  }

  // SSRF hardening: block private IPs unless J41_ALLOW_LOCAL_UPSTREAM=1 (dev)
  const safety = await checkUpstreamHostSafe(upstreamUrl.hostname);
  if (!safety.safe) {
    refundReservation(agentId, record.buyerVerusId, creditCheck.reserved);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Upstream blocked: ${safety.reason}` }));
    return;
  }

  // Forward request to seller's backend
  const isHttps = upstreamUrl.protocol === 'https:';
  const transport = isHttps ? https : http;

  const proxyReq = transport.request(upstreamUrl.href, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'j41-proxy/1.0',
      ...(config.upstreamAuth ? { 'Authorization': config.upstreamAuth } : {}),
    },
    timeout: 60000,
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
        for (const line of fullResponse.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const json = line.slice(5).trim();
          if (!json || json === '[DONE]') continue;
          try {
            const frame = JSON.parse(json);
            if (frame && frame.usage && typeof frame.usage === 'object') {
              if (Number.isFinite(frame.usage.prompt_tokens)) inputTok = frame.usage.prompt_tokens;
              if (Number.isFinite(frame.usage.completion_tokens)) outputTok = frame.usage.completion_tokens;
            }
          } catch {
            // Malformed frame — skip. Upstream may send keep-alive comments starting with `:` too.
          }
        }

        // Adjust reservation with actual token counts (or estimates if usage absent)
        if (!deducted) {
          deducted = true;
          const result = adjustCredit(agentId, record.buyerVerusId, model, inputTok, outputTok, creditCheck.reserved, config.modelPricing || []);
          recordUsage(agentId, key, inputTok, outputTok);
          console.log(`[PROXY] ${agentId} ${model} ${inputTok}+${outputTok} tok, cost ${result.cost.toFixed(6)} VRSC, remaining ${result.remaining.toFixed(4)}`);
        }
      });

      proxyRes.on('error', () => {
        if (!res.writableEnded) res.end();
      });
    } else {
      // Non-streaming: read full response, adjust reservation, then send
      let chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('error', (err) => {
        console.error(`[PROXY] Upstream response error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json', 'X-J41-Request-Id': requestId });
          res.end(JSON.stringify({ error: 'Upstream response interrupted' }));
        }
        refundReservation(agentId, record.buyerVerusId, creditCheck.reserved);
      });
      proxyRes.on('end', () => {
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

        j41Headers['X-J41-Credit-Remaining'] = result.remaining.toFixed(4);
        if (result.remaining < 1) {
          j41Headers['X-J41-Credit-SuggestedTopup'] = '10';
          j41Headers['X-J41-Seller-PayAddress'] = config.payAddress || '';
        }

        const safeHeaders = filterHeaders(proxyRes.headers);
        res.writeHead(proxyRes.statusCode, { ...safeHeaders, ...j41Headers });
        res.end(responseBody);

        console.log(`[PROXY] ${agentId} ${model} ${inputTok}+${outputTok} tok, cost ${result.cost.toFixed(6)} VRSC, remaining ${result.remaining.toFixed(4)}`);
      });
    }
  });

  proxyReq.on('error', (err) => {
    if (res.headersSent || res.writableEnded) return;
    console.error(`[PROXY] Upstream error: ${err.message}`);
    refundReservation(agentId, record.buyerVerusId, creditCheck.reserved);
    res.writeHead(502, { 'Content-Type': 'application/json', 'X-J41-Request-Id': requestId });
    res.end(JSON.stringify({ error: 'Upstream endpoint unavailable' }));
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (res.headersSent || res.writableEnded) return;
    refundReservation(agentId, record.buyerVerusId, creditCheck.reserved);
    res.writeHead(504, { 'Content-Type': 'application/json', 'X-J41-Request-Id': requestId });
    res.end(JSON.stringify({ error: 'Upstream endpoint timed out' }));
  });

  proxyReq.write(body);
  proxyReq.end();
}

module.exports = { handleProxyRequest };
