'use strict';
/**
 * Buyer browse for sovdata. GET website / networkEndpoints / typed
 * endpoints[].url — never description (trycloudflare in copy is not a URL).
 */

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

function firstNetworkEndpoint(listing) {
  const endpoints = listing.networkEndpoints
    || (listing.network && listing.network.endpoints)
    || (listing.profile && listing.profile.network && listing.profile.network.endpoints);
  if (typeof endpoints === 'string') return httpUrlString(endpoints);
  if (Array.isArray(endpoints) && endpoints[0]) return httpUrlString(String(endpoints[0]));
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

function joinBrowsePath(baseUrl, extraPath) {
  const u = new URL(String(baseUrl));
  const hasPath = u.pathname && u.pathname !== '/';
  if (hasPath) return `${u.origin}${u.pathname}${u.search}`;
  if (!extraPath) return u.origin;
  const p = String(extraPath).startsWith('/') ? extraPath : `/${extraPath}`;
  return `${u.origin}${p}`;
}

async function browseListing({ listing, path, fetchImpl } = {}) {
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
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { ok: false, code: 'BROWSE_NO_ENDPOINT', message: 'fetch is not available.' };
  }
  let res;
  try {
    res = await doFetch(url);
  } catch (e) {
    return { ok: false, code: 'BROWSE_HTTP_0', message: e.message || String(e), url };
  }
  const status = res && res.status;
  if (!res || !res.ok) {
    const code = Number.isFinite(Number(status)) ? `BROWSE_HTTP_${status}` : 'BROWSE_HTTP_0';
    return { ok: false, code, message: `GET ${url} failed`, status, url };
  }
  let body = '';
  try {
    body = typeof res.text === 'function' ? await res.text() : '';
  } catch {
    body = '';
  }
  return { ok: true, url, status: status || 200, body };
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

async function browseSeller({ seller, listing, path, apiUrl, fetchImpl } = {}) {
  const rec = listing || await fetchSellerListing(seller, { apiUrl, fetchImpl });
  return browseListing({ listing: rec, path, fetchImpl });
}

module.exports = {
  resolveBrowseUrl,
  joinBrowsePath,
  browseListing,
  fetchSellerListing,
  browseSeller,
};
