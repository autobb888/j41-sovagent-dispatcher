'use strict';
// Seal gpu-rental credentials via POST /v1/jobs/:id/rental-secret, then
// deliverJob a notice that MUST NOT contain host/password/privateKey.
const crypto = require('crypto');

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

function canonicalRentalDeliverable(d) {
  return JSON.stringify(sortKeys(d));
}

function hashRentalDeliverable(d) {
  return crypto.createHash('sha256').update(canonicalRentalDeliverable(d)).digest('hex');
}

function noticeRentalDeliverable(d) {
  const expiresAt = d && d.expiresAt != null ? String(d.expiresAt) : '';
  const disclosure = d && typeof d.disclosure === 'string' ? d.disclosure : '';
  return `GPU rental credentials are sealed for the buyer. Expires at ${expiresAt}. ${disclosure}`.trim();
}

function noticeLeaksSecret(notice, d) {
  const ssh = (d && d.ssh) || {};
  // Skip 1-3 char passwords ('x') — they collide with words like "Expires".
  const checks = [
    [ssh.host, 1],
    [ssh.password, 4],
    [ssh.privateKey, 8],
  ];
  for (const [v, min] of checks) {
    if (v != null && String(v).length >= min && notice.includes(String(v))) return true;
  }
  return false;
}

async function postRentalSecret(client, jobId, body) {
  if (client && typeof client.postRentalSecret === 'function') {
    return client.postRentalSecret(jobId, body);
  }
  if (client && typeof client.request === 'function') {
    return client.request('POST', `/v1/jobs/${encodeURIComponent(jobId)}/rental-secret`, body);
  }
  const token = client && typeof client.getSessionToken === 'function' ? client.getSessionToken() : null;
  const base = client && typeof client.getBaseUrl === 'function' ? client.getBaseUrl() : null;
  if (token && base) {
    const url = `${String(base).replace(/\/+$/, '')}/v1/jobs/${encodeURIComponent(jobId)}/rental-secret`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Cookie: `verus_session=${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = new Error(`RENTAL_SECRET_FAILED: HTTP ${res.status}`);
      err.statusCode = res.status;
      throw err;
    }
    try { return await res.json(); } catch { return { ok: true }; }
  }
  throw new Error('RENTAL_SECRET_FAILED: no authenticated client to POST rental-secret (refusing to put ssh in deliverJob)');
}

async function deliverSealed({ client, signDeliver, signer, job, deliverable }) {
  const { assertSshDeliverable } = require('./rental-job');
  assertSshDeliverable(deliverable && deliverable.ssh);
  if (!client) throw new Error('RENTAL_SECRET_FAILED: no client to POST rental-secret (refusing to put ssh in deliverJob)');
  const sign = typeof signDeliver === 'function'
    ? signDeliver
    : (signer && typeof signer.signDeliver === 'function'
      ? (args) => signer.signDeliver(args)
      : null);
  if (typeof sign !== 'function') throw new Error('RENTAL_NO_SIGNER: cannot sign delivery');

  // Fail closed: never fall through to stuffing ssh into deliverJob.
  await postRentalSecret(client, job.id, deliverable);

  const hash = hashRentalDeliverable(deliverable);
  const signed = await sign({ hash, deliveryHash: hash, jobHash: job.jobHash, jobId: job.id });
  const notice = noticeRentalDeliverable(deliverable);
  if (noticeLeaksSecret(notice, deliverable)) {
    throw new Error('RENTAL_NOTICE_LEAK: notice contained SSH secret; refusing deliverJob');
  }
  return client.deliverJob(job.id, hash, signed.signature, signed.timestamp, notice);
}

module.exports = {
  canonicalRentalDeliverable,
  hashRentalDeliverable,
  noticeRentalDeliverable,
  deliverSealed,
  postRentalSecret,
};
