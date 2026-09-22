'use strict';
/**
 * Buyer browse for sovdata. GET website / networkEndpoints / typed
 * endpoints[].url — never description (trycloudflare in copy is not a URL).
 * The listing URL is seller-controlled. Refuse loopback, LAN, and link-local
 * before any byte is read, and do not follow a redirect onto those hosts.
 */
const dns = require('dns').promises;
const { blockedDataHost } = require('./listing-description');

const MAX_BROWSE_BYTES = 1_000_000;
const MAX_BROWSE_REDIRECTS = 4;

function httpUrlString(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const u = new URL(value);
    if (!/^https?:$/i.test(u.protocol)) return null;
    return value;
  } catch {
    return null;
  }
}

function coerceEndpointList(endpoints) {
  if (typeof endpoints !== 'string') return endpoints;
  const trimmed = endpoints.trim();
  // data-setup writes networkEndpoints as a JSON array string on the profile.
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* not JSON — try it as one URL */ }
  }
  return endpoints;
}

function firstNetworkEndpoint(listing) {
  let endpoints = listing.networkEndpoints
    || (listing.network && listing.network.endpoints)
    || (listing.profile && listing.profile.network && listing.profile.network.endpoints);
  endpoints = coerceEndpointList(endpoints);
  if (typeof endpoints === 'string') return httpUrlString(endpoints);
  if (Array.isArray(endpoints) && endpoints[0]) {
    const first = endpoints[0];
    return httpUrlString(typeof first === 'string' ? first : (first && first.url));
  }
  return null;
}

function listingWebsite(listing) {
  const website = listing.website
    || (listing.profile && listing.profile.website)
    || (listing.profile && listing.profile.profile && listing.profile.profile.website);
  return website ? httpUrlString(String(website)) : null;
}

function firstTypedEndpoint(listing) {
  if (!Array.isArray(listing.endpoints)) return null;
  for (const ep of listing.endpoints) {
    const url = ep && httpUrlString(ep.url);
    if (url) return url;
  }
  return null;
}

function resolveBrowseUrl(listing) {
  if (!listing || typeof listing !== 'object') return null;
  return firstNetworkEndpoint(listing) || listingWebsite(listing) || firstTypedEndpoint(listing);
}

function parseBrowseQuery(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, code: 'BROWSE_QUERY', message: '--query is empty' };
  const body = s.startsWith('?') ? s.slice(1) : s;
  if (!body || /[?#]/.test(body) || /^[a-z][a-z0-9+.-]*:/i.test(body)) {
    return { ok: false, code: 'BROWSE_QUERY', message: '--query must be key=value pairs, not a URL' };
  }
  const params = new URLSearchParams(body);
  const keys = [...params.keys()];
  if (keys.length === 0) return { ok: false, code: 'BROWSE_QUERY', message: '--query is empty' };
  const seen = new Set();
  for (const key of keys) {
    if (seen.has(key)) {
      return { ok: false, code: 'BROWSE_QUERY', message: `repeated query field ${key}` };
    }
    seen.add(key);
    const value = params.get(key);
    if (value == null || value === '') {
      return { ok: false, code: 'BROWSE_QUERY', message: `query field ${key} is empty` };
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || blockedDataHost(value)) {
      return { ok: false, code: 'BROWSE_QUERY', message: `query field ${key} must not retarget the host` };
    }
  }
  return { ok: true, params };
}

function applyBrowseQuery(url, query) {
  const parsed = parseBrowseQuery(query);
  if (!parsed.ok) return parsed;
  let u;
  try { u = new URL(String(url)); } catch {
    return { ok: false, code: 'BROWSE_NO_ENDPOINT', message: 'Listing endpoint is not a URL.' };
  }
  for (const [key, value] of parsed.params) {
    if (u.searchParams.has(key)) {
      return { ok: false, code: 'BROWSE_QUERY', message: `query field ${key} repeats a field already on the listing URL` };
    }
    u.searchParams.append(key, value);
  }
  if (blockedDataHost(u.hostname)) {
    return { ok: false, code: 'BROWSE_BLOCKED_HOST', message: `Refusing to fetch: ${u.hostname} is not a public data host`, url: u.href };
  }
  return { ok: true, url: u.href };
}

function joinBrowsePath(baseUrl, extraPath) {
  const u = new URL(String(baseUrl));
  const hasPath = u.pathname && u.pathname !== '/';
  if (hasPath) return `${u.origin}${u.pathname}${u.search}`;
  if (!extraPath) return u.origin;
  const p = String(extraPath).startsWith('/') ? extraPath : `/${extraPath}`;
  return `${u.origin}${p}`;
}

async function hostBlocked(url, dnsLookup) {
  let hostname = '';
  try { hostname = new URL(url).hostname; } catch { return 'not a URL'; }
  if (blockedDataHost(hostname)) return `${hostname} is not a public data host`;
  if (typeof dnsLookup !== 'function') return null;
  let addrs = [];
  try {
    addrs = await dnsLookup(hostname);
  } catch (e) {
    return e.message || String(e);
  }
  for (const addr of addrs || []) {
    if (blockedDataHost(addr)) return `${hostname} resolves to ${addr}`;
  }
  return null;
}

