'use strict';
/**
 * Buyer-side hire. The dispatcher was seller-only (accept-job, refunds,
 * rental-setup). Terminal access to J41 includes hiring: this module is the
 * gate the CLI/TUI run before SDK createJob, mirroring junction41
 * assertJobHireAllowed so we fail locally on data listings instead of after
 * a signed POST /v1/jobs.
 */
const { parseListingKind } = require('./listing-kind');

function assertHireAllowed({ sellerKind, serviceType, serviceId }) {
  const kind = parseListingKind(sellerKind);
  if (!kind) {
    return {
      ok: false,
      code: 'SELLER_KIND_UNKNOWN',
      message: 'Seller listing_kind is missing; refusing hire (no agent default).',
    };
  }
  if (kind === 'data') {
    return {
      ok: false,
      code: 'DATA_NOT_HIREABLE',
      message: 'Data listings are browse-only. POST /v1/jobs refuses kind=data.',
    };
  }
  if (kind === 'compute') {
    if (!serviceId || serviceType !== 'gpu-rental') {
      return {
        ok: false,
        code: 'COMPUTE_REQUIRES_GPU_RENTAL',
        message: 'Compute listings are hired as gpu-rental jobs, not labour and not api-endpoint.',
      };
    }
    return { ok: true };
  }
  if (kind === 'model') {
    if (!serviceId || serviceType !== 'api-endpoint') {
      return {
        ok: false,
        code: 'MODEL_REQUIRES_API_ENDPOINT',
        message: 'Model listings are hired as api-endpoint (metered inference), not labour jobs.',
      };
    }
    return { ok: true };
  }
  return { ok: true };
}

function isVerusAddr(s) {
  return typeof s === 'string' && /^[Ri][1-9A-HJ-NP-Za-km-z]{25,40}$/.test(s);
}

/**
 * Dual-output payment the platform records after createJob.
 * Same checks as SDK BuyerSession.start — refuse a doctored fee.
 */
function paymentOutputs(job, amount) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error('HIRE_BAD_AMOUNT: amount must be a positive number');
  }
  const payAddr = job && job.payment && job.payment.address;
  if (!payAddr) {
    throw new Error('No payment address on job — backend may not have resolved seller R-address');
  }
  if (!isVerusAddr(payAddr)) {
    throw new Error(`Refusing to pay job: malformed payment address ${payAddr}`);
  }
  const outputs = [{ address: payAddr, amount: amt }];
  const feeAddr = job.payment.platformFeeAddress;
  const feeAmt = job.payment.feeAmount;
  if (feeAddr != null || feeAmt != null) {
    if (!isVerusAddr(feeAddr) || !Number.isFinite(feeAmt) || feeAmt <= 0 || feeAmt > amt) {
      throw new Error(`Refusing to pay implausible/malformed platform fee (amount=${feeAmt}, job=${amt}).`);
    }
    outputs.push({ address: feeAddr, amount: feeAmt });
  }
  return outputs;
}

module.exports = { assertHireAllowed, paymentOutputs, isVerusAddr };
