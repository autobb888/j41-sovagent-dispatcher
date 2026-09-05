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

function errorCode(err) {
  if (!err) return 'ACCESS_FAILED';
  if (typeof err.code === 'string' && err.code) return err.code;
  if (err.error && typeof err.error.code === 'string') return err.error.code;
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

function redactApiKey(key) {
  const s = String(key || '');
  if (s.length <= 8) return '(redacted)';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

async function requestAndOpenAccess({
  agent,
  keys,
  seller,
  network = 'verustest',
  apiUrl,
  signer,
  sdk,
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

async function chatCompletions({ client, grant, message, model, timeoutMs } = {}) {
  if (!grant || !grant.apiKey || !grant.endpointUrl) {
    return { ok: false, code: 'ACCESS_GRANT_MISSING', message: 'No decrypted access grant. Run access first.' };
  }
  if (!message) {
    return { ok: false, code: 'CHAT_NO_MESSAGE', message: '--message is required.' };
  }
  if (!client || typeof client.callProxied !== 'function') {
    return { ok: false, code: 'ACCESS_CLIENT_MISSING', message: 'Authenticated client is required.' };
  }
  const useModel = model || (grant.models && grant.models[0]) || 'default';
  try {
    const result = await client.callProxied({
      endpointUrl: grant.endpointUrl,
      apiKey: grant.apiKey,
      body: {
        model: useModel,
        messages: [{ role: 'user', content: String(message) }],
      },
      timeoutMs,
    });
    return { ok: true, model: useModel, result };
  } catch (e) {
    return { ok: false, code: 'CHAT_FAILED', message: e.message || String(e) };
  }
}

module.exports = {
  grantPath,
  saveAccessGrant,
  loadAccessGrant,
  redactApiKey,
  requestAndOpenAccess,
  chatCompletions,
};
