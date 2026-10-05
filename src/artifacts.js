'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readStoredZip, PACKAGE_FILENAME } = require('./delivery-package');
const { isDatasetJob } = require('./job-payment');
const { isGpuRentalJob, jobIsGpuRental } = require('./buyer-extend');

const ARTIFACTS_VERSION = 1;
const NOT_READY = new Set(['requested', 'accepted', 'in_progress', 'rework']);

function refuseBeforeDelivery(base) {
  const status = base.status;
  if (status === 'paused') {
    return {
      ...base,
      ok: false,
      code: 'ARTIFACTS_PAUSED',
      message: 'Job status is paused. The package is not listed. Reactivate or dispute.',
    };
  }
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
  return null;
}

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
    const early = refuseBeforeDelivery(base);
    if (early) return early;
    return { ...base, ok: true, dataset: true, code: 'ARTIFACTS_DATASET' };
  }
  const early = refuseBeforeDelivery(job, base);
  if (early) return early;
  const list = Array.isArray(files) ? files : [];
  const notice = job && job.delivery && typeof job.delivery.message === 'string'
    ? job.delivery.message
    : '';
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
 * Bytes are written as stored. A zip of README.txt and seal.bin is sealed.
 * This command does not decrypt seal.bin.
 */
function datasetDocument(page) {
  return {
    items: page && Array.isArray(page.items) ? page.items : [],
    count: page ? page.count : null,
    units: page ? page.units : null,
    unitPrice: page ? page.unitPrice : null,
    amount: page ? page.amount : null,
    offset: page ? page.offset : null,
    nextOffset: page ? page.nextOffset : null,
  };
}

function writeDatasetArtifacts({ job, outDir, page }) {
  const doc = datasetDocument(page);
  const buf = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const root = path.resolve(outDir);
  const dest = path.join(root, 'dataset.json');
  fs.writeFileSync(dest, buf, { mode: 0o600 });
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return {
    ok: true,
    code: 'ARTIFACTS_WRITTEN',
    artifactsVersion: ARTIFACTS_VERSION,
    jobId: job && job.id,
    status: job && job.status ? String(job.status) : '',
    out: root,
    sealed: false,
    deliveryHash: null,
    files: [{ name: 'dataset.json', bytes: buf.length, sha256 }],
    noticeFile: null,
    summary: `Wrote dataset.json (${doc.items.length} row(s)).`,
  };
}

async function fetchArtifacts({ job, files, outDir, downloadFile }) {
  const plan = planArtifacts(job, files);
  if (!plan.ok) return plan;
  if (plan.dataset) {
    const err = new Error('Dataset rows are written with writeDatasetArtifacts.');
    err.code = 'ARTIFACTS_DATASET';
    throw err;
  }
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
  const sealed = entries.length === 2 && entries.includes('README.txt') && entries.includes('seal.bin');
  const summary = sealed
    ? 'sha256 matched delivery.hash. The package is sealed. seal.bin was not decrypted.'
    : (entries.length
      ? `sha256 matched delivery.hash. Entries: ${entries.join(', ')}.`
      : 'sha256 matched delivery.hash.');
  return {
    ok: true,
    code: 'ARTIFACTS_WRITTEN',
    artifactsVersion: ARTIFACTS_VERSION,
    jobId: job.id,
    status: plan.status,
    out: root,
    sealed,
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
  writeDatasetArtifacts,
  datasetDocument,
};
