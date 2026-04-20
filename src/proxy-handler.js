/**
 * API Proxy Handler — forwards buyer requests to seller's backend.
 * Validates API keys, checks credit, meters usage, adds J41 headers.
 * Supports both streaming (SSE) and non-streaming responses.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { findKeyOwner, recordUsage } = require('./api-key-manager');
const { reserveCredit, adjustCredit, refundReservation } = require('./credit-meter');

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

        // Parse SSE chunks for usage data
        let inputTok = estimatedInput; // fallback to estimates
        let outputTok = estimatedOutput;
        const usageMatch = fullResponse.match(/"usage"\s*:\s*(\{[^}]*"prompt_tokens"[^}]*\})/);
        if (usageMatch) {
          try {
            const usage = JSON.parse(usageMatch[1]);
            inputTok = usage.prompt_tokens || estimatedInput;
            outputTok = usage.completion_tokens || estimatedOutput;
          } catch {}
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