async function defaultBrowseLookup(hostname) {
  if (require('net').isIP(hostname)) return [hostname];
  const addrs = await dns.lookup(hostname, { all: true });
  return (addrs || []).map((a) => a.address);
}

function headerGet(res, name) {
  const h = res && res.headers;
  if (!h) return null;
  if (typeof h.get === 'function') return h.get(name);
  return h[name] || h[name.toLowerCase()] || null;
}

async function browseListing({ listing, path, query, fetchImpl, dnsLookup } = {}) {
  const base = resolveBrowseUrl(listing);
  if (!base) {
    return {
      ok: false,
      code: 'BROWSE_NO_ENDPOINT',
      message: 'Listing has no website or network endpoint to GET.',
    };
  }
  let url;
  try {
    url = joinBrowsePath(base, path);
  } catch {
    return {
      ok: false,
      code: 'BROWSE_NO_ENDPOINT',
      message: 'Listing endpoint is not a URL.',
    };
  }
  if (query != null) {
    if (String(query).trim() === '') {
      return { ok: false, code: 'BROWSE_QUERY', message: '--query is empty', url };
    }
    const merged = applyBrowseQuery(url, query);
    if (!merged.ok) return { ok: false, code: merged.code, message: merged.message, url: merged.url || url };
    url = merged.url;
  }
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { ok: false, code: 'BROWSE_NO_ENDPOINT', message: 'fetch is not available.' };
  }
  // Tests inject fetchImpl and skip DNS. A real browse resolves first so a
  // public name that points at link-local is refused before the GET.
  const lookup = dnsLookup !== undefined ? dnsLookup : (fetchImpl ? null : defaultBrowseLookup);
  for (let hop = 0; hop <= MAX_BROWSE_REDIRECTS; hop++) {
    const why = await hostBlocked(url, lookup);
    if (why) {
      return { ok: false, code: 'BROWSE_BLOCKED_HOST', message: `Refusing to fetch: ${why}`, url };
    }
    let res;
    try {
      res = await doFetch(url, { redirect: 'manual' });
    } catch (e) {
      return { ok: false, code: 'BROWSE_HTTP_0', message: e.message || String(e), url };
    }
    const status = res && Number(res.status);
    if (res && status >= 300 && status < 400) {
      const loc = headerGet(res, 'location');
      if (!loc || hop === MAX_BROWSE_REDIRECTS) {
        return { ok: false, code: 'BROWSE_REDIRECT', message: `GET ${url} redirected without a usable location`, status, url };
      }
      try { url = new URL(loc, url).href; } catch {
        return { ok: false, code: 'BROWSE_REDIRECT', message: 'Redirect location is not a URL', status, url };
      }
      continue;
    }
    if (!res || !res.ok) {
      const code = Number.isFinite(status) ? `BROWSE_HTTP_${status}` : 'BROWSE_HTTP_0';
      return { ok: false, code, message: `GET ${url} failed`, status, url };
    }
    const declared = Number(headerGet(res, 'content-length'));
    if (Number.isFinite(declared) && declared > MAX_BROWSE_BYTES) {
      return { ok: false, code: 'BROWSE_TOO_LARGE', message: `Response exceeds ${MAX_BROWSE_BYTES} bytes`, url };
    }
    let body = '';
    try {
      body = typeof res.text === 'function' ? await res.text() : '';
    } catch {
      body = '';
    }
    if (Buffer.byteLength(body) > MAX_BROWSE_BYTES) {
      return { ok: false, code: 'BROWSE_TOO_LARGE', message: `Response exceeds ${MAX_BROWSE_BYTES} bytes`, url };
    }
    return { ok: true, url, status: status || 200, body };
  }
  return { ok: false, code: 'BROWSE_REDIRECT', message: 'Too many redirects', url };
}

async function fetchSellerListing(seller, { apiUrl, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function' || !apiUrl || !seller) return null;
  const base = String(apiUrl).replace(/\/+$/, '');
  const url = `${base}/v1/agents/${encodeURIComponent(seller)}`;
  try {
    const res = await doFetch(url);
    if (!res || !res.ok) return null;
    const body = typeof res.json === 'function' ? await res.json() : null;
    if (!body || typeof body !== 'object') return null;
    return body.data || body.agent || body;
  } catch {
    return null;
  }
}

async function browseSeller({ seller, listing, path, query, apiUrl, fetchImpl } = {}) {
  const rec = listing || await fetchSellerListing(seller, { apiUrl, fetchImpl });
  const { parseListingKind } = require('./listing-kind');
  const kind = parseListingKind(rec && (rec.kind || rec.listingKind || rec.listing_kind));
  if (kind && kind !== 'data') {
    return {
      ok: false,
      code: 'BROWSE_NOT_DATA',
      message: `browse is for kind=data listings, not ${kind}.`,
    };
  }
  return browseListing({ listing: rec, path, query, fetchImpl });
}

module.exports = {
  httpUrlString,
  resolveBrowseUrl,
  joinBrowsePath,
  parseBrowseQuery,
  applyBrowseQuery,
  browseListing,
  fetchSellerListing,
  browseSeller,
};
