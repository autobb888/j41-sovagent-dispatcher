'use strict';
/**
 * Buyer job extend. Labour only while in_progress/paused (delivered is a
 * proven 400). GPU Cat-1 also extends delivered leases — payment is what
 * grows the lease; the buyer does not need the seller process online.
 */
const { planHirePayment, buyerOwnsJob, dualPayTxids } = require('./hire-pay');
const { paymentOutputs } = require('./hire');

const LABOUR_OPEN = new Set(['in_progress', 'paused']);
const GPU_OPEN = new Set(['in_progress', 'paused', 'delivered']);
const DEFAULT_WAIT_MS = 180000;
const DEFAULT_POLL_MS = 5000;

function isGpuRentalJob(job) {
  if (!job || typeof job !== 'object') return false;
  const t = job.serviceType || job.service_type
    || (job.service && (job.service.serviceType || job.service.service_type));
  if (t === 'gpu-rental') return true;
  const kind = job.listingKind || job.kind || job.sellerKind;
  if (kind === 'compute') return true;
  return false;
}

async function jobIsGpuRental(job, client) {
  if (isGpuRentalJob(job)) return true;
  if (!job || !job.serviceId || !client || typeof client.getService !== 'function') return false;
  try {
    const svc = await client.getService(job.serviceId);
    const t = svc && (svc.serviceType || svc.service_type);
    return t === 'gpu-rental';
  } catch {
    return false;
  }
}

function assertExtendOpen(job, { gpu = isGpuRentalJob(job) } = {}) {
  if (!job || !job.id) {
    return { ok: false, code: 'EXTEND_NOT_OPEN', message: 'Job not found.', gpu: false };
  }
  const status = String(job.status || '');
  if (gpu) {
    if (GPU_OPEN.has(status)) return { ok: true, gpu: true };
    return {
      ok: false,
      code: 'EXTEND_NOT_OPEN',
      message: `GPU job status ${status} is not extendable (need an active lease or delivered Cat-1).`,
      gpu: true,
      status,
    };
  }
  if (LABOUR_OPEN.has(status)) return { ok: true, gpu: false };
  return {
    ok: false,
    code: 'EXTEND_NOT_OPEN',
    message: `Labour job status ${status} is not extendable (need in_progress or paused).`,
    gpu: false,
    status,
  };
}

function pickExtensionPayment(extension, job) {
  if (extension && extension.payment) return extension.payment;
  if (job && job.payment) return job.payment;
  return null;
}

function unwrapExtension(raw) {
  if (!raw) return null;
  if (raw.id) return raw;
  if (raw.data && raw.data.id) return raw.data;
  return raw;
}

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

async function defaultSleep(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return;
  await new Promise((r) => setTimeout(r, n));
}

function planNowFn(now) {
  if (typeof now === 'function') return now;
  if (Number.isFinite(Number(now))) return () => Number(now);
  return Date.now;
}

async function waitOldPending({
  pay, wait, force, pending, now, loadPending, resolvePending, sleep, waitMs, pollMs,
}) {
  if (!pay) return { ok: true, pending: pending || null };
  // Wait-loop clock must advance. A frozen `now` number is only for planHirePayment in tests.
  const clock = typeof now === 'function' ? now : Date.now;
  const planNow = planNowFn(now);
  let stamp = pending;
  if (typeof loadPending === 'function') {
    try { stamp = loadPending(); } catch { stamp = pending; }
  }
  if (wait && !force && typeof resolvePending === 'function') {
    const sleepFn = typeof sleep === 'function' ? sleep : defaultSleep;
    const budget = Number.isFinite(Number(waitMs)) ? Number(waitMs) : DEFAULT_WAIT_MS;
    const interval = Number.isFinite(Number(pollMs)) ? Number(pollMs) : DEFAULT_POLL_MS;
    const deadline = clock() + budget;
    while (clock() < deadline) {
      const p = planHirePayment({ pending: stamp, now: clock(), force: false });
      if (p.ok) break;
      await sleepFn(interval);
      stamp = await resolvePending(typeof loadPending === 'function' ? loadPending() : stamp);
    }
  }
  if (typeof loadPending === 'function') {
    try { stamp = loadPending(); } catch { /* keep last stamp */ }
  }
  const pendingPlan = planHirePayment({ pending: stamp, now: planNow(), force: !!force });
  if (!pendingPlan.ok) return fail(pendingPlan.code, pendingPlan.reason);
  return { ok: true, pending: stamp };
}

