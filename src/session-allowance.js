'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { satsOf } = require('./dataset-price');
const { formatVrsc } = require('./wallet');
const { acquireFileLockSync, releaseFileLock } = require('./file-lock');

const JOB_ID_RE = /^[0-9a-f-]{36}$/i;
const TOMBSTONE_STATUSES = new Set(['completed', 'cancelled', 'resolved', 'resolved_rejected']);
const OPEN_STATUSES = new Set(['in_progress', 'paused', 'rework']);

function sessionPartyKey(value) {
  return String(value || '').trim().toLowerCase().replace(/@+$/, '');
}

function sessionReserveDecision({
  jobAmountSats, spentSats, reservedSats, estimatedCostSats, status, closed,
}) {
  if (closed) return { ok: false, code: 'SESSION_CLOSED' };
  if (status !== 'in_progress' && status !== 'paused' && status !== 'rework') {
    return { ok: false, code: 'SESSION_NOT_OPEN' };
  }
  if (!Number.isInteger(jobAmountSats) || jobAmountSats <= 0) {
    return { ok: false, code: 'SESSION_NOT_OPEN' };
  }
  if (!Number.isInteger(estimatedCostSats) || estimatedCostSats <= 0) {
    return { ok: false, code: 'SESSION_UNPRICED' };
  }
  const spent = Number.isInteger(spentSats) ? spentSats : NaN;
  const reserved = Number.isInteger(reservedSats) ? reservedSats : NaN;
  if (!Number.isInteger(spent) || spent < 0 || !Number.isInteger(reserved) || reserved < 0) {
    return { ok: false, code: 'SESSION_STATE_MISSING' };
  }
  const remaining = jobAmountSats - spent - reserved;
  if (remaining < estimatedCostSats) {
    return { ok: false, code: 'SESSION_EXHAUSTED', remainingSats: remaining };
  }
  return { ok: true, remainingSats: remaining };
}

function assertAgentId(agentId) {
  if (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 200) {
    return { ok: false, code: 'SESSION_JOB_ID' };
  }
  if (agentId !== path.basename(agentId)) return { ok: false, code: 'SESSION_JOB_ID' };
  if (/[\\/\0]/.test(agentId) || agentId === '.' || agentId === '..') {
    return { ok: false, code: 'SESSION_JOB_ID' };
  }
  return { ok: true, agentId };
}

function assertSessionJobId(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId) || path.basename(jobId) !== jobId) {
    return { ok: false, code: 'SESSION_JOB_ID' };
  }
  return { ok: true, jobId };
}

function agentsRoot() {
  return path.join(os.homedir(), '.j41', 'dispatcher', 'agents');
}

function sessionsDir(agentId) {
  return path.join(agentsRoot(), agentId, 'sessions');
}

function sessionLockPath(agentId) {
  return path.join(sessionsDir(agentId), 'sessions.lock');
}

function sessionFilePath(agentId, jobId) {
  return path.join(sessionsDir(agentId), `${jobId}.json`);
}

function jobOwnsModelWindow(job) {
  if (!job || typeof job !== 'object') return false;
  const type = job.serviceType || job.service_type;
  const kind = job.kind || job.listingKind;
  return type === 'api-endpoint' || kind === 'model';
}

function jobSellerId(job) {
  if (!job || typeof job !== 'object') return '';
  return job.sellerVerusId || job.seller_verus_id || job.sellerId || job.agentVerusId || '';
}

function jobBuyerId(job) {
  if (!job || typeof job !== 'object') return '';
  return job.buyerVerusId || job.buyer_verus_id || job.buyerId || '';
}

function jobAmountSats(amount) {
  const parsed = satsOf(amount);
  if (!parsed.ok || !Number.isInteger(parsed.sats)) return { ok: false, code: 'SESSION_NOT_OPEN' };
  return { ok: true, sats: parsed.sats };
}

function freshSession(jobId, now) {
  return {
    jobId,
    openedAt: now || new Date().toISOString(),
    spentSats: 0,
    reservedSats: 0,
    closed: false,
  };
}

function readSessionRaw(agentId, jobId) {
  const file = sessionFilePath(agentId, jobId);
  if (!fs.existsSync(file)) return { missing: true };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return { error: 'SESSION_STATE_MISSING' }; }
  let data;
  try { data = JSON.parse(raw); }
  catch { return { error: 'SESSION_STATE_MISSING' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: 'SESSION_STATE_MISSING' };
  }
  return { session: data };
}

