'use strict';

function jobPaymentReady(job, { allowUnpriced = false } = {}) {
  if (!job || typeof job !== 'object') return false;
  if (job.status === 'in_progress') return true;
  const pay = job.payment;
  if (pay && pay.verified === true) return true;
  if (pay && (pay.status === 'confirmed' || pay.status === 'completed')) return true;
  if (allowUnpriced && !pay) return true;
  return false;
}

module.exports = { jobPaymentReady };
