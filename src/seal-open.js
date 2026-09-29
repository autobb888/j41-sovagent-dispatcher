'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { readStoredZip } = require('./delivery-package');

const LIB_URL = pathToFileURL(path.join(__dirname, 'vendor', 'veruszsupportlib', 'index.mjs')).href;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function loadViewingKey(agentDir, jobId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(jobId || ''))) throw fail('SEAL_JOB', 'Job id is not a uuid.');
  const file = path.join(agentDir, `seal-${jobId}.json`);
  if (!fs.existsSync(file)) throw fail('SEAL_KEY_MISSING', 'No viewing key is stored for this job.');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ivk = Buffer.from(parsed && parsed.ivkHex ? parsed.ivkHex : '', 'hex');
  if (ivk.length !== 32) throw fail('SEAL_IVK', 'The stored viewing key was not 32 bytes.');
  return ivk;
}

function readDescriptor(buf) {
  const { DataDescriptor } = require('verus-typescript-primitives');
  const dd = new DataDescriptor();
  dd.fromBuffer(buf);
  if (!dd.hasEncryptedData() || !dd.hasEPK() || dd.ivk || dd.ssk) {
    throw fail('SEAL_DESCRIPTOR', 'seal.bin is not an opaque descriptor.');
  }
  return { objectdata: Buffer.from(dd.objectdata), epk: Buffer.from(dd.epk) };
}

function safeJoin(root, entryName) {
  const parts = String(entryName || '').replace(/\\/g, '/').split('/');
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..')) {
    throw fail('SEAL_BAD_NAME', 'Refusing a zip entry that leaves --out.');
  }
  const dest = path.resolve(root, ...parts);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!dest.startsWith(prefix)) throw fail('SEAL_BAD_NAME', 'Refusing a zip entry that leaves --out.');
  return dest;
}

/**
 * Decrypt seal.bin with the viewing key already stored for this job.
 * Writes the inner zip and its entries. The returned object has no key.
 */
async function openSealedPackage({ agentDir, jobId, outDir }) {
  const ivk = loadViewingKey(agentDir, jobId);
  const sealPath = path.join(outDir, 'seal.bin');
  if (!fs.existsSync(sealPath)) throw fail('SEAL_BIN_MISSING', 'seal.bin is not in --out.');
  const { objectdata, epk } = readDescriptor(fs.readFileSync(sealPath));
  const { webcrypto } = require('node:crypto');
  if (!globalThis.crypto) globalThis.crypto = webcrypto;
  const lib = await import(LIB_URL);
  let plain;
  try {
    plain = Buffer.from(lib.decryptData({
      ivk: new Uint8Array(ivk),
      epk: new Uint8Array(epk),
      objectdata: new Uint8Array(objectdata),
    }));
  } finally {
    ivk.fill(0);
  }
  const root = path.resolve(outDir);
  fs.mkdirSync(root, { recursive: true });
  const innerName = 'inner.zip';
  fs.writeFileSync(path.join(root, innerName), plain);
  const entries = readStoredZip(plain);
  const names = [];
  for (const entry of entries) {
    const dest = safeJoin(root, entry.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.data);
    names.push(entry.name);
  }
  return {
    ok: true,
    code: 'SEAL_OPENED',
    jobId,
    out: root,
    innerZip: innerName,
    files: names,
  };
}

module.exports = {
  openSealedPackage,
};