function writeSession(agentId, jobId, session) {
  const dir = sessionsDir(agentId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = sessionFilePath(agentId, jobId);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* mode on create is enough */ }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

function withSessionLock(agentId, fn, { failOpen = false } = {}) {
  const gate = assertAgentId(agentId);
  if (!gate.ok) return gate;
  const lockPath = sessionLockPath(agentId);
  const token = acquireFileLockSync(lockPath);
  if (!token) {
    if (!failOpen) return { ok: false, code: 'SESSION_LOCK_BUSY' };
    console.warn(`[session] lock busy for ${agentId}; writing without the lock`);
    return fn();
  }
  try {
    return fn();
  } finally {
    releaseFileLock(lockPath, token);
  }
}

function createSessionIfAbsent({ agentId, jobId, now } = {}) {
  const agent = assertAgentId(agentId);
  if (!agent.ok) return agent;
  const id = assertSessionJobId(jobId);
  if (!id.ok) return id;
  return withSessionLock(agentId, () => {
    const cur = readSessionRaw(agentId, jobId);
    if (cur.error) return { ok: false, code: cur.error };
    if (cur.session) return { ok: true, created: false, session: cur.session };
    const session = freshSession(jobId, now);
    writeSession(agentId, jobId, session);
    return { ok: true, created: true, session };
  });
}

function closeSession({ agentId, jobId, now } = {}) {
  const agent = assertAgentId(agentId);
  if (!agent.ok) return agent;
  const id = assertSessionJobId(jobId);
  if (!id.ok) return id;
  return withSessionLock(agentId, () => {
    const cur = readSessionRaw(agentId, jobId);
    if (cur.error) return { ok: false, code: cur.error };
    const base = cur.session || freshSession(jobId, now);
    const next = {
      jobId,
      openedAt: base.openedAt || (now || new Date().toISOString()),
      spentSats: Number.isInteger(base.spentSats) ? base.spentSats : 0,
      reservedSats: Number.isInteger(base.reservedSats) ? base.reservedSats : 0,
      closed: true,
    };
    writeSession(agentId, jobId, next);
    return { ok: true, session: next };
  });
}

function reserveForChat({
  agentId, jobId, status, jobAmountSats: amountSats, estimatedCostSats, paymentReady, now,
} = {}) {
  const agent = assertAgentId(agentId);
  if (!agent.ok) return agent;
  const id = assertSessionJobId(jobId);
  if (!id.ok) return id;
  if (TOMBSTONE_STATUSES.has(status)) {
    const closed = closeSession({ agentId, jobId, now });
    if (!closed.ok) return closed;
    return { ok: false, code: 'SESSION_CLOSED' };
  }
  if (status === 'disputed') return { ok: false, code: 'SESSION_NOT_OPEN' };
  return withSessionLock(agentId, () => {
    const cur = readSessionRaw(agentId, jobId);
    if (cur.error) return { ok: false, code: cur.error };
    let session = cur.session || null;
    if (session && session.closed === true) return { ok: false, code: 'SESSION_CLOSED' };
    if (!session) {
      if (status === 'rework') return { ok: false, code: 'SESSION_STATE_MISSING' };
      if ((status === 'in_progress' || status === 'paused') && paymentReady) {
        session = freshSession(jobId, now);
      } else {
        return { ok: false, code: 'SESSION_NOT_OPEN' };
      }
    }
    const decision = sessionReserveDecision({
      jobAmountSats: amountSats,
      spentSats: session.spentSats,
      reservedSats: session.reservedSats,
      estimatedCostSats,
      status,
      closed: session.closed === true,
    });
    if (!decision.ok) return decision;
    const next = {
      ...session,
      jobId,
      reservedSats: session.reservedSats + estimatedCostSats,
      closed: false,
    };
    writeSession(agentId, jobId, next);
    return {
      ok: true,
      remainingSats: amountSats - next.spentSats - next.reservedSats,
      reservedSats: estimatedCostSats,
      session: next,
    };
  });
}

function applySpend(session, estimatedCostSats, actualSats, { releaseOnly }) {
  const reserved = Number.isInteger(session.reservedSats) ? session.reservedSats : 0;
  const spent = Number.isInteger(session.spentSats) ? session.spentSats : 0;
  const est = Number.isInteger(estimatedCostSats) && estimatedCostSats > 0 ? estimatedCostSats : 0;
  const actual = !releaseOnly && Number.isInteger(actualSats) && actualSats >= 0 ? actualSats : 0;
  return {
    jobId: session.jobId,
    openedAt: session.openedAt || new Date().toISOString(),
    reservedSats: Math.max(0, reserved - est),
    spentSats: releaseOnly ? spent : spent + actual,
    closed: session.closed === true,
  };
}

function mutateSpend({ agentId, jobId, estimatedCostSats, actualSats, jobAmountSats: amountSats, releaseOnly }) {
  const agent = assertAgentId(agentId);
  if (!agent.ok) return agent;
  const id = assertSessionJobId(jobId);
  if (!id.ok) return id;
  const apply = () => {
    const cur = readSessionRaw(agentId, jobId);
    const base = (cur && cur.session) || freshSession(jobId);
    const next = applySpend(base, estimatedCostSats, actualSats, { releaseOnly });
    next.jobId = jobId;
    if (base.closed === true) next.closed = true;
    writeSession(agentId, jobId, next);
    const remaining = Number.isInteger(amountSats)
      ? amountSats - next.spentSats - next.reservedSats
      : null;
    return { ok: true, remainingSats: remaining, session: next, costSats: releaseOnly ? 0 : (actualSats || 0) };
  };
  return withSessionLock(agentId, apply, { failOpen: true });
}

function settleSession(args = {}) {
  return mutateSpend({ ...args, releaseOnly: false });
}

function releaseSession(args = {}) {
  return mutateSpend({ ...args, releaseOnly: true, actualSats: 0 });
}

function releaseStartupReservations(agentId) {
  const agent = assertAgentId(agentId);
  if (!agent.ok) return agent;
  const dir = sessionsDir(agentId);
  if (!fs.existsSync(dir)) return { ok: true, released: [] };
  let names = [];
  try { names = fs.readdirSync(dir); }
  catch { return { ok: true, released: [] }; }
  const released = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const jobId = name.slice(0, -'.json'.length);
    if (!assertSessionJobId(jobId).ok) continue;
    const result = withSessionLock(agentId, () => {
      const cur = readSessionRaw(agentId, jobId);
      if (!cur.session || cur.session.closed === true) return { ok: true, skipped: true };
      if (!Number.isInteger(cur.session.reservedSats) || cur.session.reservedSats <= 0) {
        return { ok: true, skipped: true };
      }
      const amount = cur.session.reservedSats;
      const next = { ...cur.session, reservedSats: 0, closed: cur.session.closed === true };
      writeSession(agentId, jobId, next);
      return { ok: true, releasedSats: amount, jobId };
    });
    if (!result || result.ok === false) return result || { ok: false, code: 'SESSION_LOCK_BUSY' };
    if (result.releasedSats) {
      console.log(`[session] released ${result.releasedSats} reserved sats on ${jobId}`);
      released.push({ jobId, releasedSats: result.releasedSats });
    }
  }
  return { ok: true, released };
}

