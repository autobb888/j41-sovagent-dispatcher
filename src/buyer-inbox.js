'use strict';

/**
 * Publish buyer content maps from the buyer's own inbox.
 *
 * The platform inserts job_record on complete, and copies review.record plus
 * review.attestation when the seller accepts a job review. It does not call
 * updateidentity. A session review has no job, so it is not copied.
 *
 * This module does not build an identity update. processOnce must be the
 * seller accept path (witness check, then acceptInboxBatch). One transaction
 * can carry one of each VDXF key; the next waits until that write is the
 * identity's confirmed prevOutput.
 */

const BUYER_INBOX_TYPES = ['job_record', 'review', 'attestation'];
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 15000;
const DEFAULT_CONFIRM_TIMEOUT_MS = 3 * 60 * 1000;
const BACKLOG_TIMEOUT_MS = 50 * 60 * 1000;
const DEFAULT_MAX_CYCLES = 80;

function inboxRows(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.data)) return raw.data;
  return [];
}

function actionableItems(raw) {
  return inboxRows(raw).filter((it) => (
    it && BUYER_INBOX_TYPES.includes(it.type) && it.status !== 'expired'
  ));
}

function itemRefs(it) {
  const refs = [];
  if (it.jobHash) refs.push(it.jobHash);
  if (it.jobId) refs.push(it.jobId);
  const details = it.jobDetails;
  if (details && details.id) refs.push(details.id);
  if (details && details.jobHash) refs.push(details.jobHash);
  const vdxf = it.vdxfData;
  if (vdxf && typeof vdxf.jobId === 'string') refs.push(vdxf.jobId);
  return refs;
}

function matchesWatch(it, watch) {
  if (!watch) return false;
  const want = new Set([watch.jobHash, watch.jobId].filter(Boolean));
  if (want.size === 0) return false;
  return itemRefs(it).some((ref) => want.has(ref));
}

function preferWatched(items, watch) {
  if (!watch) return items.slice();
  const first = [];
  const rest = [];
  for (const it of items) {
    if (matchesWatch(it, watch)) first.push(it);
    else rest.push(it);
  }
  return first.concat(rest);
}

function watchedStillPending(items, watch) {
  if (!watch || (!watch.jobHash && !watch.jobId)) return false;
  const types = watch.types && watch.types.length ? watch.types : BUYER_INBOX_TYPES;
  return items.some((it) => types.includes(it.type) && matchesWatch(it, watch));
}

function emptyCounts() {
  return { job_record: 0, review: 0, attestation: 0 };
}

function countAcked(ids, byId) {
  const counts = emptyCounts();
  for (const id of ids || []) {
    const type = byId.get(id);
    if (counts[type] != null) counts[type] += 1;
  }
  return counts;
}

function addCounts(into, extra) {
  for (const key of Object.keys(into)) into[key] += extra[key] || 0;
}

function wroteAny(counts) {
  return counts.job_record + counts.review + counts.attestation > 0;
}

/** One live row of each content-map key. Dead-lettered ids are not fetched again. */
function selectInboxWriteSet(pending, isDead) {
  const picked = {};
  const quarantined = [];
  for (const it of pending || []) {
    if (!it || !BUYER_INBOX_TYPES.includes(it.type)) continue;
    if (typeof isDead === 'function' && isDead(it.id)) {
      quarantined.push(it.id);
      continue;
    }
    if (!picked[it.type]) picked[it.type] = it;
  }
  return { chosen: Object.values(picked), quarantined };
}

function drainMessage(result) {
  const id = (result && result.buyerId) || '<buyer>';
  const next = `j41-dispatcher inbox ${id} --yes`;
  const counts = (result && result.accepted) || emptyCounts();
  const wrote = `${counts.job_record} job record(s), ${counts.review} review(s), ${counts.attestation} attestation(s)`;
  if (!result) return 'Buyer content maps were not published.';
  if (result.code === 'BUYER_INBOX_FUNDS' || result.code === 'BUYER_INBOX_READ_FAILED' || result.code === 'BUYER_INBOX_STOPPED') {
    return result.message || 'Buyer inbox publish stopped.';
  }
  if (result.code === 'BUYER_INBOX_UNCONFIRMED') {
    const tx = result.txids && result.txids.length ? String(result.txids[result.txids.length - 1]) : '';
    const shown = tx ? ` ${tx.slice(0, 16)}` : '';
    return `Identity write${shown} is not confirmed yet. Wait for that confirmation before another publish.`;
  }
  if (result.code === 'BUYER_INBOX_EMPTY') {
    return 'Buyer inbox has no pending job_record, review, or attestation.';
  }
  if (result.code === 'BUYER_INBOX_WAITING') {
    return `Published ${wrote}. This job's copy is not in the buyer inbox yet. The seller accept copies the review. Next: ${next}`;
  }
  if (result.code === 'BUYER_INBOX_PENDING') {
    return `Published ${wrote}. ${result.pending} content-map item(s) still pending. Next: ${next}`;
  }
  if (result.code === 'BUYER_INBOX_QUARANTINED') {
    const ids = (result.quarantined || []).map((id) => String(id).slice(0, 8)).join(', ');
    return `Published ${wrote}. These inbox items are quarantined until restart: ${ids || 'unknown'}.`;
  }
  const tail = result.pending > 0 ? ` ${result.pending} still pending. Next: ${next}` : '';
  return `Published ${wrote}.${tail}`;
}

