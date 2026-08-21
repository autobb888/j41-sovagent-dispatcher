'use strict';
/**
 * Listing kinds the platform mints. Keep in lockstep with
 * @junction41/sovagent-sdk hosting/kinds and junction41 src/hosting/kinds.ts.
 * sovmodel is a catalog, not a mintable kind.
 */

const LISTING_KINDS = Object.freeze(['agent', 'compute', 'data']);

const KIND_PARENTS = Object.freeze({
  agent: 'sovagent@',
  compute: 'sovcompute@',
  data: 'sovdata@',
});

const LEGACY_AGENT_PARENT = 'agentplatform@';

const KIND_BLURB = Object.freeze({
  agent: 'An AI that takes jobs on the marketplace',
  compute: 'GPUs or an inference endpoint buyers can meter',
  data: 'A dataset or query API you host yourself',
});

function parseListingKind(raw) {
  if (raw === 'agent' || raw === 'compute' || raw === 'data') return raw;
  return null;
}

function advertisedIdentity(name, kind) {
  const n = String(name || '').trim().replace(/@+$/, '');
  if (!n) return '';
  if (n.includes('.')) return n.endsWith('@') ? n : `${n}@`;
  const k = parseListingKind(kind) || 'agent';
  return `${n}.${KIND_PARENTS[k]}`;
}

function kindFromIdentityName(name) {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  if (n.endsWith('.sovagent@') || n.endsWith('.agentplatform@')) return 'agent';
  if (n.endsWith('.sovcompute@')) return 'compute';
  if (n.endsWith('.sovdata@')) return 'data';
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
 * True if two names collide as the same listing: same fully-qualified identity,
 * or the same leaf under the same kind (including legacy agentplatform@ ≡ sovagent@).
 */
function listingsCollide(existing, candidate, kind) {
  if (!existing || !candidate) return false;
  const want = advertisedIdentity(candidate, kind);
  if (identitiesEqual(existing, want) || identitiesEqual(existing, candidate)) return true;
  const existingKind = kindFromIdentityName(existing) || 'agent';
  const wantKind = parseListingKind(kind) || kindFromIdentityName(candidate) || 'agent';
  return existingKind === wantKind && leafFromIdentity(existing) === leafFromIdentity(candidate);
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