function listOpenSessionJobIds(agentId) {
  const agent = assertAgentId(agentId);
  if (!agent.ok) return [];
  const dir = sessionsDir(agentId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const jobId = name.slice(0, -'.json'.length);
    if (!assertSessionJobId(jobId).ok) continue;
    const cur = readSessionRaw(agentId, jobId);
    if (cur.session && cur.session.closed !== true) out.push(jobId);
  }
  return out;
}

function readSession(agentId, jobId) {
  const cur = readSessionRaw(agentId, jobId);
  return cur.session || null;
}

function calculateCost(modelPricing, model, inputTokens, outputTokens) {
  const pricing = (modelPricing || []).find((p) => p && p.model === model);
  if (!pricing) return 0;
  const ir = Number(pricing.inputTokenRate);
  const orate = Number(pricing.outputTokenRate);
  if (!Number.isFinite(ir) || !Number.isFinite(orate) || ir < 0 || orate < 0) return Infinity;
  const input = Number(inputTokens);
  const output = Number(outputTokens);
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return Infinity;
  return (input * ir) + (output * orate);
}

function estimateCostSats({ modelPricing, model, inputTokens, outputTokens } = {}) {
  const pricing = (modelPricing || []).find((p) => p && p.model === model);
  if (pricing) {
    const ir = Number(pricing.inputTokenRate);
    const orate = Number(pricing.outputTokenRate);
    if (ir === 0 || orate === 0) return { ok: false, code: 'SESSION_UNPRICED' };
  }
  const vrsc = calculateCost(modelPricing, model, inputTokens, outputTokens);
  if (!Number.isFinite(vrsc) || vrsc <= 0) return { ok: false, code: 'SESSION_UNPRICED' };
  const sats = satsOf(vrsc);
  if (!sats.ok || !Number.isInteger(sats.sats) || sats.sats <= 0) {
    return { ok: false, code: 'SESSION_UNPRICED' };
  }
  return { ok: true, sats: sats.sats, vrsc };
}

function remainingHeader(remainingSats) {
  if (!Number.isInteger(remainingSats) || remainingSats < 0) return null;
  return formatVrsc(remainingSats);
}

