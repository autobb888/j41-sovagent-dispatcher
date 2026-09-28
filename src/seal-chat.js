'use strict';

/**
 * Seal one user chat frame to the counterparty's public job address.
 * The viewing key stays in the local seal file and is never posted.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { encryptToAddress, descriptorBytes } = require('./seal-package');

const LIB_URL = pathToFileURL(path.join(__dirname, 'vendor', 'veruszsupportlib', 'index.mjs')).href;
const HEX86 = /^[0-9a-fA-F]{86}$/;

function jobKeyFile(agentDir, jobId) {
  return path.join(agentDir, `seal-${jobId}.json`);
}

function readJobIvk(agentDir, jobId) {
  const file = jobKeyFile(agentDir, jobId);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    const err = new Error('Seal viewing key for this job is not on this machine');
    err.code = 'CHAT_SEAL_KEY';
    throw err;
  }
  const ivk = Buffer.from(String(parsed && parsed.ivkHex || ''), 'hex');
  if (ivk.length !== 32) {
    const err = new Error('Seal viewing key for this job is not on this machine');
    err.code = 'CHAT_SEAL_KEY';
    throw err;
  }
  return ivk;
}

async function sealChatArmor(addressHex, plaintext) {
  const text = plaintext == null ? '' : String(plaintext);
  if (!HEX86.test(String(addressHex || ''))) {
    const err = new Error('Counterparty seal address must be 86 hex characters');
    err.code = 'CHAT_SEAL_ADDRESS';
    throw err;
  }
  if (text.length < 1 || text.length > 4000) {
    const err = new Error('Chat plaintext must be 1 to 4000 characters');
    err.code = 'CHAT_SEAL_TOO_LONG';
    throw err;
  }
  const enc = await encryptToAddress(Uint8Array.from(Buffer.from(addressHex, 'hex')), Buffer.from(text, 'utf8'));
  return descriptorBytes(enc.objectdata, enc.ephemeralPublicKey).toString('base64');
}

async function openChatArmor(armor, ivk) {
  const raw = Buffer.from(String(armor || ''), 'base64');
  const P = require('verus-typescript-primitives');
  const dd = new P.DataDescriptor();
  dd.fromBuffer(raw);
  if (!dd.hasEncryptedData() || !dd.hasEPK() || (dd.ivk && dd.ivk.length) || (dd.ssk && dd.ssk.length)) {
    const err = new Error('Chat armor is not an opaque descriptor');
    err.code = 'CHAT_SEAL_ARMOR';
    throw err;
  }
  const { webcrypto } = require('node:crypto');
  if (!globalThis.crypto) globalThis.crypto = webcrypto;
  const lib = await import(LIB_URL);
  let plain;
  try {
    plain = lib.decryptData({
      ivk: Uint8Array.from(ivk),
      epk: Uint8Array.from(dd.epk),
      objectdata: Uint8Array.from(dd.objectdata),
    });
  } catch {
    const err = new Error('Chat armor did not open with this viewing key');
    err.code = 'CHAT_SEAL_UNREADABLE';
    throw err;
  }
  const text = Buffer.from(plain).toString('utf8');
  if (text.length > 4000) {
    const err = new Error('Decrypted chat is longer than 4000 characters');
    err.code = 'CHAT_SEAL_TOO_LONG';
    throw err;
  }
  return text;
}

module.exports = {
  jobKeyFile,
  readJobIvk,
  sealChatArmor,
  openChatArmor,
};
