/**
 * API Proxy Handler — forwards buyer requests to seller's backend.
 * Validates API keys, checks credit, meters usage, adds J41 headers.
 * Supports both streaming (SSE) and non-streaming responses.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { findKeyOwner, recordUsage } = require('./api-key-manager');
const { checkCredit, deductCredit } = require('./credit-meter');

/**
 * Handle a proxied API request.
 *
 * @param req - Incoming HTTP request
 * @param res - Outgoing HTTP response
 * @param agentConfigs - Map<agentId, { endpointUrl, modelPricing, rateLimits, identity, iAddress }>
 * @param body - Parsed request body string
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

  // Check credit
  const estimatedInput = 4000; // rough estimate for pre-check
  const estimatedOutput = 2000;
  const creditCheck = checkCredit(agentId, record.buyerVerusId, model, estimatedInput, estimatedOutput, config.modelPricing || []);
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

  // Build upstream URL
  // Request path after /j41/proxy/ is forwarded as-is
  const upstreamPath = req.url.replace(/^\/j41\/proxy/, '');
  const upstreamUrl = new URL(upstreamPath, config.endpointUrl);

  // Forward request to seller's backend
  const isHttps = upstreamUrl.protocol === 'https:';
  const transport = isHttps ? https : http;

  const proxyReq = transport.request(upstreamUrl.href, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'j41-proxy/1.0',
      // Don't forward buyer's auth — use seller's own auth if configured
      ...(config.upstreamAuth ? { 'Authorization': config.upstreamAuth } : {}),
    },
    timeout: 60000,
  }, (proxyRes) => {
    // Add J41 headers
    const j41Headers = {
      'X-J41-Request-Id': requestId,
      'X-J41-Session': `${record.buyerVerusId}:${requestId}`,
      'X-J41-Model': model,
    };

    if (isStreaming) {
      // Stream response through, count tokens at the end
      res.writeHead(proxyRes.statusCode, {
        ...proxyRes.headers,
        ...j41Headers,
      });

      let fullResponse = '';
      proxyRes.on('data', (chunk) => {
        fullResponse += chunk.toString();
        res.write(chunk);
      });

      proxyRes.on('end', () => {
        res.end();

        // Parse SSE chunks for usage data
        const usageMatch = fullResponse.match(/"usage"\s*:\s*(\{[^}]+\})/);
        if (usageMatch) {
          try {
            const usage = JSON.parse(usageMatch[1]);
            const inputTok = usage.prompt_tokens || 0;
            const outputTok = usage.completion_tokens || 0;
            const result = deductCredit(agentId, record.buyerVerusId, model, inputTok, outputTok, config.modelPricing || []);
            recordUsage(agentId, key, inputTok, outputTok);
            console.log(`[PROXY] ${agentId} ${model} ${inputTok}+${outputTok} tok, cost ${result.cost.toFixed(6)} VRSC, remaining ${result.remaining.toFixed(4)}`);
          } catch {}
        }
      });
    } else {
      // Non-streaming: read full response, meter, then send
      let chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const responseBody = Buffer.concat(chunks);
        let inputTok = 0;
        let outputTok = 0;

        try {
          const parsed = JSON.parse(responseBody.toString());
          if (parsed.usage) {
            inputTok = parsed.usage.prompt_tokens || 0;
            outputTok = parsed.usage.completion_tokens || 0;
          }
        } catch {}

        const result = deductCredit(agentId, record.buyerVerusId, model, inputTok, outputTok, config.modelPricing || []);
        recordUsage(agentId, key, inputTok, outputTok);

        j41Headers['X-J41-Credit-Remaining'] = result.remaining.toFixed(4);
        if (result.remaining < 1) {
          j41Headers['X-J41-Credit-SuggestedTopup'] = '10';
          j41Headers['X-J41-Seller-PayAddress'] = config.payAddress || '';
        }

        res.writeHead(proxyRes.statusCode, {
          ...proxyRes.headers,
          ...j41Headers,
        });
        res.end(responseBody);

        console.log(`[PROXY] ${agentId} ${model} ${inputTok}+${outputTok} tok, cost ${result.cost.toFixed(6)} VRSC, remaining ${result.remaining.toFixed(4)}`);
      });
    }
  });

  proxyReq.on('error', (err) => {
    console.error(`[PROXY] Upstream error: ${err.message}`);
    res.writeHead(502, { 'Content-Type': 'application/json', ...{ 'X-J41-Request-Id': requestId } });
    res.end(JSON.stringify({ error: 'Upstream endpoint unavailable', detail: err.message }));
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.writeHead(504, { 'Content-Type': 'application/json', ...{ 'X-J41-Request-Id': requestId } });
    res.end(JSON.stringify({ error: 'Upstream endpoint timed out' }));
  });

  proxyReq.write(body);
  proxyReq.end();
}

module.exports = { handleProxyRequest };