async function runBuyerExtend({
  client,
  agent,
  keys,
  jobId,
  amount,
  reason,
  pay = true,
  wait = false,
  force = false,
  yes = false,
  autonomous = false,
  pending,
  loadPending,
  savePending,
  resolvePending,
  waitUnlink,
  confirm,
  sendMultiPayment,
  now,
  sleep,
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  gateExternalSend,
  recordSendOutcome,
} = {}) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return fail('BAD_AMOUNT', '--amount must be a positive number');
  }
  if (!client || typeof client.getJob !== 'function') {
    return fail('EXTEND_FAILED', 'Authenticated client is required.');
  }

  let job;
  try {
    job = await client.getJob(jobId);
  } catch (e) {
    return fail('EXTEND_FAILED', e.message || String(e));
  }
  if (!job || !job.id) {
    return fail('EXTEND_NOT_OPEN', `Job ${jobId} not found.`);
  }
  if (!buyerOwnsJob(keys, job)) {
    return fail('PAY_NOT_BUYER', 'This identity is not the buyer on that job.', { jobId: job.id });
  }

  const gpu = await jobIsGpuRental(job, client);
  const open = assertExtendOpen(job, { gpu });
  if (!open.ok) {
    return fail(open.code, open.message, { jobId: job.id, status: job.status, gpu: open.gpu });
  }

  // PAY_PENDING before requestExtension — an unpaid leftover extension is the
  // same class of bug as hire minting a job then refusing the spend.
  const pendingGate = await waitOldPending({
    pay, wait, force, pending, now, loadPending, resolvePending, sleep, waitMs, pollMs,
  });
  if (!pendingGate.ok) return pendingGate;

  if (!yes && typeof confirm === 'function') {
    const ok = await confirm({ amountText: String(amt), pay: !!pay });
    if (!ok) return { ok: true, cancelled: true };
  }

  if (typeof client.requestExtension !== 'function') {
    return fail('EXTEND_FAILED', 'Client cannot requestExtension.');
  }

  let extension;
  try {
    extension = unwrapExtension(await client.requestExtension(job.id, amt, reason));
  } catch (e) {
    return fail('EXTEND_FAILED', e.message || String(e), { jobId: job.id });
  }
  if (!extension || !extension.id) {
    return fail('EXTEND_FAILED', 'Platform did not return an extension id.', { jobId: job.id });
  }

  const result = {
    ok: true,
    jobId: job.id,
    extensionId: extension.id,
    amount: amt,
    gpu,
    paid: false,
    txid: null,
    outputs: [],
    pending: false,
  };
  if (!pay) return result;

  const send = typeof sendMultiPayment === 'function'
    ? sendMultiPayment
    : (agent && typeof agent.sendMultiPayment === 'function'
      ? (outputs) => agent.sendMultiPayment(outputs)
      : null);
  if (!send) {
    return fail('EXTEND_FAILED', 'No sendMultiPayment available to pay the extension.', {
      jobId: job.id,
      extensionId: extension.id,
    });
  }

  let outputs;
  try {
    outputs = paymentOutputs({ payment: pickExtensionPayment(extension, job) }, amt);
  } catch (e) {
    const m = String(e.message || e);
    const code = /^([A-Z][A-Z0-9_]+):/.exec(m);
    return fail(code ? code[1] : 'EXTEND_FAILED', m, { jobId: job.id, extensionId: extension.id });
  }

  if (autonomous) {
    const gate = typeof gateExternalSend === 'function'
      ? gateExternalSend
      : require('./spend-policy').gateExternalSend;
    const sellerId = job.sellerVerusId || job.seller;
    let payInfo = null;
    if (client && typeof client.getAgentPaymentAddress === 'function') {
      try { payInfo = await client.getAgentPaymentAddress(sellerId); } catch (e) {
        return fail('RECIPIENT_UNRESOLVED', `Cannot resolve seller address: ${e.message}`, {
          jobId: job.id, extensionId: extension.id,
        });
      }
    }
    const expected = [payInfo && payInfo.address, payInfo && payInfo.iAddress]
      .filter((a) => typeof a === 'string' && a.length > 0);
    if (!expected.length) {
      return fail('RECIPIENT_UNRESOLVED', 'No on-chain address for the seller.', {
        jobId: job.id, extensionId: extension.id,
      });
    }
    const g = gate({
      jobId: job.id,
      toAddress: outputs[0] && outputs[0].address,
      amount: amt,
      jobPrice: amt,
      kind: 'payment',
      expectedRecipients: expected,
    });
    if (!g.allowed) {
      return fail('SPEND_DENIED', g.reason, {
        jobId: job.id, extensionId: extension.id, retryable: !!g.retryable,
      });
    }
  }

  let txid;
  try {
    txid = await send(outputs);
  } catch (e) {
    return fail('EXTEND_FAILED', e.message || String(e), { jobId: job.id, extensionId: extension.id });
  }
  const { agentTxid, feeTxid } = dualPayTxids(outputs, txid);

  if (typeof savePending === 'function') {
    const at = typeof now === 'function' ? now() : (Number.isFinite(Number(now)) ? Number(now) : Date.now());
    savePending({ txid, at, kind: 'extension', amount });
  }

  if (typeof client.payExtension !== 'function') {
    return fail('EXTEND_FAILED', 'Client cannot payExtension.', {
      jobId: job.id, extensionId: extension.id, txid,
    });
  }
  try {
    await client.payExtension(job.id, extension.id, agentTxid, feeTxid);
  } catch (e) {
    return fail('EXTEND_FAILED', e.message || String(e), {
      jobId: job.id, extensionId: extension.id, txid,
    });
  }

  if (autonomous && typeof recordSendOutcome === 'function') {
    recordSendOutcome({
      kind: 'payment',
      jobId: job.id,
      toAddress: outputs[0] && outputs[0].address,
      amount: amt,
      txid,
    });
  }

  result.paid = true;
  result.txid = txid;
  result.outputs = outputs;
  result.agentTxid = agentTxid;
  result.feeTxid = feeTxid || null;

  if (wait && typeof waitUnlink === 'function') {
    const waited = await waitUnlink({
      intervalMs: Number.isFinite(Number(pollMs)) ? Number(pollMs) : DEFAULT_POLL_MS,
      timeoutMs: Number.isFinite(Number(waitMs)) ? Number(waitMs) : DEFAULT_WAIT_MS,
    });
    result.pending = !waited || !waited.cleared;
  }
  return result;
}

module.exports = {
  isGpuRentalJob,
  jobIsGpuRental,
  assertExtendOpen,
  pickExtensionPayment,
  runBuyerExtend,
  LABOUR_OPEN,
  GPU_OPEN,
};
