const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { checkUpstream, startHealthPoller, getHealth } = require('../src/upstream-health');

function startFakeServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('checkUpstream treats 200 /models as healthy', async () => {
  const server = await startFakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
  });
  try {
    const port = server.address().port;
    const r = await checkUpstream(`http://127.0.0.1:${port}`);
    assert.equal(r.healthy, true);
    assert.equal(r.status, 200);
  } finally { server.close(); }
});

test('checkUpstream treats 404 as healthy (server up, no /models route)', async () => {
  const server = await startFakeServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  try {
    const port = server.address().port;
    const r = await checkUpstream(`http://127.0.0.1:${port}`);
    assert.equal(r.healthy, true, '404 means server is up but /models isn\'t implemented');
  } finally { server.close(); }
});

test('checkUpstream treats 5xx as unhealthy', async () => {
  const server = await startFakeServer((req, res) => {
    res.writeHead(503);
    res.end();
  });
  try {
    const port = server.address().port;
    const r = await checkUpstream(`http://127.0.0.1:${port}`);
    assert.equal(r.healthy, false);
    assert.equal(r.status, 503);
  } finally { server.close(); }
});

test('checkUpstream marks unreachable host as unhealthy with error', async () => {
  // RFC 5737 TEST-NET-1 — not routable
  const r = await checkUpstream('http://192.0.2.1:9', 300);
  assert.equal(r.healthy, false);
  assert.ok(r.error, 'should carry an error string');
});

test('startHealthPoller runs an immediate check and stores result', async () => {
  const server = await startFakeServer((req, res) => {
    res.writeHead(200);
    res.end('{"data":[]}');
  });
  try {
    const port = server.address().port;
    const cfgs = new Map([['agent-X', { endpointUrl: `http://127.0.0.1:${port}` }]]);
    const timer = startHealthPoller(cfgs, 60000);
    // Give the immediate runCheck a moment to finish
    await new Promise(r => setTimeout(r, 50));
    const h = getHealth('agent-X');
    assert.ok(h, 'health entry should exist after immediate check');
    assert.equal(h.healthy, true);
    clearInterval(timer);
  } finally { server.close(); }
});
