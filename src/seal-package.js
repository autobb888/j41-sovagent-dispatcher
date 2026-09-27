'use strict';

/**
 * Seal a labour delivery.zip to the buyer's public 43-byte address.
 * encryptData does not take a viewing key or a spend key. symmetricKey is
 * refused if the library returns one. This file does not call
 * z_getEncryptionAddress.
 */
const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  MAX_PACKAGE_BYTES,
  PACKAGE_FILENAME,
  LONG_NOTICE,
  buildStoredZip,
} = require('./delivery-package');

const INNER_CAP = 25 * 1024 * 1024 - 64 * 1024;
const LIB_URL = pathToFileURL(path.join(__dirname, 'vendor', 'veruszsupportlib', 'index.mjs')).href;

async function encryptToAddress(address, data) {
  const { webcrypto } = require('node:crypto');
  if (!globalThis.crypto) globalThis.crypto = webcrypto;
  const lib = await import(LIB_URL);
  const enc = lib.encryptData({ address, data, returnSsk: false });
  if (enc.symmetricKey) {
    const err = new Error('encryptData returned a symmetric key');
    err.code = 'SEAL_KEY';
    throw err;
  }
  return enc;
}

function descriptorBytes(objectdata, epk) {
  const P = require('verus-typescript-primitives');
  const DataDescriptor = P.DataDescriptor;
  const dd = new DataDescriptor({
    flags: DataDescriptor.FLAG_ENCRYPTED_DATA,
    objectdata: Buffer.from(objectdata),
    epk: Buffer.from(epk),
  });
  if (!dd.hasEncryptedData() || !dd.hasEPK() || dd.ivk || dd.ssk) {
    const err = new Error('seal.bin is not an opaque descriptor');
    err.code = 'SEAL_DESCRIPTOR';
    throw err;
  }
  return Buffer.from(dd.toBuffer());
}

/**
 * innerZip is the plaintext archive (answer.txt and out/). The uploaded zip
 * is README.txt plus seal.bin.
 */
async function sealOuterZip(innerZip, addressHex) {
  if (!/^[0-9a-fA-F]{86}$/.test(String(addressHex || ''))) {
    const err = new Error('Buyer seal address must be 86 hex characters');
    err.code = 'SEAL_ADDRESS';
    throw err;
  }
  if (innerZip.length > INNER_CAP) {
    return {
      filename: PACKAGE_FILENAME,
      body: Buffer.alloc(0),
      hash: null,
      notice: '',
      sealed: false,
      upload: false,
      tooBig: true,
    };
  }
  const enc = await encryptToAddress(Uint8Array.from(Buffer.from(addressHex, 'hex')), innerZip);
  const outer = buildStoredZip([
    { name: 'README.txt', data: Buffer.from(LONG_NOTICE, 'utf8') },
    { name: 'seal.bin', data: descriptorBytes(enc.objectdata, enc.ephemeralPublicKey) },
  ]);
  if (outer.length > MAX_PACKAGE_BYTES) {
    return {
      filename: PACKAGE_FILENAME,
      body: Buffer.alloc(0),
      hash: null,
      notice: '',
      sealed: false,
      upload: false,
      tooBig: true,
    };
  }
  return {
    filename: PACKAGE_FILENAME,
    body: outer,
    hash: crypto.createHash('sha256').update(outer).digest('hex'),
    notice: LONG_NOTICE,
    sealed: true,
    upload: true,
    tooBig: false,
  };
}

module.exports = {
  INNER_CAP,
  sealOuterZip,
};
