'use strict';
/**
 * Listing kinds the platform mints. Keep in lockstep with
 * @junction41/sovagent-sdk hosting/kinds and junction41 src/hosting/kinds.ts.
 *
 * Intended parents: sovagent@ / sovcompute@ / sovdata@ / sovmodel@.
 * VRSCTEST DeFi is off, so new names mint under agentplatform@ and the real
 * kind is stored in platform.config.kind / keys.json.
 */

const LISTING_KINDS = Object.freeze(['agent', 'compute', 'data', 'model']);

const KIND_PARENTS = Object.freeze({
  agent: 'sovagent@',
  compute: 'sovcompute@',
  data: 'sovdata@',
  model: 'sovmodel@',
});

const LEGACY_AGENT_PARENT = 'agentplatform@';

const KIND_BLURB = Object.freeze({
  agent: 'An AI you hire to do an advertised task',
  compute: 'A GPU / SSH box buyers can rent and run their own workload',
  data: 'A dataset agents can query (you host the bytes)',
  model: 'Talk to a specific model that is for sale (metered inference)',
});

function parseListingKind(raw) {
  if (raw === 'agent' || raw === 'compute' || raw === 'data' || raw === 'model') return raw;
  return null;
}

function advertisedIdentity(name, kind) {
  const n = String(name || '').trim().replace(/@+$/, '');
  if (!n) return '';
  if (n.includes('.')) return n.endsWith('@') ? n : `${n}@`;
  return `${n}.${LEGACY_AGENT_PARENT}`;
}

function kindFromIdentityName(name) {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  if (n.endsWith('.sovagent@') || n.endsWith('.agentplatform@')) return 'agent';
  if (n.endsWith('.sovcompute@')) return 'compute';
  if (n.endsWith('.sovdata@')) return 'data';
  if (n.endsWith('.sovmodel@')) return 'model';
  return null;
}

function leafFromIdentity(name) {
  if (!name) return '';
  const n = String(name).trim().replace(/@+$/, '');
  const dot = n.indexOf('.');
  return dot === -1 ? n : n.slice(0, dot);
}

function listingIdPrefix(kind) {
  const k = parseListingKind(kind) || 'agent';
  return k;
}

function identitiesEqual(a, b) {
  if (!a || !b) return false;
  const na = String(a).trim().toLowerCase().replace(/@+$/, '');
  const nb = String(b).trim().toLowerCase().replace(/@+$/, '');
  return na === nb;
}

/**
 * Same leaf under agentplatform@ is a collision even across kinds — DeFi is
 * off, so there is only one parent.
 */
function listingsCollide(existing, candidate, kind) {
  if (!existing || !candidate) return false;
  const want = advertisedIdentity(candidate, kind);
  if (identitiesEqual(existing, want) || identitiesEqual(existing, candidate)) return true;
  return leafFromIdentity(existing) === leafFromIdentity(candidate)
    && leafFromIdentity(existing) === leafFromIdentity(want);
}

module.exports = {
  LISTING_KINDS,
  KIND_PARENTS,
  KIND_BLURB,
  LEGACY_AGENT_PARENT,
  parseListingKind,
  advertisedIdentity,
  kindFromIdentityName,
  leafFromIdentity,
  listingIdPrefix,
  identitiesEqual,
  listingsCollide,
};
