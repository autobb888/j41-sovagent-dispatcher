'use strict';

const fs = require('fs');
const path = require('path');

const CONTRACT_VERSION = 1;

let jsonMode = false;
let realLog = console.log;

function writeStdout(text) {
  process.stdout.write(text);
}

function isJsonDocument(text) {
  const t = String(text || '').trim();
  if (!(t.startsWith('{') && t.endsWith('}')) && !(t.startsWith('[') && t.endsWith(']'))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

function jsonConsoleLog(...args) {
  if (args.length === 1 && typeof args[0] === 'string' && isJsonDocument(args[0])) {
    const text = args[0].endsWith('\n') ? args[0] : `${args[0]}\n`;
    writeStdout(text);
    return;
  }
  console.error(...args);
}

function installBuyerJsonMode() {
  if (jsonMode) return;
  jsonMode = true;
  realLog = console.log;
  console.log = jsonConsoleLog;
}

function restoreBuyerJsonMode() {
  if (!jsonMode) return;
  console.log = realLog;
  jsonMode = false;
}

function emitBuyerJson(obj) {
  const payload = obj && typeof obj === 'object' && !Array.isArray(obj)
    ? { ...obj, contractVersion: CONTRACT_VERSION }
    : {
      ok: false,
      code: 'BUYER_CONTRACT',
      message: 'Result was not an object.',
      contractVersion: CONTRACT_VERSION,
    };
  writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
}

function presentWitness(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const block = raw.witness && typeof raw.witness === 'object' ? raw.witness : null;
  const record = raw.record && typeof raw.record === 'object' ? raw.record : null;
  if (!block && !record) return null;
  return {
    signatureHeight: block && Object.prototype.hasOwnProperty.call(block, 'signatureHeight')
      ? block.signatureHeight
      : null,
    signedByName: block && block.signedByName ? block.signedByName : null,
    signedBy: block && block.signedBy ? block.signedBy : null,
    signature: block && block.signature ? block.signature : null,
    record,
  };
}

function publishView({ result, jobId, jobHash } = {}) {
  const txids = result && Array.isArray(result.txids) ? result.txids.map(String) : [];
  const txid = txids.length ? txids[txids.length - 1] : null;
  const acceptedIn = (result && result.accepted) || {};
  const accepted = {
    job_record: Number(acceptedIn.job_record || 0),
    review: Number(acceptedIn.review || 0),
    attestation: Number(acceptedIn.attestation || 0),
  };
  let items = Array.isArray(result && result.items)
    ? result.items.filter((it) => it && it.type).map((it) => ({
      type: it.type,
      txid: it.txid || txid,
      jobId: it.jobId || jobId || null,
      jobHash: it.jobHash || jobHash || null,
      identityHeight: it.identityHeight != null ? it.identityHeight : null,
    }))
    : [];
  if (!items.length) {
    for (const type of ['job_record', 'review', 'attestation']) {
      if (accepted[type] > 0) {
        items.push({
          type,
          txid,
          jobId: jobId || null,
          jobHash: jobHash || null,
          identityHeight: null,
        });
      }
    }
  }
  return {
    ok: !!(result && result.ok),
    code: (result && result.code) || 'BUYER_INBOX_EMPTY',
    txid,
    items,
    pending: result && result.pending != null ? result.pending : 0,
    accepted,
  };
}

function decideCompleteReceipt({ already, shielded, publish, stored } = {}) {
  const published = !!(publish && publish.ok && publish.code === 'BUYER_INBOX_PUBLISHED' && publish.txid);
  const shieldedOk = !!(shielded && publish && publish.ok && publish.code === 'BUYER_INBOX_SHIELDED');
  const storedTx = stored && stored.publish && stored.publish.txid;
  if (already && storedTx && !published) {
    return { ok: true, code: 'COMPLETE_ALREADY', useStored: true, exitCode: 0, save: false };
  }
  if (published || shieldedOk) {
    return {
      ok: true,
      code: already ? 'COMPLETE_ALREADY' : 'COMPLETE_PUBLISHED',
      useStored: false,
      exitCode: 0,
      save: true,
    };
  }
  if (already) {
    return { ok: true, code: 'COMPLETE_ALREADY', useStored: false, exitCode: 0, save: false };
  }
  return {
    ok: false,
    code: (publish && publish.code) || 'BUYER_INBOX_EMPTY',
    useStored: false,
    exitCode: 1,
    save: false,
  };
}

function assertReceiptNames(buyerId, jobId) {
  const buyer = path.basename(String(buyerId || ''));
  if (!buyer || buyer !== String(buyerId) || buyer === '.' || buyer === '..') {
    const err = new Error('Buyer id is not a local folder name.');
    err.code = 'RECEIPT_BUYER';
    throw err;
  }
  if (!/^[0-9a-f-]{36}$/i.test(String(jobId || ''))) {
    const err = new Error('Job id is not a uuid.');
    err.code = 'RECEIPT_JOB';
    throw err;
  }
  return { buyer, jobId: String(jobId) };
}

function receiptPath(agentsDir, buyerId, jobId) {
  const names = assertReceiptNames(buyerId, jobId);
  return path.join(agentsDir, names.buyer, 'receipts', `${names.jobId}.json`);
}

function readReceipt(agentsDir, buyerId, jobId) {
  const file = receiptPath(agentsDir, buyerId, jobId);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

function writeReceipt(agentsDir, buyerId, jobId, obj) {
  const file = receiptPath(agentsDir, buyerId, jobId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const payload = obj && typeof obj === 'object' && !Array.isArray(obj)
    ? { ...obj, contractVersion: CONTRACT_VERSION }
    : { contractVersion: CONTRACT_VERSION };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return file;
}

module.exports = {
  CONTRACT_VERSION,
  installBuyerJsonMode,
  restoreBuyerJsonMode,
  emitBuyerJson,
  presentWitness,
  publishView,
  decideCompleteReceipt,
  receiptPath,
  readReceipt,
  writeReceipt,
};