function sessionHttpStatus(code) {
  if (code === 'SESSION_EXHAUSTED' || code === 'SESSION_UNPRICED') return 402;
  if (code === 'SESSION_JOB_ID') return 400;
  if (code === 'SESSION_PLATFORM_UNAVAILABLE' || code === 'SESSION_LOCK_BUSY') return 503;
  return 409;
}

function sessionErrorBody({ code, status, jobId } = {}) {
  const body = { error: code, code };
  if (status) body.status = status;
  if (jobId) body.jobId = jobId;
  if (code === 'SESSION_EXHAUSTED' && (status === 'in_progress' || status === 'paused')) {
    body.message = `This job's allowance does not cover the call. Extend job ${jobId} while it is open.`;
  } else if (code === 'SESSION_EXHAUSTED') {
    body.message = "This job's allowance does not cover the call.";
  } else if (code === 'SESSION_CLOSED') {
    body.message = 'This window is closed. Hire again.';
  } else if (code === 'SESSION_UNPRICED') {
    body.message = 'This model has no session price for the call.';
  } else if (code === 'SESSION_NOT_OPEN') {
    body.message = 'This job is not an open session.';
  } else if (code === 'SESSION_STATE_MISSING') {
    body.message = 'This job has no session record to continue.';
  } else if (code === 'SESSION_BUYER_UNRESOLVED') {
    body.message = 'The buyer on this key could not be matched to the job.';
  } else if (code === 'SESSION_LOCK_BUSY') {
    body.message = 'The session file is busy. Retry the call.';
  } else if (code === 'SESSION_PLATFORM_UNAVAILABLE') {
    body.message = 'The job could not be read. Nothing was reserved.';
  }
  return body;
}

async function identityIAddress(getIdentityKeys, name) {
  if (typeof getIdentityKeys !== 'function' || !name) return null;
  const keys = await getIdentityKeys(name);
  if (!keys || typeof keys !== 'object') return null;
  return keys.iaddress || keys.iAddress || keys.identityaddress || null;
}

async function partiesMatch({ left, right, also, getIdentityKeys } = {}) {
  const L = sessionPartyKey(left);
  const R = sessionPartyKey(right);
  const A = sessionPartyKey(also);
  if (L && (L === R || (A && L === A))) return { ok: true };
  if (!L) return { ok: false, code: 'SESSION_BUYER_UNRESOLVED' };
  if (typeof getIdentityKeys !== 'function') return { ok: false, code: 'SESSION_BUYER_UNRESOLVED' };
  try {
    const li = sessionPartyKey(await identityIAddress(getIdentityKeys, left));
    if (!li) return { ok: false, code: 'SESSION_BUYER_UNRESOLVED' };
    const ri = R ? sessionPartyKey(await identityIAddress(getIdentityKeys, right)) : '';
    const ai = A ? sessionPartyKey(await identityIAddress(getIdentityKeys, also)) : '';
    if (!ri && !ai) return { ok: false, code: 'SESSION_BUYER_UNRESOLVED' };
    if ((ri && li === ri) || (ai && li === ai)) return { ok: true };
    return { ok: false, code: 'SESSION_NOT_OPEN' };
  } catch {
    return { ok: false, code: 'SESSION_BUYER_UNRESOLVED' };
  }
}

async function sellerOwnsJob(job, agentInfo, getIdentityKeys) {
  const seller = jobSellerId(job);
  const info = agentInfo || {};
  const candidates = [info.identity, info.iAddress, info.identityName].filter(Boolean);
  if (!sessionPartyKey(seller)) return false;
  if (candidates.some((c) => sessionPartyKey(c) === sessionPartyKey(seller))) return true;
  const matched = await partiesMatch({
    left: seller,
    right: info.identity,
    also: info.iAddress,
    getIdentityKeys,
  });
  return !!matched.ok;
}

module.exports = {
  sessionPartyKey,
  sessionReserveDecision,
  assertAgentId,
  assertSessionJobId,
  sessionLockPath,
  sessionFilePath,
  jobOwnsModelWindow,
  jobSellerId,
  jobBuyerId,
  jobAmountSats,
  createSessionIfAbsent,
  closeSession,
  reserveForChat,
  settleSession,
  releaseSession,
  releaseStartupReservations,
  listOpenSessionJobIds,
  readSession,
  calculateCost,
  estimateCostSats,
  remainingHeader,
  sessionHttpStatus,
  sessionErrorBody,
  partiesMatch,
  sellerOwnsJob,
  OPEN_STATUSES,
  TOMBSTONE_STATUSES,
};
