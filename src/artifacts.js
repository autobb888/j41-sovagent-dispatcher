'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readStoredZip } = require('./delivery-package');

const ARTIFACTS_VERSION = 1;
const NOT_READY = new Set(['requested', 'accepted', 'paused', 'in_progress', 'rework']);

function planArtifacts(job, files) {
  const serviceType = (job && (job.serviceType || job.service_type)) || null;
  const status = job && job.status ? String(job.status) : '';
  const base = { status, artifactsVersion: ARTIFACTS_VERSION, sealed: false };
  if (serviceType === 'gpu-rental') {
    return {
      ...base,
      ok: false,
      code: 'ARTIFACTS_NONE_LEASE',
      message: 'This rental has no file package. Copy what you need over the lease before complete.',
    };
  }
  if (serviceType === 'dataset') {
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
  if (list.length === 0 && !notice && (NOT_READY.has(status) || !status)) {
    return {
      ...base,
      ok: false,
      code: 'ARTIFACTS_NOT_READY',
      message: `Job status is ${status || 'unknown'}. The package is available after delivery.`,
    };
  }
  if (list.length === 0 && !notice) {
    return {
      ...base,
      ok: false,
      code: 'ARTIFACTS_EMPTY',
      message: 'This job has no package and no delivery notice.',
    };
  }
  return { ...base, ok: true, notice, files: list };
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
  for (const file of plan.files) {
    const downloaded = await downloadFile(file.id);
    const name = safeBasename((downloaded && downloaded.filename) || file.filename || 'file');
    const dest = path.join(root, name);
    const buf = Buffer.from(downloaded.data);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const expected = (downloaded && downloaded.checksum) || file.checksum;
    if (expected && sha256 !== expected) {
      const err = new Error(`Checksum mismatch for ${name}`);
      err.code = 'ARTIFACTS_BAD_HASH';
      throw err;
    }
    fs.writeFileSync(dest, buf);
    written.push({ name, bytes: buf.length, sha256 });
    if (name.toLowerCase().endsWith('.zip')) {
      for (const entry of readStoredZip(buf)) {
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
    }
  }
  let noticeFile = null;
  if (plan.notice) {
    noticeFile = 'notice.txt';
    fs.writeFileSync(path.join(root, noticeFile), plan.notice);
  }
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
  };
}

module.exports = {
  ARTIFACTS_VERSION,
  planArtifacts,
  safeBasename,
  fetchArtifacts,
};
