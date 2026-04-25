/**
 * Minimal webhook HTTP server for receiving J41 platform events.
 * Uses Node's built-in http module — no Express dependency.
 *
 * Each agent gets a unique webhook path: /webhook/:agentId
 * This allows O(1) secret lookup instead of iterating all secrets.
 */

const http = require('http');
const { verifyWebhookSignature } = require('@junction41/sovagent-sdk/dist/webhook/verify.js');
const { handleProxyRequest } = require('./proxy-handler.js');
const { reportDeposit } = require('./deposit-watcher.js');
const { loadDispatcherConfig } = require('./config-loader.js');

const MAX_BODY_SIZE = loadDispatcherConfig().webhook.max_body_bytes;

/** Read request body with size limit. Returns string or null (error already sent). */
async function readBody(req, res) {
  const chunks = [];
  let size = 0;
  try {
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_SIZE) { reject(new Error('too large')); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', resolve);
      req.on('error', reject);
    });
  } catch {
    res.writeHead(413);
    res.end('Payload too large');
    return null;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Start a webhook server that verifies HMAC signatures and routes events.
 * Also handles API proxy routes (/j41/discovery, /j41/proxy).
 *
 * @param {number} port - Port to listen on
 * @param {Map<string, {secret: string, identity: string}>} agentWebhooks - agentId -> {secret, identity}
 * @param {(agentId: string, payload: object) => Promise<void>} onEvent - Event handler
 * @param {object} [proxyContext] - API proxy context (if api-endpoint agents exist)
 * @param {Map<string, object>} [proxyContext.agentConfigs] - agentId -> { endpointUrl, modelPricing, ... }
 * @param {Function} [proxyContext.onAccessRequest] - Handler for /j41/discovery/request-access
 * @returns {http.Server} The running server
 */
function startWebhookServer(port, agentWebhooks, onEvent, proxyContext) {
  const server = http.createServer(async (req, res) => {
    // Health check
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/j41/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: 'dispatcher',
        version: require('../package.json').version,
        status: 'ok',
        agents: agentWebhooks.size,
        proxy: !!proxyContext,
      }));
      return;
    }

    // ── API Proxy Routes ──

    // POST /j41/discovery/request-access — ECDH key exchange
    if (req.method === 'POST' && req.url === '/j41/discovery/request-access' && proxyContext?.onAccessRequest) {
      const body = await readBody(req, res);
      if (body === null) return; // readBody already sent error response
      try {
        const accessRequest = JSON.parse(body);
        const envelope = await proxyContext.onAccessRequest(accessRequest);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(envelope));
      } catch (e) {
        console.error(`[Discovery] Access request failed: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Access request failed' }));
      }
      return;
    }

    // POST /j41/deposit/report — buyer reports a deposit txid
    if (req.method === 'POST' && req.url === '/j41/deposit/report' && proxyContext) {
      const body = await readBody(req, res);
      if (body === null) return;
      try {
        const { buyerVerusId, sellerVerusId, txid, amount } = JSON.parse(body);
        if (!buyerVerusId || !txid || !amount) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing buyerVerusId, txid, or amount' }));
          return;
        }
        const result = await proxyContext.onDepositReport({ buyerVerusId, sellerVerusId, txid, amount });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        console.error(`[Deposit] Report failed: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Deposit report failed' }));
      }
      return;
    }

    // POST /j41/proxy/v1/* — forwarded API requests
    if (req.method === 'POST' && req.url?.startsWith('/j41/proxy/') && proxyContext?.agentConfigs) {
      const body = await readBody(req, res);
      if (body === null) return;
      try {
        await handleProxyRequest(req, res, proxyContext.agentConfigs, body);
      } catch (e) {
        console.error(`[Proxy] Request failed: ${e.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal proxy error' }));
        }
      }
      return;
    }

    // ── Webhook Routes ──

    // Accept POST /webhook/:agentId
    if (req.method !== 'POST' || !req.url?.startsWith('/webhook/')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    // Extract agent ID from URL path
    const urlParts = req.url.split('/');
    const agentId = urlParts[2]; // /webhook/:agentId
    if (!agentId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(agentId) || agentId.includes('..')) {
      res.writeHead(400);
      res.end('Invalid agent ID');
      return;
    }
    if (!agentWebhooks.has(agentId)) {
      res.writeHead(404);
      res.end('Unknown agent');
      return;
    }

    // Read body with size limit
    const chunks = [];
    let size = 0;

    try {
      await new Promise((resolve, reject) => {
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_SIZE) {
            reject(new Error('Payload too large'));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', resolve);
        req.on('error', reject);
      });
    } catch (e) {
      res.writeHead(413);
      res.end('Payload too large');
      return;
    }

    const rawBody = Buffer.concat(chunks);
    const signature = req.headers['x-webhook-signature'] || '';

    if (!signature) {
      res.writeHead(401);
      res.end('Missing signature');
      return;
    }

    // O(1) lookup — verify against this agent's secret only
    const config = agentWebhooks.get(agentId);
    if (!verifyWebhookSignature(rawBody, signature, config.secret)) {
      res.writeHead(401);
      res.end('Invalid signature');
      return;
    }

    // Parse payload
    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (e) {
      res.writeHead(400);
      res.end('Invalid JSON');
      return;
    }

    // Respond immediately, process async
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ received: true }));

    // Handle event asynchronously
    try {
      await onEvent(agentId, payload);
    } catch (e) {
      console.error(`[Webhook] Event handler error for ${agentId}:`, e.message);
    }
  });

  server.listen(port, () => {
    console.log(`[Webhook] Server listening on port ${port}`);
  });

  return server;
}

module.exports = { startWebhookServer, readBody };
