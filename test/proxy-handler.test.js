'use strict';
/**
 * Proxy-handler money-path tests (audit H3 + H2).
 *
 *  H3 — worst-case reservation: a request declaring max_tokens:100000 must
 *       reserve against that max (refused if balance can't cover it), and a
 *       per-buyer in-flight concurrency cap must 429 past the limit.
 *  H2 — streaming under-billing: stream:true must inject
 *       stream_options.include_usage=true; if a streaming response still
 *       produces NO usage frame, the settle must charge max_tokens (worst case),
 *       not the flat estimate.
 *
 * Runs against a real loopback mock upstream. HOME is sandboxed and the SSRF
 * private-IP guard is disabled (J41_ALLOW_LOCAL_UPSTREAM) so 127.0.0.1 upstreams
 * are permitted in-test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Sandbox HOME + allow loopback upstream BEFORE requiring app modules.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-proxy-test-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
process.env.J41_ALLOW_LOCAL_UPSTREAM = '1';
// Tight, deterministic knobs for the test.
process.env.J41_PROXY_ESTIMATED_INPUT = '4000';
process.env.J41_PROXY_ESTIMATED_OUTPUT = '2000';
process.env.J41_PROXY_MAX_OUTPUT_TOKENS_CAP = '200000';
process.env.J41_PROXY_MAX_INFLIGHT_PER_BUYER = '2';

const { mintApiKey } = require('../src/api-key-manager.js');
const { creditDeposit, getBalance, calculateCost } = require('../src/credit-meter.js');
const { handleProxyRequest } = require('../src/proxy-handler.js');
const inflight = require('../src/proxy-inflight.js');

const MODEL = 'gpt-4';
// Pricing chosen so the numbers are easy: output dominates.
const PRICING = [{ model: MODEL, inputTokenRate: 0.000001, outputTokenRate: 0.0001 }];

// --- mock upstream control ---
let upstream;           // http.Server
let upstreamPort;       // number
let upstreamMode;       // 'json' | 'stream-no-usage' | 'stream-with-usage' | 'echo'
let lastUpstreamBody;   // raw body string the upstream received

function startUpstream() {
  return new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        lastUpstreamBody = body;
        if (upstreamMode === 'json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{ message: { content: 'hi' } }],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          }));
        } else if (upstreamMode === 'stream-with-usage') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
          res.write('data: {"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else if (upstreamMode === 'stream-503') {
          // Upstream is down. No usage frame — same as a non-compliant upstream, but
          // the buyer received nothing. M1.
          res.writeHead(503, { 'Content-Type': 'text/event-stream' });
          res.end('data: {"error":"upstream unavailable"}\n\n');
        } else if (upstreamMode === 'json-503') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end('{"error":"upstream unavailable"}');
        } else if (upstreamMode === 'stream-no-usage') {
          // Upstream ignores include_usage → never emits a usage frame.
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        }
      });
    });
    upstream.listen(0, '127.0.0.1', () => {
      upstreamPort = upstream.address().port;
      resolve();
    });
  });
}

function agentConfigsFor(agentId) {
  const m = new Map();
  m.set(agentId, {
    endpointUrl: `http://127.0.0.1:${upstreamPort}`,
    modelPricing: PRICING,
    payAddress: 'RpayAddr',
  });
  return m;
}

// Minimal mock req/res that drives handleProxyRequest and resolves when done.
function runProxy(agentId, key, bodyObj) {
  return new Promise((resolve) => {
    const body = JSON.stringify(bodyObj);
    const req = {
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      url: '/j41/proxy/v1/chat/completions',
      method: 'POST',
    };
    const chunks = [];
    let statusCode = 0;
    let headers = {};
    const res = {
      headersSent: false,
      writableEnded: false,
      writeHead(code, hdrs) { statusCode = code; headers = hdrs || {}; this.headersSent = true; },
      write(c) { chunks.push(Buffer.from(c)); },
      end(c) {
        if (c) chunks.push(Buffer.from(c));
        this.writableEnded = true;
        resolve({ statusCode, headers, body: Buffer.concat(chunks).toString() });
      },
    };
    handleProxyRequest(req, res, agentConfigsFor(agentId), body);
  });
}

test.before(async () => { await startUpstream(); });
test.after(() => { upstream && upstream.close(); });

// ── H3: worst-case reservation ──────────────────────────────────────────────

test('H3: max_tokens:100000 is refused when balance covers only the flat estimate', async () => {
  inflight._reset();
  upstreamMode = 'json';
  const agentId = 'agent-h3-refuse';
  const buyer = 'iBuyerH3Refuse';
  const key = mintApiKey(agentId, buyer).key;
  // Fund EXACTLY the flat-estimate cost (4000 in + 2000 out) — enough for the
  // old flat reservation, NOT enough for a 100000-token worst case.
  const flatCost = calculateCost(PRICING, MODEL, 4000, 2000);
  creditDeposit(agentId, buyer, flatCost, 'tx-h3-refuse');

  const r = await runProxy(agentId, key, { model: MODEL, max_tokens: 100000, messages: [] });
  assert.equal(r.statusCode, 402, `should be refused (402), got ${r.statusCode}: ${r.body}`);
  // Balance untouched (reservation refused, nothing deducted).
  assert.ok(Math.abs(getBalance(agentId, buyer) - flatCost) < 1e-12);
});

test('H3: max_tokens:100000 is admitted when balance covers the worst case', async () => {
  inflight._reset();
  upstreamMode = 'json';
  const agentId = 'agent-h3-admit';
  const buyer = 'iBuyerH3Admit';
  const key = mintApiKey(agentId, buyer).key;
  // Fund the worst case: 4000 in + 100000 out.
  const worst = calculateCost(PRICING, MODEL, 4000, 100000);
  creditDeposit(agentId, buyer, worst, 'tx-h3-admit');

  const r = await runProxy(agentId, key, { model: MODEL, max_tokens: 100000, messages: [] });
  assert.equal(r.statusCode, 200, `should be admitted (200), got ${r.statusCode}: ${r.body}`);
  // Settles down to actual usage (10 in + 20 out from the json mock).
  const actual = calculateCost(PRICING, MODEL, 10, 20);
  assert.ok(Math.abs(getBalance(agentId, buyer) - (worst - actual)) < 1e-9,
    `balance should refund down to actual; got ${getBalance(agentId, buyer)}`);
});

test('H3: per-buyer in-flight cap returns 429 past the limit', async () => {
  inflight._reset();
  const agentId = 'agent-h3-conc';
  const buyer = 'iBuyerH3Conc';
  const cap = 2; // matches J41_PROXY_MAX_INFLIGHT_PER_BUYER above
  // Pre-occupy the cap with phantom in-flight slots so the next real request 429s.
  for (let i = 0; i < cap; i++) assert.equal(inflight.acquire(agentId, buyer, cap), true);

  const key = mintApiKey(agentId, buyer).key;
  creditDeposit(agentId, buyer, 1000, 'tx-h3-conc');
  const r = await runProxy(agentId, key, { model: MODEL, max_tokens: 100, messages: [] });
  assert.equal(r.statusCode, 429, `should be 429 past in-flight cap, got ${r.statusCode}: ${r.body}`);
});

test('H3: in-flight slot is released after a normal request (finally)', async () => {
  inflight._reset();
  upstreamMode = 'json';
  const agentId = 'agent-h3-release';
  const buyer = 'iBuyerH3Release';
  const key = mintApiKey(agentId, buyer).key;
  creditDeposit(agentId, buyer, 1000, 'tx-h3-release');
  const r = await runProxy(agentId, key, { model: MODEL, max_tokens: 50, messages: [] });
  assert.equal(r.statusCode, 200);
  // Give the streaming/non-streaming end handlers a tick to run their finally.
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(inflight._count(agentId, buyer), 0, 'in-flight slot must be released');
});

// ── H2: streaming under-billing ──────────────────────────────────────────────

test('H2: stream:true injects stream_options.include_usage=true into the forwarded body', async () => {
  inflight._reset();
  upstreamMode = 'stream-with-usage';
  const agentId = 'agent-h2-inject';
  const buyer = 'iBuyerH2Inject';
  const key = mintApiKey(agentId, buyer).key;
  creditDeposit(agentId, buyer, 1000, 'tx-h2-inject');
  await runProxy(agentId, key, { model: MODEL, stream: true, max_tokens: 100, messages: [] });
  // Give end handler a tick.
  await new Promise((res) => setTimeout(res, 50));
  const fwd = JSON.parse(lastUpstreamBody);
  assert.equal(fwd.stream, true);
  assert.ok(fwd.stream_options && fwd.stream_options.include_usage === true,
    `forwarded body must carry stream_options.include_usage=true; got ${lastUpstreamBody}`);
});

test('H2: missing-usage streaming settle charges max_tokens, not the flat estimate', async () => {
  inflight._reset();
  upstreamMode = 'stream-no-usage';
  const agentId = 'agent-h2-noUsage';
  const buyer = 'iBuyerH2NoUsage';
  const key = mintApiKey(agentId, buyer).key;
  const maxTokens = 50000;
  // Fund the worst case so the request is admitted.
  const worst = calculateCost(PRICING, MODEL, 4000, maxTokens);
  creditDeposit(agentId, buyer, worst, 'tx-h2-noUsage');

  await runProxy(agentId, key, { model: MODEL, stream: true, max_tokens: maxTokens, messages: [] });
  await new Promise((res) => setTimeout(res, 50));

  // No usage frame → must settle against max_tokens (worst case), NOT the 2000
  // flat estimate. So the charge equals the worst-case output cost, and the
  // remaining balance should be ~0 (worst-case reserved, worst-case settled).
  const flatCharge = calculateCost(PRICING, MODEL, 4000, 2000);
  const remaining = getBalance(agentId, buyer);
  // If it had charged the flat estimate, remaining would be worst - flatCharge (large).
  assert.ok(remaining < flatCharge,
    `missing-usage stream must NOT settle at the flat estimate; remaining=${remaining}, flatCharge=${flatCharge}`);
  // And it must equal the worst-case settle (input falls back to estimate, output = max_tokens).
  const worstCharge = calculateCost(PRICING, MODEL, 4000, maxTokens);
  assert.ok(Math.abs(remaining - (worst - worstCharge)) < 1e-9,
    `should settle at worst case; remaining=${remaining}`);
});

test('H2: streaming WITH a usage frame still settles on actual usage', async () => {
  inflight._reset();
  upstreamMode = 'stream-with-usage';
  const agentId = 'agent-h2-withUsage';
  const buyer = 'iBuyerH2WithUsage';
  const key = mintApiKey(agentId, buyer).key;
  const maxTokens = 50000;
  const worst = calculateCost(PRICING, MODEL, 4000, maxTokens);
  creditDeposit(agentId, buyer, worst, 'tx-h2-withUsage');

  await runProxy(agentId, key, { model: MODEL, stream: true, max_tokens: maxTokens, messages: [] });
  await new Promise((res) => setTimeout(res, 50));

  // Usage frame says 10 in / 20 out → settle on that, refunding the worst case.
  const actual = calculateCost(PRICING, MODEL, 10, 20);
  assert.ok(Math.abs(getBalance(agentId, buyer) - (worst - actual)) < 1e-9,
    `should settle on the actual usage frame; got ${getBalance(agentId, buyer)}`);
});

// ── M1/M2: an upstream ERROR must not be billed ─────────────────────────────
//
// The worst-case settle is the right defence against an upstream that returns real
// output without a usage frame. But `proxyRes.statusCode` was never consulted before
// billing, and a 503 has no usage frame either — so a buyer sending
// `stream:true, max_tokens:200000` was charged the full ~204,000-token reservation for
// an error page. proxyReq.on('error') does not fire (the connection succeeded), and the
// circuit breaker only opens after N consecutive failures, so the first N bill in full.

test('M1: a streaming upstream 503 bills NOTHING — not the worst-case reservation', async () => {
  inflight._reset();
  upstreamMode = 'stream-503';
  const agentId = 'agent-m1-503';
  const buyer = 'iBuyerM1';
  const key = mintApiKey(agentId, buyer).key;
  const maxTokens = 50000;
  const worst = calculateCost(PRICING, MODEL, 4000, maxTokens);
  creditDeposit(agentId, buyer, worst, 'tx-m1-503');

  await runProxy(agentId, key, { model: MODEL, stream: true, max_tokens: maxTokens, messages: [] });
  await new Promise((res) => setTimeout(res, 50));

  const remaining = getBalance(agentId, buyer);
  assert.ok(Math.abs(remaining - worst) < 1e-9,
    `a 503 must leave the balance untouched; deposited=${worst} remaining=${remaining}`);
});

test('M2: a non-streaming upstream 503 bills NOTHING', async () => {
  inflight._reset();
  upstreamMode = 'json-503';
  const agentId = 'agent-m2-503';
  const buyer = 'iBuyerM2';
  const key = mintApiKey(agentId, buyer).key;
  const deposit = calculateCost(PRICING, MODEL, 4000, 20000);
  creditDeposit(agentId, buyer, deposit, 'tx-m2-503');

  await runProxy(agentId, key, { model: MODEL, stream: false, max_tokens: 20000, messages: [] });
  await new Promise((res) => setTimeout(res, 50));

  const remaining = getBalance(agentId, buyer);
  assert.ok(Math.abs(remaining - deposit) < 1e-9,
    `a non-streaming 503 must leave the balance untouched; deposited=${deposit} remaining=${remaining}`);
});
