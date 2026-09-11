'use strict';
/**
 * Pure URL helpers for buyer envelopes. Mint {origin}/j41/proxy/v1 — never
 * the seller's upstream (NVIDIA / apiEndpointUrl). Path join must not emit /v1/v1.
 */

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function originOf(url) {
  let u;
  try { u = new URL(String(url)); }
  catch { throw codedError('ENVELOPE_BAD_PUBLIC_URL', 'publicUrl is not a URL'); }
  if (!/^https?:$/i.test(u.protocol)) {
    throw codedError('ENVELOPE_BAD_PUBLIC_URL', 'publicUrl must be http(s)');
  }
  return u.origin;
}

function hostsEqual(a, b) {
  try {
    return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase();
  } catch { return false; }
}

function mintBuyerProxyBase(publicUrl) {
  // ALWAYS rebuild. Ignore any path the operator pasted.
  return `${originOf(publicUrl)}/j41/proxy/v1`;
}

function callProxiedPath(endpointUrl) {
  const path = new URL(endpointUrl).pathname.replace(/\/+$/, '');
  if (path.endsWith('/v1')) return '/chat/completions';
  return '/v1/chat/completions';
}

function depositReportUrl(publicOrProxyUrl) {
  return `${originOf(publicOrProxyUrl)}/j41/deposit/report`;
}

function isDispatcherProxyBase(url) {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, '');
    return p === '/j41/proxy/v1' || p === '/j41/proxy';
  } catch { return false; }
}

async function assertDispatcherHealth(origin, fetchImpl, failCode = 'ENVELOPE_NO_PUBLIC_URL') {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw codedError(failCode, `GET ${origin}/j41/health failed`);
  }
  let res;
  try {
    res = await doFetch(`${String(origin).replace(/\/+$/, '')}/j41/health`);
  } catch {
    throw codedError(failCode, `GET ${origin}/j41/health failed`);
  }
  if (!res || !res.ok) {
    throw codedError(failCode, `GET ${origin}/j41/health failed`);
  }
  let body;
  try { body = await res.json(); } catch {
    throw codedError(failCode, 'j41/health is not JSON');
  }
  if (!body || body.service !== 'dispatcher') {
    throw codedError(failCode, 'j41/health is not a dispatcher');
  }
  return true;
}

async function resolveListingDispatcherBase(hint, { grant, fetchImpl, failCode } = {}) {
  const code = failCode || 'ACCESS_GRANT_UPSTREAM';
  const minted = mintBuyerProxyBase(hint);
  if (grant && !isDispatcherProxyBase(grant.endpointUrl) && hostsEqual(minted, grant.endpointUrl)) {
    throw codedError(code, 'listing hint host is the grant upstream, not a dispatcher');
  }
  await assertDispatcherHealth(originOf(minted), fetchImpl, code);
  return minted;
}

module.exports = {
  codedError,
  originOf,
  hostsEqual,
  mintBuyerProxyBase,
  callProxiedPath,
  depositReportUrl,
  isDispatcherProxyBase,
  assertDispatcherHealth,
  resolveListingDispatcherBase,
};