async function drainBuyerInbox({
  fetchPending,
  processOnce,
  sleep,
  now = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS,
  watch = null,
  once = false,
  maxCycles = DEFAULT_MAX_CYCLES,
  buyerId = '',
  onProgress,
} = {}) {
  if (typeof fetchPending !== 'function' || typeof processOnce !== 'function' || typeof sleep !== 'function') {
    throw new Error('drainBuyerInbox requires fetchPending, processOnce, and sleep');
  }

  const accepted = emptyCounts();
  const txids = [];
  let pending = [];
  let cycles = 0;
  let sawWatch = false;
  const started = now();
  const singlePass = timeoutMs <= 0 || once;
  const needWatch = !!(watch && (watch.jobHash || watch.jobId));
  const timedOut = () => timeoutMs > 0 && (now() - started) >= timeoutMs;

  const finish = (code, ok) => ({
    ok,
    code,
    pending: pending.length,
    accepted,
    txids,
    buyerId,
  });

  async function waitConfirmed() {
    if (txids.length === 0) return true;
    const t0 = now();
    let spins = 0;
    while (spins < 100) {
      const res = await processOnce([]);
      if (!res || res.deferredAgent !== true) return true;
      if (confirmTimeoutMs <= 0 || (now() - t0) >= confirmTimeoutMs) return false;
      spins += 1;
      await sleep(intervalMs);
    }
    return false;
  }

  async function finishConfirmed(code, ok) {
    const confirmed = await waitConfirmed();
    if (!confirmed) return finish('BUYER_INBOX_UNCONFIRMED', false);
    return finish(code, ok);
  }

  while (cycles < maxCycles && !timedOut()) {
    pending = actionableItems(await fetchPending());
    if (needWatch && watchedStillPending(pending, watch)) sawWatch = true;

    if (pending.length === 0) {
      if (!needWatch || sawWatch) {
        return finishConfirmed(wroteAny(accepted) ? 'BUYER_INBOX_PUBLISHED' : 'BUYER_INBOX_EMPTY', true);
      }
      if (typeof onProgress === 'function') onProgress({ waiting: true, pending: 0 });
      if (singlePass) break;
      await sleep(intervalMs);
      continue;
    }

    const ordered = preferWatched(pending, watch);
    const byId = new Map(ordered.map((it) => [it.id, it.type]));
    const res = await processOnce(ordered);
    if (res && res.txid && !txids.includes(res.txid)) txids.push(res.txid);
    addCounts(accepted, countAcked(res && res.acked, byId));
    if (typeof onProgress === 'function') {
      onProgress({
        pending: pending.length,
        txid: res && res.txid,
        accepted: res && res.acked ? res.acked.length : 0,
        deferred: !!(res && res.deferredAgent),
        waiting: false,
      });
    }
    if (res && res.nothingWritable) {
      return {
        ok: false,
        code: 'BUYER_INBOX_QUARANTINED',
        pending: (res.quarantined || []).length,
        quarantined: res.quarantined || [],
        accepted,
        txids,
        buyerId,
      };
    }
    if (res && res.rateLimited) {
      if (typeof onProgress === 'function') onProgress({ waiting: true, pending: pending.length, rateLimited: true });
      if (singlePass) break;
      await sleep(intervalMs);
      continue;
    }
    if (res && res.stop) {
      const confirmed = await waitConfirmed();
      if (!confirmed) return finish('BUYER_INBOX_UNCONFIRMED', false);
      return {
        ok: false,
        code: res.code || 'BUYER_INBOX_STOPPED',
        message: res.message || 'Buyer inbox publish stopped.',
        pending: pending.length,
        accepted,
        txids,
        buyerId,
      };
    }
    if (!(res && res.deferredAgent)) cycles += 1;

    pending = actionableItems(await fetchPending());
    if (needWatch && watchedStillPending(pending, watch)) sawWatch = true;
    const watchClear = !needWatch || !watchedStillPending(pending, watch);
    if (watchClear && (pending.length === 0 || needWatch)) {
      return finishConfirmed(
        pending.length === 0 && !wroteAny(accepted) ? 'BUYER_INBOX_EMPTY' : 'BUYER_INBOX_PUBLISHED',
        true,
      );
    }
    if (singlePass) break;
    await sleep(intervalMs);
  }

  pending = actionableItems(await fetchPending());
  if (needWatch && watchedStillPending(pending, watch)) sawWatch = true;
  if (pending.length === 0 && (!needWatch || sawWatch)) {
    return finishConfirmed(wroteAny(accepted) ? 'BUYER_INBOX_PUBLISHED' : 'BUYER_INBOX_EMPTY', true);
  }
  if (needWatch && !watchedStillPending(pending, watch) && (sawWatch || wroteAny(accepted))) {
    return finishConfirmed('BUYER_INBOX_PUBLISHED', true);
  }
  const confirmed = await waitConfirmed();
  if (!confirmed) return finish('BUYER_INBOX_UNCONFIRMED', false);
  if (needWatch && !sawWatch) return finish('BUYER_INBOX_WAITING', false);
  if (once && wroteAny(accepted)) return finish('BUYER_INBOX_PUBLISHED', true);
  return finish('BUYER_INBOX_PENDING', false);
}

module.exports = {
  BUYER_INBOX_TYPES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_CONFIRM_TIMEOUT_MS,
  BACKLOG_TIMEOUT_MS,
  DEFAULT_MAX_CYCLES,
  actionableItems,
  preferWatched,
  matchesWatch,
  selectInboxWriteSet,
  drainMessage,
  drainBuyerInbox,
};
