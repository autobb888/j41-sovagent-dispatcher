'use strict';

/**
 * Key-at-rest crypto core + in-memory master-key singleton.
 *
 * The agent WIF is encrypted with AES-256-GCM under a random 32-byte master
 * key. The master key is itself wrapped by a scrypt-derived KEK and stored in
 * master-key.json. The unwrapped master key lives only in this module's
 * memory, for the life of the process (see the singleton section, Task 3).
 *
 * Threat model: defends stolen disk / copied keys.json / backup. Does NOT
 * defend a live-compromised running process (the master key is resident once
 * unlocked). See docs/superpowers/specs/2026-07-07-at-rest-key-protection-design.md.
 */

const crypto = require('crypto');

const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1 };
const KEK_LEN = 32;
const MASTER_KEY_LEN = 32;
// scrypt at N=131072 needs ~128 MB (128 * N * r bytes); Node's default maxmem
// is 32 MB and would throw. Raise it explicitly.
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

function deriveKek(passphrase, { N, r, p, salt }) {
  return crypto.scryptSync(passphrase, salt, KEK_LEN, { N, r, p, maxmem: SCRYPT_MAXMEM });
}

function createMasterKey() {
  return crypto.randomBytes(MASTER_KEY_LEN);
}

function _gcmEncrypt(key, plaintextBuf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64'),
  };
}

function _gcmDecrypt(key, env) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  // final() throws if the auth tag does not verify → fail closed.
  return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]);
}

function wrapMasterKey(masterKey, kek) { return _gcmEncrypt(kek, masterKey); }
function unwrapMasterKey(wrapped, kek) { return _gcmDecrypt(kek, wrapped); }
function encryptSecret(masterKey, plaintextBuf) { return _gcmEncrypt(masterKey, plaintextBuf); }
function decryptSecret(masterKey, env) { return _gcmDecrypt(masterKey, env); }

module.exports = {
  SCRYPT_PARAMS,
  deriveKek,
  createMasterKey,
  wrapMasterKey,
  unwrapMasterKey,
  encryptSecret,
  decryptSecret,
};
