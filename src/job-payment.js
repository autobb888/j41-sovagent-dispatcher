'use strict';

function isDatasetJob(job) {
  if (!job || typeof job !== 'object') return false;
  if (job.datasetTerms) return true;
  const type = job.serviceType || job.service_type;
  return type === 'dataset';
}

function jobPaymentReady(job, { allowUnpriced = false } = {}) {
  if (!job || typeof job !== 'object') return false;
  // A dataset hire is paid only when payment-combined has been verified.
  // in_progress and a missing payment object do not unlock the rows.
  if (isDatasetJob(job)) {
    return !!(job.payment && job.payment.verified === true);
  }
  if (job.status === 'in_progress') return true;
  const pay = job.payment;
  if (pay && pay.verified === true) return true;
  if (pay && (pay.status === 'confirmed' || pay.status === 'completed')) return true;
  if (allowUnpriced && !pay) return true;
  return false;
}

module.exports = { jobPaymentReady, isDatasetJob };
