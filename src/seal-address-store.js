'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SEED_NAME = 'seal-seed.json';

function jobKeyName(jobId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(jobId || ''))) {
    const err = new Error('Job id is not a uuid');
    err.code = 'SEAL_JOB';
    throw err;
  }
  return `seal-${jobId}.json`;
}

function writeNew(file, obj) {
  const body = JSON.stringify(obj);
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
}

function readSeed(agentDir) {
  const file = path.join(agentDir, SEED_NAME);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || parsed.v !== 1 || !/^[0-9a-f]{64}$/i.test(parsed.seedHex || '')) {
    const err = new Error('Seal seed file is not usable');
    err.code = 'SEAL_SEED';
    throw err;
  }
  return Buffer.from(parsed.seedHex, 'hex');
}

function ensureSeed(agentDir) {
  fs.mkdirSync(agentDir, { recursive: true });
  const existing = readSeed(agentDir);
  if (existing) return existing;
  const seed = crypto.randomBytes(32);
  writeNew(path.join(agentDir, SEED_NAME), { v: 1, seedHex: seed.toString('hex') });
  return seed;
}

/**
 * Store the viewing key once. A second call for the same job keeps the first
 * address. The returned object has no viewing key.
 */
function storeJobKey(agentDir, jobId, addressHex, ivk) {
  if (!/^[0-9a-fA-F]{86}$/.test(String(addressHex || ''))) {
    const err = new Error('Seal address must be 86 hex characters');
    err.code = 'SEAL_ADDRESS';
    throw err;
  }
  if (!Buffer.isBuffer(ivk) || ivk.length !== 32) {
    const err = new Error('Seal viewing key was not 32 bytes');
    err.code = 'SEAL_IVK';
    throw err;
  }
  fs.mkdirSync(agentDir, { recursive: true });
  const file = path.join(agentDir, jobKeyName(jobId));
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { path: file, created: false, addressHex: parsed.addressHex };
  }
  writeNew(file, { v: 1, addressHex, ivkHex: ivk.toString('hex') });
  return { path: file, created: true, addressHex };
}

module.exports = {
  ensureSeed,
  storeJobKey,
};
