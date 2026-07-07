const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { EgressProxyHost, deriveAllowedHosts, EGRESS_PROXY_PORT } = require('../src/egress-proxy.js');

// Minimal CONNECT client: returns the proxy's status line.
function connectVia(port, token, target) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      const auth = token ? `Proxy-Authorization: Bearer ${token}\r\n` : '';
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
    });
    let buf = '';
    s.on('data', d => { buf += d.toString(); if (buf.includes('\r\n')) { s.destroy(); resolve(buf.split('\r\n')[0]); } });
    s.on('error', reject);
    s.setTimeout(3000, () => { s.destroy(); reject(new Error('timeout')); });
  });
}

test('deriveAllowedHosts parses configured URLs, skips localhost/empty', () => {
  const set = deriveAllowedHosts({
    J41_API_URL: 'https://api.junction41.io',
    J41_LLM_BASE_URL: 'https://api.groq.com/openai/v1',
    J41_EXECUTOR_URL: 'http://localhost:11434/v1',
    J41_MCP_URL: '',
  });
  assert.ok(set.has('api.junction41.io:443'));
  assert.ok(set.has('api.groq.com:443'));
  assert.ok(!set.has('localhost:11434'));
  assert.equal(set.size, 2);
});

test('deriveAllowedHosts skips IPv6 loopback variants', () => {
  // Node's WHATWG URL parser returns IPv6 with brackets and normalises
  // dotted-decimal IPv4-mapped addresses to hex groups (127.0.0.1 → 7f00:1).
  const set = deriveAllowedHosts({
    J41_API_URL: 'http://[::1]:8080/v1',
    J41_LLM_BASE_URL: 'http://[::ffff:127.0.0.1]:9000/v1', // normalises to [::ffff:7f00:1]
    J41_EXECUTOR_URL: 'https://api.example.com/hook',
  });
  assert.ok(!set.has('[::1]:8080'), 'IPv6 ::1 bracket form should be skipped');
  assert.ok(!set.has('[::ffff:7f00:1]:9000'), 'IPv4-mapped loopback (hex-normalised) should be skipped');
  assert.ok(set.has('api.example.com:443'));
  assert.equal(set.size, 1);
});

test('malformed CONNECT target (no colon) → 400', async () => {
  const proxy = new EgressProxyHost({ host: '127.0.0.1', port: 0, resolve: async () => ({ address: '127.0.0.1' }) });
  await proxy.start();
  proxy.register('tok0', new Set(['api.groq.com:443']));
  try {
    const line = await connectVia(proxy.port, 'tok0', 'nocolon');
    assert.match(line, /400/);
  } finally { await proxy.stop(); }
});

test('unknown/absent token → 407', async () => {
  const proxy = new EgressProxyHost({ host: '127.0.0.1', port: 0, resolve: async () => ({ address: '127.0.0.1' }) });
  await proxy.start();
  try {
    const line = await connectVia(proxy.port, null, 'api.groq.com:443');
    assert.match(line, /407/);
  } finally { await proxy.stop(); }
});

test('non-allowlisted host → 403; allowlisted host → 200 (dns mocked, upstream stub)', async () => {
  // Stub upstream so a real connection can be established.
  const upstream = net.createServer(sock => sock.end()).listen(0, '127.0.0.1');
  await new Promise(r => upstream.once('listening', r));
  const upPort = upstream.address().port;
  const proxy = new EgressProxyHost({ host: '127.0.0.1', port: 0, resolve: async () => ({ address: '127.0.0.1' }) });
  await proxy.start();
  proxy.register('tok1', new Set([`api.groq.com:${upPort}`]));
  try {
    const denied = await connectVia(proxy.port, 'tok1', `evil.example.com:${upPort}`);
    assert.match(denied, /403/);
    const ok = await connectVia(proxy.port, 'tok1', `api.groq.com:${upPort}`);
    assert.match(ok, /200/);
  } finally { await proxy.stop(); upstream.close(); }
});

test('revoke removes the allowlist → 407', async () => {
  const proxy = new EgressProxyHost({ host: '127.0.0.1', port: 0, resolve: async () => ({ address: '127.0.0.1' }) });
  await proxy.start();
  proxy.register('tok2', new Set(['api.groq.com:443']));
  proxy.revoke('tok2');
  try {
    const line = await connectVia(proxy.port, 'tok2', 'api.groq.com:443');
    assert.match(line, /407/);
  } finally { await proxy.stop(); }
});

test('EGRESS_PROXY_PORT is 9847', () => { assert.equal(EGRESS_PROXY_PORT, 9847); });
