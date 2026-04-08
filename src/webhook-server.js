/**
 * Minimal webhook HTTP server for receiving J41 platform events.
 * Uses Node's built-in http module — no Express dependency.
 *
 * Each agent gets a unique webhook path: /webhook/:agentId
 * This allows O(1) secret lookup instead of iterating all secrets.
 */

const http = require('http');
const { verifyWebhookSignature } = require('@junction41/sovagent-sdk/dist/webhook/verify.js');

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

/**
 * Start a webhook server that verifies HMAC signatures and routes events.
 *
 * @param {number} port - Port to listen on
 * @param {Map<string, {secret: string, identity: string}>} agentWebhooks - agentId -> {secret, identity}
 * @param {(agentId: string, payload: object) => Promise<void>} onEvent - Event handler
 * @returns {http.Server} The running server
 */
function startWebhookServer(port, agentWebhooks, onEvent) {
  const server = http.createServer(async (req, res) => {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', agents: agentWebhooks.size }));
      return;
    }

    // Accept POST /webhook/:agentId
    if (req.method !== 'POST' || !req.url?.startsWith('/webhook/')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    // Extract agent ID from URL path
    const urlParts = req.url.split('/');
    const agentId = urlParts[2]; // /webhook/:agentId
    // M10: Validate format — must match expected agent ID pattern
    if (!agentId || !/^agent-[1-9][0-9]*$/.test(agentId)) {
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

module.exports = { startWebhookServer };
