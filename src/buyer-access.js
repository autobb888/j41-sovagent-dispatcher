'use strict';
/**
 * Buyer ECDH access + OpenAI-compatible chat. hire POST /v1/jobs is labour;
 * models mint a grant via POST /v1/proxy/access/:seller then /v1/chat/completions.
 *
 * SDK verifyAccessEnvelope swallows getIdentityKeys errors into an empty
 * address list ("Could not resolve seller primary R-addresses"). This module
 * calls getIdentityKeys first and surfaces PLATFORM_SIGNER_REQUIRED /
 * KEYS_BAD_SIGNATURE / KEYS_UNSIGNED.
 */
const fs = require('fs');
const path = require('path');
const { planPlatformSigner, applyPlatformSigner } = require('./platform-signer');
const { assertAccessAllowed } = require('./hire');
const {
  isDispatcherProxyBase,
  resolveListingDispatcherBase,
  refreshStaleDispatcherBase,
  callProxiedPath,
} = require('./buyer-proxy-url');

const GRANT_UPSTREAM_MESSAGE = 'Grant endpointUrl is the upstream, not the seller proxy. Re-run: j41-dispatcher access <buyer> <seller>';

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

function listingPublicUrlHint(listing) {
  if (!listing || typeof listing !== 'object') return null;
  const endpoints = listing.networkEndpoints
    || (listing.network && listing.network.endpoints)
    || (listing.profile && listing.profile.network && listing.profile.network.endpoints);
  if (Array.isArray(endpoints) && endpoints[0]) return String(endpoints[0]);
  if (Array.isArray(listing.endpoints)) {
    for (const ep of listing.endpoints) {
      const url = ep && httpUrlString(ep.url);
      if (url) return url;
    }
  }
  const website = listing.website
    || (listing.profile && listing.profile.website)
    || (listing.profile && listing.profile.profile && listing.profile.profile.website);
  return website ? String(website) : null;
}

function errorCode(err) {
  if (!err) return 'ACCESS_FAILED';
  const code = (typeof err.code === 'string' && err.code)
    || (err.error && typeof err.error.code === 'string' && err.error.code)
    || '';
  const msg = String(err.message || (err.error && err.error.message) || '');
  // Platform may return bare "Nonce already used" without a structured code.
  if (code === 'NONCE_REPLAY' || /Nonce already used/i.test(msg)) return 'NONCE_REPLAY';
  if (code) return code;
  return 'ACCESS_FAILED';
}

function grantPath(agentsDir, buyerId, seller) {
  const safe = String(seller || '').replace(/[^A-Za-z0-9._-]+/g, '_');
  return path.join(agentsDir, buyerId, 'access', `${safe}.json`);
}

function saveAccessGrant(agentsDir, buyerId, seller, payload) {
  const p = grantPath(agentsDir, buyerId, seller);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const rec = {
    seller,
    apiKey: payload.apiKey,
    endpointUrl: payload.endpointUrl,
    expiresAt: payload.expiresAt,
    models: payload.models || [],
    savedAt: new Date().toISOString(),
  };
  if (payload.sessionId) rec.sessionId = String(payload.sessionId);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
  return rec;
}

function loadAccessGrant(agentsDir, buyerId, seller, now = Date.now()) {
  const p = grantPath(agentsDir, buyerId, seller);
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return null; }
  let rec;
  try { rec = JSON.parse(raw); } catch { return null; }
  if (!rec || !rec.apiKey || !rec.endpointUrl) return null;
  if (rec.expiresAt) {
    const exp = Date.parse(rec.expiresAt);
    if (Number.isFinite(exp) && exp <= now) return null;
  }
  return rec;
}

function persistGrantSession(agentsDir, buyerId, seller, sessionId) {
  if (!sessionId) return loadAccessGrant(agentsDir, buyerId, seller);
  const rec = loadAccessGrant(agentsDir, buyerId, seller);
  if (!rec) return null;
  return saveAccessGrant(agentsDir, buyerId, seller, { ...rec, sessionId: String(sessionId) });
}

