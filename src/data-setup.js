'use strict';
/**
 * Data listings are a VDXF rind, not a labour registrar.
 * website / networkEndpoints only — never registerService, never endpoints[].
 */

const { parseListingKind, kindFromIdentityName } = require('./listing-kind');
const { httpUrlString } = require('./buyer-browse');
const { descriptionHasEphemeralUrl, refuseDataListingDescriptions } = require('./listing-description');

function listingKindOfKeys(keys) {
  return parseListingKind(keys && keys.kind)
    || kindFromIdentityName(keys && keys.identity)
    || 'agent';
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function assertDataSetupAllowed({ kind, identity, agentConfig } = {}) {
  const k = parseListingKind(kind) || kindFromIdentityName(identity) || kind;
  if (k !== 'data') {
    throw fail('DATA_SETUP_WRONG_KIND',
      'DATA_SETUP_WRONG_KIND: data-setup is for kind=data listings only');
  }
  const cfg = agentConfig && typeof agentConfig === 'object' ? agentConfig : {};
  if (cfg.apiEndpointUrl || cfg.serviceType === 'gpu-rental') {
    throw fail('DATA_SLOT_CONFLICT',
      'DATA_SLOT_CONFLICT: this agent already has an api-endpoint or gpu-rental slot; data listings need a separate agent');
  }
}

function assertHttpUrl(value, label) {
  const raw = String(value || '').trim();
  const url = httpUrlString(raw);
  if (!url) {
    throw fail('DATA_SETUP_BAD_URL', `DATA_SETUP_BAD_URL: ${label} must be an HTTP(S) URL`);
  }
  if (descriptionHasEphemeralUrl(url)) {
    throw fail('DESCRIPTION_EPHEMERAL_URL',
      'DESCRIPTION_EPHEMERAL_URL: data listing URLs cannot be tunnel or LAN. Use a stable HTTP(S) website / network endpoint.');
  }
  return url;
}

function parseCsvUrls(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

function parseDataSetupUrls({ website, networkEndpoints } = {}) {
  const site = website != null && String(website).trim() !== ''
    ? assertHttpUrl(website, '--website')
    : null;
  const endpoints = parseCsvUrls(networkEndpoints).map((u) => assertHttpUrl(u, '--network-endpoints'));
  if (!site && endpoints.length === 0) {
    throw fail('DATA_SETUP_NO_ENDPOINT',
      'DATA_SETUP_NO_ENDPOINT: pass --website and/or --network-endpoints (HTTP(S) only)');
  }
  return { website: site, networkEndpoints: endpoints };
}

function applyDataAgentConfig(existing, { website, networkEndpoints, onChain } = {}) {
  const next = Object.assign({}, existing && typeof existing === 'object' ? existing : {});
  if (website) next.website = website;
  if (networkEndpoints && networkEndpoints.length) next.networkEndpoints = networkEndpoints;
  if (onChain === true) {
    delete next.dataEndpointLocalOnly;
  } else if (website || (networkEndpoints && networkEndpoints.length)) {
    // Buyer browse reads GET /v1/agents/:seller, not this file.
    next.dataEndpointLocalOnly = true;
  }
  return next;
}

function buildDataVdxfFields({ website, networkEndpoints, description } = {}) {
  const fields = {};
  if (website) fields.profileWebsite = website;
  if (networkEndpoints && networkEndpoints.length) {
    fields.networkEndpoints = JSON.stringify(networkEndpoints);
  }
  if (description) fields.description = description;
  return fields;
}

function firstDataEndpoint(agentConfig) {
  if (!agentConfig || typeof agentConfig !== 'object') return null;
  if (Array.isArray(agentConfig.networkEndpoints)) {
    for (const ep of agentConfig.networkEndpoints) {
      const u = httpUrlString(typeof ep === 'string' ? ep : (ep && ep.url));
      if (u) return u;
    }
  } else if (typeof agentConfig.networkEndpoints === 'string') {
    const u = httpUrlString(agentConfig.networkEndpoints);
    if (u) return u;
  }
  return httpUrlString(agentConfig.website) || null;
}

function dataEndpointRefusal(agentConfig) {
  const url = firstDataEndpoint(agentConfig);
  if (!url) {
    return {
      code: 'data.endpoint',
      message: 'data.endpoint: no HTTP(S) website or networkEndpoints — run data-setup --website https://...',
    };
  }
  if (descriptionHasEphemeralUrl(url)) {
    return {
      code: 'data.endpoint',
      message: 'data.endpoint: website/networkEndpoints is ephemeral (trycloudflare/ngrok/localhost/RFC1918) — run data-setup --website https://...',
    };
  }
  if (agentConfig.dataEndpointLocalOnly) {
    return {
      code: 'data.endpoint',
      message: 'data.endpoint: website is local-only — browse will not see it until data-setup writes VDXF (drop --no-register)',
    };
  }
  return null;
}

function assertDataSetupDescription({ kind, identity, description } = {}) {
  if (!description) return;
  const err = refuseDataListingDescriptions({
    kind: kind || 'data',
    identity,
    descriptions: [description],
  });
  if (err) throw err;
}

function dataSetupNextLines(identity, { localOnly, agentId } = {}) {
  if (localOnly) {
    const id = agentId || '<agent-id>';
    return [
      `Next: j41-dispatcher data-setup ${id} --website https://...`,
      '      browse will not see this URL until the on-chain VDXF write (drop --no-register)',
    ];
  }
  const seller = identity || '<seller>';
  return [
    `Next: j41-dispatcher listings --kind data`,
    `      j41-dispatcher browse ${seller}`,
  ];
}

function planDataSetup({ keys, agentConfig, website, networkEndpoints, description } = {}) {
  const kind = listingKindOfKeys(keys);
  const identity = keys && keys.identity;
  assertDataSetupAllowed({ kind, identity, agentConfig });
  const parsed = parseDataSetupUrls({ website, networkEndpoints });
  assertDataSetupDescription({ kind, identity, description });
  return {
    kind,
    parsed,
    agentConfig: applyDataAgentConfig(agentConfig, parsed),
    fieldsToUpdate: buildDataVdxfFields({ ...parsed, description }),
    nextLines: dataSetupNextLines(identity),
  };
}

module.exports = {
  listingKindOfKeys,
  assertDataSetupAllowed,
  assertHttpUrl,
  parseDataSetupUrls,
  applyDataAgentConfig,
  buildDataVdxfFields,
  firstDataEndpoint,
  dataEndpointRefusal,
  assertDataSetupDescription,
  dataSetupNextLines,
  planDataSetup,
};
