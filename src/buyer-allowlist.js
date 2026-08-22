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

const { VDXF_KEYS, DATA_DESCRIPTOR_KEY } = require('@junction41/sovagent-sdk/dist/onboarding/vdxf.js');
const STATUS_KEY = VDXF_KEYS.agent.status;

function messageFromObjectdata(od) {
  if (od == null) return null;
  if (typeof od === 'object') {
    if (od.message != null) return String(od.message);
    return null;
  }
  if (typeof od !== 'string') return null;
  try {
    const decoded = Buffer.from(od, 'hex').toString('utf-8');
    try {
      const parsed = JSON.parse(decoded);
      if (typeof parsed === 'string') return parsed;
      if (parsed && typeof parsed === 'object' && parsed.message != null) return String(parsed.message);
    } catch {
      if (decoded) return decoded;
    }
  } catch { /* fall through */ }
  return od;
}

function unwrapStatusValue(entry) {
  if (entry == null) return null;
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry)) {
    if (entry.length === 0) return null;
    return unwrapStatusValue(entry[entry.length - 1]);
  }
  if (typeof entry !== 'object') return null;

  const dd = entry[DATA_DESCRIPTOR_KEY];
  if (dd && typeof dd === 'object') {
    const fromDd = messageFromObjectdata(dd.objectdata);
    if (fromDd != null) return fromDd;
  }
  if (entry.objectdata != null) {
    const fromOd = messageFromObjectdata(entry.objectdata);
    if (fromOd != null) return fromOd;
  }
  if (entry.message != null) return String(entry.message);

  const inner = Object.values(entry)[0];
  if (inner && typeof inner === 'object') {
    const fromInner = messageFromObjectdata(inner.objectdata);
    if (fromInner != null) return fromInner;
    if (inner.message != null) return String(inner.message);
  }
  return null;
}

function inspectChainSalesStatus(identityRaw) {
  if (identityRaw == null || typeof identityRaw !== 'object') {
    return { status: null, present: false, unparseable: false, unread: true };
  }
  const cmm = identityRaw.contentmultimap || identityRaw.identity?.contentmultimap;
  if (cmm == null || typeof cmm !== 'object') {
    return { status: null, present: false, unparseable: false, unread: false };
  }
  if (!Object.prototype.hasOwnProperty.call(cmm, STATUS_KEY) || cmm[STATUS_KEY] == null) {
    return { status: null, present: false, unparseable: false, unread: false };
  }
  const raw = unwrapStatusValue(cmm[STATUS_KEY]);
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'active' || s === 'inactive' || s === 'invite') {
    return { status: s, present: true, unparseable: false, unread: false };
  }
  return { status: null, present: true, unparseable: true, unread: false };
}

function readChainSalesStatus(identityRaw) {
  return inspectChainSalesStatus(identityRaw).status;
}

function iAddressFromLookup(record) {
  if (!record || typeof record !== 'object') return null;
  const cand = record.identity?.identityaddress
    || record.identityaddress
    || record.iAddress
    || record.iaddress
    || record.verusId
    || record.id;
  if (cand == null) return null;
  const s = String(cand).trim();
  return s || null;
}

const _resolveCache = new Map();
async function resolveAllowlistEntries(allowlist, getIdentity, getAgent) {
  const out = [];
  for (const entry of allowlist) {
    const e = String(entry || '').trim();
    if (!e) continue;
    if (/^i[1-9A-HJ-NP-Za-km-z]{25,}$/.test(e)) { out.push(e); continue; }
    if (_resolveCache.has(e)) { out.push(_resolveCache.get(e)); continue; }
    let iAddr = null;
    if (typeof getIdentity === 'function') {
      try {
        iAddr = iAddressFromLookup(await getIdentity(e));
      } catch { /* PLATFORM_SIGNER_REQUIRED, RPC, etc. */ }
    }
    if (!iAddr && typeof getAgent === 'function') {
      try {
        iAddr = iAddressFromLookup(await getAgent(e));
      } catch { /* not a listed agent */ }
    }
    if (iAddr) { _resolveCache.set(e, iAddr); out.push(iAddr); }
  }
  return out;
}

function buyerNamesFromJob(job) {
  if (!job) return [];
  return [job.buyer?.identityName, job.buyer?.name, job.buyerIdentity].filter(Boolean);
}

function hasAllowlistedRequestedSibling(jobs, currentJobId, allowlist) {
  const list = Array.isArray(allowlist) ? allowlist : [];
  for (const other of jobs || []) {
    if (!other || other.id === currentJobId) continue;
    if (other.status !== 'requested') continue;
    if (buyerMatchesAllowlist(other.buyerVerusId, list, {
      names: buyerNamesFromJob(other),
    })) return true;
  }
  return false;
}

function clearSalesStatusCache() { /* chain-status cache lives next to this; export for sales-mode */ }
function clearAllowlistResolveCache() { _resolveCache.clear(); }

module.exports = {
  loadBuyerAllowlist, buyerMatchesAllowlist, decideAutoAccept,
  addBuyerAllowlistEntry, removeBuyerAllowlistEntry,
  readChainSalesStatus, inspectChainSalesStatus, resolveAllowlistEntries,
  iAddressFromLookup,
  buyerNamesFromJob, hasAllowlistedRequestedSibling,
  clearAllowlistResolveCache, clearSalesStatusCache,
};
