'use strict';
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns').promises;

const EGRESS_PROXY_PORT = 9847;

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
    if (!host || host === 'localhost' || /^127\./.test(host)) continue;
    const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
    out.add(`${host}:${port}`);
  }
  return out;
}

class EgressProxyHost {
  constructor({ host = '127.0.0.1', port = EGRESS_PROXY_PORT, resolve, log } = {}) {
    this._host = host;
    this._wantPort = port;
    this._resolve = resolve || ((h) => dns.lookup(h));
    this._log = log || (() => {});
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
    const host = req.url.slice(0, idx);
    const port = parseInt(req.url.slice(idx + 1), 10) || 443;
    if (!allow.has(`${host}:${port}`)) { this._log(`egress DENY ${host}:${port}`); return this._deny(clientSocket, 403, 'Forbidden'); }
    let address;
    try { const r = await this._resolve(host); address = typeof r === 'string' ? r : r.address; }
    catch { return this._deny(clientSocket, 502, 'Bad Gateway (dns)'); }
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

module.exports = { EgressProxyHost, deriveAllowedHosts, EGRESS_PROXY_PORT };