function redactApiKey(key) {
  const s = String(key || '');
  if (s.length <= 8) return '(redacted)';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/**
 * Rewrite a saved non-dispatcher grant (e.g. stale NVIDIA /v1) from listing
 * website/endpoints after GET /j41/health service===dispatcher. Never mints a
 * new ECDH grant — callers must not invoke requestApiAccess on this path.
 * Failure: ACCESS_GRANT_UPSTREAM, grant file unchanged.
 */
async function refreshGrantFromListing({
  grant,
  listing,
  publicUrlHint,
  agentsDir,
  buyerId,
  seller,
  fetchImpl,
} = {}) {
  if (!grant || !grant.apiKey || !grant.endpointUrl) {
    return { ok: false, code: 'ACCESS_GRANT_MISSING', message: 'No decrypted access grant. Run access first.' };
  }
  if (isDispatcherProxyBase(grant.endpointUrl)) {
    return { ok: true, grant, refreshed: false };
  }
  const hint = publicUrlHint || listingPublicUrlHint(listing);
  if (!hint) {
    return { ok: false, code: 'ACCESS_GRANT_UPSTREAM', message: GRANT_UPSTREAM_MESSAGE };
  }
  let minted;
  try {
    minted = await resolveListingDispatcherBase(hint, {
      grant,
      fetchImpl,
      failCode: 'ACCESS_GRANT_UPSTREAM',
    });
  } catch {
    return { ok: false, code: 'ACCESS_GRANT_UPSTREAM', message: GRANT_UPSTREAM_MESSAGE };
  }
  const working = { ...grant, endpointUrl: minted };
  if (agentsDir && buyerId && seller) {
    try { saveAccessGrant(agentsDir, buyerId, seller, working); } catch { /* proceed in memory */ }
  }
  return { ok: true, grant: working, refreshed: true };
}

async function requestAndOpenAccess({
  agent,
  keys,
  seller,
  network = 'verustest',
  apiUrl,
  signer,
  sdk,
  services,
  sellerKind,
  serviceType,
} = {}) {
  const plan = applyPlatformSigner(planPlatformSigner({
    apiUrl,
    network,
    signer: signer || process.env.J41_PLATFORM_SIGNER,
  }));
  if (!plan.ok) {
    return { ok: false, code: plan.code, message: plan.message, testnetSigner: plan.testnetSigner };
  }

  const generateEphemeralKeypair = sdk && sdk.generateEphemeralKeypair;
  const buildAccessRequest = sdk && sdk.buildAccessRequest;
  const openAccessEnvelope = sdk && sdk.openAccessEnvelope;
  if (typeof generateEphemeralKeypair !== 'function'
      || typeof buildAccessRequest !== 'function'
      || typeof openAccessEnvelope !== 'function') {
    return { ok: false, code: 'ACCESS_SDK_MISSING', message: 'SDK access helpers are not loaded.' };
  }
  if (!agent || !agent.client || typeof agent.client.requestApiAccess !== 'function') {
    return { ok: false, code: 'ACCESS_CLIENT_MISSING', message: 'Authenticated client is required.' };
  }
  if (!keys || !keys.wif) {
    return { ok: false, code: 'BUYER_NOT_REGISTERED', message: 'Buyer WIF is required to sign the access request.' };
  }

  const gate = assertAccessAllowed({ sellerKind, services, serviceType });
  if (!gate.ok) return gate;

  const eph = generateEphemeralKeypair();
  const request = buildAccessRequest(keys.wif, seller, eph.publicKey, network);

  let envelope;
  try {
    envelope = await agent.client.requestApiAccess(seller, request);
  } catch (e) {
    return { ok: false, code: errorCode(e), message: e.message || String(e) };
  }

  // Fail loud *before* openAccessEnvelope, which swallows getIdentityKeys errors.
  if (typeof agent.client.getIdentityKeys === 'function') {
    try {
      const idKeys = await agent.client.getIdentityKeys(seller);
      const addrs = idKeys && Array.isArray(idKeys.primaryAddresses) ? idKeys.primaryAddresses : [];
      if (!addrs.length) {
        return {
          ok: false,
          code: 'SELLER_KEYS_EMPTY',
          message: 'Platform returned no seller primary R-addresses after keys-endpoint verification.',
        };
      }
    } catch (e) {
      return {
        ok: false,
        code: errorCode(e),
        message: e.message || String(e),
        testnetSigner: plan.testnetSigner,
      };
    }
  }

  try {
    const payload = await openAccessEnvelope(envelope, eph.privateKey, request.nonce, {
      client: agent.client,
      sellerVerusId: seller,
      network,
    });
    return {
      ok: true,
      payload,
      expiresAt: (payload && payload.expiresAt) || (envelope && envelope.expiresAt) || null,
      signerDefaulted: !!plan.defaulted,
      signerMessage: plan.message,
    };
  } catch (e) {
    return { ok: false, code: 'ACCESS_DECRYPT_FAILED', message: e.message || String(e) };
  }
}

async function chatCompletions({
  client,
  grant,
  message,
  model,
  timeoutMs,
  publicUrlHint,
  listing,
  agentsDir,
  buyerId,
  seller,
  fetchImpl,
} = {}) {
  if (!grant || !grant.apiKey || !grant.endpointUrl) {
    return { ok: false, code: 'ACCESS_GRANT_MISSING', message: 'No decrypted access grant. Run access first.' };
  }
  if (!message) {
    return { ok: false, code: 'CHAT_NO_MESSAGE', message: '--message is required.' };
  }
  if (!client || typeof client.callProxied !== 'function') {
    return { ok: false, code: 'ACCESS_CLIENT_MISSING', message: 'Authenticated client is required.' };
  }

  let working = grant;
  if (!isDispatcherProxyBase(working.endpointUrl)) {
    const rewritten = await refreshGrantFromListing({
      grant: working,
      listing,
      publicUrlHint,
      agentsDir,
      buyerId,
      seller,
      fetchImpl,
    });
    if (!rewritten.ok) return rewritten;
    working = rewritten.grant;
  } else {
    const hint = publicUrlHint || listingPublicUrlHint(listing);
    let nextUrl;
    try {
      nextUrl = await refreshStaleDispatcherBase(working.endpointUrl, hint, {
        grant: working,
        fetchImpl,
        failCode: 'ACCESS_GRANT_STALE',
      });
    } catch (e) {
      return {
        ok: false,
        code: (e && e.code) || 'ACCESS_GRANT_STALE',
        message: (e && e.message) || 'Saved grant origin failed /j41/health.',
      };
    }
    if (nextUrl !== working.endpointUrl) {
      working = { ...working, endpointUrl: nextUrl };
      if (agentsDir && buyerId && seller) {
        try { saveAccessGrant(agentsDir, buyerId, seller, working); } catch { /* proceed in memory */ }
      }
    }
  }

  const useModel = model || (working.models && working.models[0]) || 'default';
  try {
    const result = await client.callProxied({
      endpointUrl: working.endpointUrl,
      apiKey: working.apiKey,
      path: callProxiedPath(working.endpointUrl),
      body: {
        model: useModel,
        messages: [{ role: 'user', content: String(message) }],
      },
      timeoutMs,
    });
    return { ok: true, model: useModel, result };
  } catch (e) {
    if (e && e.statusCode === 402) {
      const body = (e.responseBody && typeof e.responseBody === 'object') ? e.responseBody : {};
      const headers = e.responseHeaders || {};
      const suggested = headers['x-j41-credit-suggestedtopup']
        || headers['X-J41-Credit-SuggestedTopup']
        || body.suggestedTopup
        || null;
      return {
        ok: false,
        code: 'CHAT_NEEDS_DEPOSIT',
        message: e.message || 'Insufficient credit. Deposit VRSC to the seller i-address then retry chat.',
        topupAddress: body.topupAddress || null,
        estimatedCost: body.estimatedCost,
        balance: body.balance,
        suggestedTopup: suggested,
        depositArgv: 'j41-dispatcher deposit <buyer> <seller> --amount <n>',
      };
    }
    return { ok: false, code: 'CHAT_FAILED', message: e.message || String(e) };
  }
}

module.exports = {
  grantPath,
  saveAccessGrant,
  loadAccessGrant,
  persistGrantSession,
  redactApiKey,
  listingPublicUrlHint,
  refreshGrantFromListing,
  requestAndOpenAccess,
  chatCompletions,
};
