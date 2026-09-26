'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readStoredZip, PACKAGE_FILENAME } = require('./delivery-package');
const { isDatasetJob } = require('./job-payment');
const { isGpuRentalJob, jobIsGpuRental } = require('./buyer-extend');

const ARTIFACTS_VERSION = 1;
const NOT_READY = new Set(['requested', 'accepted', 'paused', 'in_progress', 'rework']);

function signedHash(job) {
  const hash = job && job.delivery && job.delivery.hash;
  return typeof hash === 'string' && hash ? hash.toLowerCase() : '';
}

function selectPackageFile(files, hash) {
  const matched = (Array.isArray(files) ? files : []).filter((file) => {
    return file && String(file.checksum || '').toLowerCase() === hash;
  });
  const named = matched.filter((file) => String(file.filename || '').toLowerCase() === PACKAGE_FILENAME);
  const chosen = named.length ? named : matched;
  return chosen.length ? chosen[chosen.length - 1] : null;
}

async function classifyArtifactJob(job, client) {
  const dataset = isDatasetJob(job);
  let gpu = isGpuRentalJob(job);
  if (!gpu && client) gpu = await jobIsGpuRental(job, client);
  return { dataset, gpu };
}

function planArtifacts(job, files) {
  const status = job && job.status ? String(job.status) : '';
  const base = { status, artifactsVersion: ARTIFACTS_VERSION, sealed: false };
  if (isGpuRentalJob(job)) {
    return {
      ...base,
      ok: false,
      code: 'ARTIFACTS_NONE_LEASE',
      message: 'This rental has no file package. Copy what you need over the lease before complete.',
    };
  }
  if (isDatasetJob(job)) {
    return {
      ...base,
      ok: false,
      code: 'ARTIFACTS_DATASET_USE_DATA_OPEN',
      message: 'Dataset rows are fetched with data-open while the review window is open. complete ends that bearer.',
    };
  }
  const list = Array.isArray(files) ? files : [];
  const notice = job && job.delivery && typeof job.delivery.message === 'string'
    ? job.delivery.message
    : '';
  if (status === 'rework') {
    return {
      ...base,
      ok: false,
      code: 'ARTIFACTS_NOT_READY',
      message: 'Job status is rework. The previous zip stays until the new deliver is accepted.',
    };
  }
  if (NOT_READY.has(status) || !status) {
    const waiting = status === 'accepted' || status === 'in_progress';
    return {
      ...base,
      ok: false,
      code: 'ARTIFACTS_NOT_READY',
      message: waiting
        ? `Job status is ${status}. The seller may have started delivery. The zip is not listed yet.`
        : `Job status is ${status || 'unknown'}. The package is available after delivery.`,
    };
  }
  const hash = signedHash(job);
  const file = hash ? selectPackageFile(list, hash) : null;
  if (!file && !notice) {
    return {
      ...base,
      ok: false,
      code: 'ARTIFACTS_EMPTY',
      message: 'This job has no package and no delivery notice.',
    };
  }
  return { ...base, ok: true, notice, files: file ? [file] : [] };
}

function safeBasename(filename) {
  const base = path.basename(String(filename || ''));
  if (!base || base === '.' || base === '..') {
    const err = new Error('Refusing a file name that leaves --out');
    err.code = 'ARTIFACTS_BAD_NAME';
    throw err;
  }
  return base;
}

function safeJoin(root, entryName) {
  const parts = String(entryName || '').replace(/\\/g, '/').split('/');
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..')) {
    const err = new Error('Refusing a zip entry that leaves --out');
    err.code = 'ARTIFACTS_BAD_NAME';
    throw err;
  }
  const dest = path.resolve(root, ...parts);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!dest.startsWith(prefix)) {
    const err = new Error('Refusing a zip entry that leaves --out');
    err.code = 'ARTIFACTS_BAD_NAME';
    throw err;
  }
  return dest;
}

/**
 * Write the platform's job files and the delivery notice into outDir.
 * `downloadFile(fileId)` returns `{ data, filename, checksum }`.
 * Bytes are written as stored. Decryption waits on a buyer z-address.
 */
async function fetchArtifacts({ job, files, outDir, downloadFile }) {
  const plan = planArtifacts(job, files);
  if (!plan.ok) return plan;
  fs.mkdirSync(outDir, { recursive: true });
  const root = path.resolve(outDir);
  const written = [];
  const signed = signedHash(job);
  for (const file of plan.files) {
    const downloaded = await downloadFile(file.id);
    const name = safeBasename((downloaded && downloaded.filename) || file.filename || 'file');
    const buf = Buffer.from(downloaded.data);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const expected = String((downloaded && downloaded.checksum) || file.checksum || '').toLowerCase();
    if (!signed || sha256 !== signed || (expected && sha256 !== expected)) {
      const err = new Error(`Checksum mismatch for ${name}`);
      err.code = 'ARTIFACTS_BAD_HASH';
      throw err;
    }
    let entries = null;
    if (name.toLowerCase().endsWith('.zip')) {
      entries = readStoredZip(buf);
    }
    const dest = path.join(root, name);
    fs.writeFileSync(dest, buf);
    written.push({ name, bytes: buf.length, sha256 });
    if (entries) {
      try {
        for (const entry of entries) {
          const unpacked = safeJoin(root, entry.name);
          fs.mkdirSync(path.dirname(unpacked), { recursive: true });
          fs.writeFileSync(unpacked, entry.data);
          written.push({
            name: entry.name,
            bytes: entry.data.length,
            sha256: crypto.createHash('sha256').update(entry.data).digest('hex'),
            fromZip: name,
          });
        }
      } catch (e) {
        try { fs.unlinkSync(dest); } catch { /* the zip did not validate */ }
        throw e;
      }
    }
  }
  let noticeFile = null;
  if (plan.notice) {
    noticeFile = 'notice.txt';
    fs.writeFileSync(path.join(root, noticeFile), plan.notice);
  }
  const entries = written.filter((file) => file.fromZip).map((file) => file.name);
  const summary = entries.length
    ? `sha256 matched delivery.hash. Entries: ${entries.join(', ')}.`
    : 'sha256 matched delivery.hash.';
  return {
    ok: true,
    artifactsVersion: ARTIFACTS_VERSION,
    jobId: job.id,
    status: plan.status,
    out: root,
    sealed: false,
    deliveryHash: job.delivery && job.delivery.hash ? job.delivery.hash : null,
    files: written,
    noticeFile,
    summary,
  };
}

module.exports = {
  ARTIFACTS_VERSION,
  classifyArtifactJob,
  planArtifacts,
  safeBasename,
  fetchArtifacts,
};
