'use strict';
const { identitiesEqual } = require('./listing-kind');

function loadBuyerAllowlist(agentCfg) {
  const raw = agentCfg && agentCfg.buyerAllowlist;
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => String(s || '').trim()).filter(Boolean);
}

function buyerMatchesAllowlist(buyerVerusId, allowlist, { names = [], resolved = [] } = {}) {
  const candidates = [buyerVerusId, ...names, ...resolved].filter(Boolean);
  for (const entry of allowlist) {
    for (const c of candidates) {
      if (identitiesEqual(entry, c)) return true;
    }
  }
  return false;
}

function decideAutoAccept({
  chainStatus, allowlist, preferAllowlist, buyerVerusId, names, resolved, hasAllowlistedSibling,
}) {
  const st = String(chainStatus || '').trim().toLowerCase();
  const list = Array.isArray(allowlist) ? allowlist : [];
  const matched = buyerMatchesAllowlist(buyerVerusId, list, { names, resolved });
  if (st === 'inactive') return { action: 'hold', reason: 'inactive' };
  if (st === 'invite') {
    if (list.length === 0) return { action: 'hold', reason: 'empty allowlist' };
    if (matched) return { action: 'accept', reason: 'allowlisted' };
    return { action: 'hold', reason: 'not on allowlist' };
  }
  // active / missing: floodgate, unless local preferAllowlist
  if (!preferAllowlist) return { action: 'accept', reason: 'open' };
  if (matched) return { action: 'accept', reason: 'allowlisted' };
  if (hasAllowlistedSibling) return { action: 'defer', reason: 'allowlisted hire waiting' };
  return { action: 'accept', reason: 'open, no friend waiting' };
}

function addBuyerAllowlistEntry(cfg, entry) {
  const next = Object.assign({}, cfg && typeof cfg === 'object' ? cfg : {});
  const list = loadBuyerAllowlist(next);
  const e = String(entry || '').trim();
  if (!e) return next;
  if (!list.some((x) => identitiesEqual(x, e))) list.push(e);
  next.buyerAllowlist = list;
  return next;
}

function removeBuyerAllowlistEntry(cfg, entry) {
  const next = Object.assign({}, cfg && typeof cfg === 'object' ? cfg : {});
  next.buyerAllowlist = loadBuyerAllowlist(next).filter((x) => !identitiesEqual(x, entry));
  return next;
}

const { VDXF_KEYS } = require('@junction41/sovagent-sdk/dist/onboarding/vdxf.js');
const STATUS_KEY = VDXF_KEYS.agent.status;

function unwrapStatusValue(entry) {
  if (entry == null) return null;
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry)) return unwrapStatusValue(entry[0]);
  const inner = entry.objectdata || entry.message || entry;
  if (typeof inner === 'string') return inner;
  if (inner && typeof inner === 'object' && inner.message) return String(inner.message);
  return null;
}

function readChainSalesStatus(identityRaw) {
  const cmm = (identityRaw && (identityRaw.contentmultimap || identityRaw.identity?.contentmultimap)) || {};
  const raw = unwrapStatusValue(cmm[STATUS_KEY]);
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'active' || s === 'inactive' || s === 'invite') return s;
  return null;
}

const _resolveCache = new Map();
async function resolveAllowlistEntries(allowlist, getIdentity) {
  const out = [];
  for (const entry of allowlist) {
    const e = String(entry || '').trim();
    if (!e) continue;
    if (/^i[1-9A-HJ-NP-Za-km-z]{25,}$/.test(e)) { out.push(e); continue; }
    if (_resolveCache.has(e)) { out.push(_resolveCache.get(e)); continue; }
    try {
      const id = await getIdentity(e);
      const iAddr = id?.identity?.identityaddress || id?.identityaddress || id?.iAddress;
      if (iAddr) { _resolveCache.set(e, iAddr); out.push(iAddr); }
    } catch { /* leave unmatched */ }
  }
  return out;
}

function clearSalesStatusCache() { /* chain-status cache lives next to this; export for sales-mode */ }
function clearAllowlistResolveCache() { _resolveCache.clear(); }

module.exports = {
  loadBuyerAllowlist, buyerMatchesAllowlist, decideAutoAccept,
  addBuyerAllowlistEntry, removeBuyerAllowlistEntry,
  readChainSalesStatus, resolveAllowlistEntries,
  clearAllowlistResolveCache, clearSalesStatusCache,
};
