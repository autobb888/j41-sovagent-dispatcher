'use strict';

// A paused job used to leave its hour timer running. The timer looks the job
// up by id, so when it fired it killed whatever container was in the map,
// including the one a later resume had just started.
//
// The generation is stamped on the container that owns the timer. A callback
// whose generation is no longer on the live entry returns without killing.

const MAX_STRANDED_REVIVES = 3;

function jobTimeoutStillOwns(active, generation) {
  if (!active || generation == null) return false;
  return active._timeoutGeneration === generation;
}

function assignJobTimeout(active, timer, generation) {
  if (!active) {
    try { clearTimeout(timer); } catch { /* nothing was stored */ }
    return false;
  }
  active._timeoutGeneration = generation;
  active._timeoutTimer = timer;
  return true;
}

function clearJobTimeout(active) {
  if (!active) return false;
  if (active._timeoutTimer != null) {
    try { clearTimeout(active._timeoutTimer); } catch { /* not a timer */ }
    active._timeoutTimer = null;
  }
  active._timeoutGeneration = null;
  return true;
}

function jobHasDelivery(job) {
  if (!job || typeof job !== 'object') return false;
  if (typeof job.deliveryHash === 'string' && job.deliveryHash.length > 0) return true;
  const delivery = job.delivery;
  return !!(delivery && typeof delivery === 'object'
    && typeof delivery.hash === 'string' && delivery.hash.length > 0);
}

function deliveryFieldMissing(job) {
  if (!job || typeof job !== 'object') return true;
  if (Object.prototype.hasOwnProperty.call(job, 'delivery')) return false;
  if (Object.prototype.hasOwnProperty.call(job, 'deliveryHash')) return false;
  return true;
}

/**
 * A paid labour job whose worker is gone.
 * `seen` is what stops the poll from starting it again. A pause keeps the job
 * in the reactivation queue, and that queue is not this case. A delivery means
 * the work already landed. The attempt cap stops a job that keeps dying at the
 * hour mark from being restarted forever.
 */
function shouldReviveStrandedJob(job, ctx = {}) {
  const max = ctx.maxAttempts != null ? ctx.maxAttempts : MAX_STRANDED_REVIVES;
  if (!job || !job.id) return { revive: false, why: 'malformed' };
  if (job.status !== 'in_progress') return { revive: false, why: `status ${job.status}` };

  const type = job.serviceType || job.service_type || '';
  if (type === 'gpu-rental' || type === 'dataset' || type === 'api-endpoint' || type === 'data' || type === 'model') {
    return { revive: false, why: 'not a labour job' };
  }
  if (job.datasetTerms || job.kind === 'gpu-rental' || job.kind === 'dataset' || job.kind === 'data' || job.kind === 'model') {
    return { revive: false, why: 'not a labour job' };
  }
  if (jobHasDelivery(job)) return { revive: false, why: 'already delivered' };
  if (deliveryFieldMissing(job)) return { revive: false, confirm: true, why: 'delivery not on this row' };

  const seen = ctx.seen;
  if (!seen || typeof seen.has !== 'function' || !seen.has(job.id)) {
    return { revive: false, why: 'not seen' };
  }
  if (ctx.active && typeof ctx.active.has === 'function' && ctx.active.has(job.id)) {
    return { revive: false, why: 'worker is live' };
  }
  if (ctx.inQueue) return { revive: false, why: 'waiting in the start queue' };
  if (ctx.inReactivation) return { revive: false, why: 'paused' };

  const attempts = ctx.attempts || 0;
  if (attempts >= max) return { revive: false, why: `revive cap ${max}` };
  return { revive: true, why: 'in progress with no worker and no delivery' };
}

module.exports = {
  MAX_STRANDED_REVIVES,
  jobTimeoutStillOwns,
  assignJobTimeout,
  clearJobTimeout,
  jobHasDelivery,
  deliveryFieldMissing,
  shouldReviveStrandedJob,
};
