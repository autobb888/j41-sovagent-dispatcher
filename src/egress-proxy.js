'use strict';
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns').promises;
// Shared private-IP classifier (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16,
// 0.0.0.0, IPv6 loopback/link-local/ULA + IPv4-mapped forms). Same helper
// proxy-handler.js uses to SSRF-guard buyer→seller traffic; reused here so the
// two egress paths can't drift out of sync.
const { isPrivateIp } = require('./proxy-handler.js');

// Overridable so a scratch/test daemon can run alongside a live one. The live
// daemon holds this port on the shared j41-isolated bridge, and `start` treats a
// bind failure as FATAL — without an override, a second dispatcher on the same
// host cannot start at all, which blocks fault-injection and scale testing.
const EGRESS_PROXY_PORT = (() => {
  const raw = process.env.J41_EGRESS_PROXY_PORT;
  const n = raw === undefined ? NaN : parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 9847;
})();

/** Parse the job's configured URLs into a Set of "host:port" the proxy will allow. */
function deriveAllowedHosts(env) {
  const keys = ['J41_API_URL', 'J41_LLM_BASE_URL', 'J41_EXECUTOR_URL', 'J41_MCP_URL'];
  const out = new Set();
  for (const k of keys) {
    const v = env[k];
    if (!v || typeof v !== 'string') continue;
    let u;
    try { u = new URL(v); } catch { continue; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    const host = u.hostname;
    // Skip loopback in all forms. Node's WHATWG URL parser returns IPv6 hostnames
    // WITH brackets (e.g. "[::1]", "[::ffff:7f00:1]") and normalises dotted-decimal
    // IPv4-mapped addresses to hex groups (127.x.x.x → 7fxx:xxxx), so we must match
    // both the canonical and the possible no-bracket forms.
    if (!host || host === 'localhost' || /^127\./.test(host) ||
        host === '::1' || host === '[::1]' ||
        /^::ffff:127\./i.test(host) || /^\[::ffff:7f/i.test(host)) continue;
    const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
    out.add(`${host}:${port}`);
  }
  return out;
}

class EgressProxyHost {
  constructor({ host = '127.0.0.1', port = EGRESS_PROXY_PORT, resolve, log, allowLocalUpstream = false } = {}) {
    this._host = host;
    this._wantPort = port;
    this._resolve = resolve || ((h) => dns.lookup(h));
    this._log = log || (() => {});
    // Dev/test escape hatch — same flag family as J41_ALLOW_LOCAL_UPSTREAM for
    // proxy-handler.js ("disables SSRF protection on the proxy"). Defaults to
    // false: fail closed in production.
    this._allowLocalUpstream = !!allowLocalUpstream;
    this._allow = new Map(); // token -> Set("host:port")
    this._server = null;
  }
  get port() { return this._server ? this._server.address().port : this._wantPort; }
  register(token, allowedSet) { if (token) this._allow.set(token, allowedSet); }
  revoke(token) { this._allow.delete(token); }

  start() {
    this._server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
    this._server.on('connect', (req, sock, head) => this._onConnect(req, sock, head));
    return new Promise((resolve, reject) => {
      this._server.once('error', reject);
      this._server.listen(this._wantPort, this._host, () => { this._server.off('error', reject); resolve(); });
    });
  }
  stop() {
    if (!this._server) return Promise.resolve();
    return new Promise((resolve) => this._server.close(() => { this._server = null; resolve(); }));
  }

  _token(req) {
    const h = req.headers['proxy-authorization'] || '';
    const m = /^Bearer\s+(\S+)/i.exec(h);
    return m ? m[1] : null;
  }
  _deny(sock, code, msg) { try { sock.write(`HTTP/1.1 ${code} ${msg}\r\n\r\n`); sock.destroy(); } catch { /* gone */ } }

  async _onConnect(req, clientSocket, head) {
    const token = this._token(req);
    const allow = token && this._allow.get(token);
    if (!allow) return this._deny(clientSocket, 407, 'Proxy Authentication Required');
    const idx = req.url.lastIndexOf(':');
    if (idx < 0) return this._deny(clientSocket, 400, 'Bad Request');
    const host = req.url.slice(0, idx);
    const port = parseInt(req.url.slice(idx + 1), 10) || 443;
    if (!allow.has(`${host}:${port}`)) { this._log(`egress DENY ${host}:${port}`); return this._deny(clientSocket, 403, 'Forbidden'); }
    let address;
    try { const r = await this._resolve(host); address = typeof r === 'string' ? r : r.address; }
    catch { return this._deny(clientSocket, 502, 'Bad Gateway (dns)'); }
    // DNS-rebind SSRF guard: the allowlist above only checked the CONFIGURED
    // hostname, not what it actually resolves to. An allowlisted host whose DNS
    // is attacker-influenced (or simply misconfigured) could resolve to a
    // private/link-local address — e.g. 169.254.169.254, the cloud metadata
    // endpoint. Re-validate the RESOLVED address here and fail closed. The
    // `address` we validate is exactly the literal IP passed to net.connect
    // below (no second resolution happens), so there's no TOCTOU window.
    if (!this._allowLocalUpstream && isPrivateIp(address)) {
      this._log(`egress DENY ${host}:${port} resolved to private address ${address}`);
      return this._deny(clientSocket, 502, 'Bad Gateway (private upstream)');
    }
    const upstream = net.connect(port, address, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => this._deny(clientSocket, 502, 'Bad Gateway'));
    clientSocket.on('error', () => upstream.destroy());
  }
}

const { execFileSync } = require('node:child_process');
/** Read the j41-isolated bridge gateway IP; fall back to 172.18.0.1. `runner` is injectable for tests. */
function isolatedGatewayIp(runner) {
  const run = runner || (() => execFileSync('docker',
    ['network', 'inspect', 'j41-isolated', '--format', '{{range .IPAM.Config}}{{.Gateway}}{{end}}'],
    { stdio: 'pipe', timeout: 10000 }).toString());
  try { const ip = String(run()).trim(); return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : '172.18.0.1'; }
  catch { return '172.18.0.1'; }
}

module.exports = { EgressProxyHost, deriveAllowedHosts, isolatedGatewayIp, EGRESS_PROXY_PORT };
