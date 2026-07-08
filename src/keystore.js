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
const fs = require('fs');
const path = require('path');

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

// ── In-memory master-key singleton ────────────────────────────────────────
let _masterKey = null;

function isUnlocked() { return _masterKey !== null; }

function getMasterKey() {
  if (_masterKey === null) {
    const e = new Error('key pool is locked');
    e.code = 'ELOCKED';
    throw e;
  }
  return _masterKey;
}

function lock() {
  if (_masterKey) { _masterKey.fill(0); _masterKey = null; }
}

function _readMasterDoc(masterKeyPath) {
  return JSON.parse(fs.readFileSync(masterKeyPath, 'utf8'));
}

function _writeMasterDoc(masterKeyPath, salt, wrapped) {
  const doc = {
    v: 1,
    kdf: { alg: 'scrypt', N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, salt: salt.toString('base64') },
    wrapped,
  };
  fs.writeFileSync(masterKeyPath, JSON.stringify(doc, null, 2), { mode: 0o600 });
  try { fs.chmodSync(masterKeyPath, 0o600); } catch (_) {}
}

function initMasterKey(passphrase, masterKeyPath) {
  if (fs.existsSync(masterKeyPath)) throw new Error('master-key.json already exists');
  const salt = crypto.randomBytes(16);
  const kek = deriveKek(passphrase, { ...SCRYPT_PARAMS, salt });
  const masterKey = createMasterKey();
  _writeMasterDoc(masterKeyPath, salt, wrapMasterKey(masterKey, kek));
  _masterKey = masterKey;
}

function unlock(passphrase, masterKeyPath) {
  const doc = _readMasterDoc(masterKeyPath);
  const kek = deriveKek(passphrase, { N: doc.kdf.N, r: doc.kdf.r, p: doc.kdf.p, salt: Buffer.from(doc.kdf.salt, 'base64') });
  let masterKey;
  try {
    masterKey = unwrapMasterKey(doc.wrapped, kek);
  } catch (_) {
    const e = new Error('incorrect passphrase');
    e.code = 'EBADPASS';
    throw e;
  }
  _masterKey = masterKey;
}

function changePassphrase(oldPass, newPass, masterKeyPath) {
  const doc = _readMasterDoc(masterKeyPath);
  const oldKek = deriveKek(oldPass, { N: doc.kdf.N, r: doc.kdf.r, p: doc.kdf.p, salt: Buffer.from(doc.kdf.salt, 'base64') });
  let masterKey;
  try {
    masterKey = unwrapMasterKey(doc.wrapped, oldKek);
  } catch (_) {
    const e = new Error('incorrect passphrase');
    e.code = 'EBADPASS';
    throw e;
  }
  const newSalt = crypto.randomBytes(16);
  const newKek = deriveKek(newPass, { ...SCRYPT_PARAMS, salt: newSalt });
  _writeMasterDoc(masterKeyPath, newSalt, wrapMasterKey(masterKey, newKek));
}

// ── Passphrase resolution ─────────────────────────────────────────────────
function _credPassphrase(env) {
  const dir = env.CREDENTIALS_DIRECTORY;
  if (!dir) return null;
  const p = path.join(dir, 'j41-keys-passphrase');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8').replace(/\r?\n$/, '');
}

function resolvePassphraseSync({ env = process.env } = {}) {
  return _credPassphrase(env) || env.J41_KEYS_PASSPHRASE || null;
}

async function resolvePassphrase({ env = process.env, promptFn } = {}) {
  const nonInteractive = resolvePassphraseSync({ env });
  if (nonInteractive) return nonInteractive;
  if (promptFn && process.stdin.isTTY) return await promptFn();
  const e = new Error('no passphrase source: set J41_KEYS_PASSPHRASE, provide a systemd credential (j41-keys-passphrase), or run in a terminal');
  e.code = 'ENOPASS';
  throw e;
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Suppress echo of typed characters.
    rl._writeToOutput = () => {};
    process.stdout.write(question);
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

// ── Lazy unlock (transparent, non-interactive) ────────────────────────────
// Lets readKeysFile auto-unlock from env / systemd-cred without every call
// site knowing where master-key.json lives. cli.js registers the path once at
// startup. Unregistered (e.g. in unit tests) → lazyUnlockSync is a no-op.
let _masterKeyPath = null;

function setMasterKeyPath(p) { _masterKeyPath = p; }

function lazyUnlockSync() {
  if (isUnlocked() || !_masterKeyPath || !fs.existsSync(_masterKeyPath)) return false;
  const pass = resolvePassphraseSync();
  if (!pass) return false;
  unlock(pass, _masterKeyPath); // throws EBADPASS on a wrong passphrase → fail closed
  return true;
}

module.exports = {
  SCRYPT_PARAMS,
  deriveKek,
  createMasterKey,
  wrapMasterKey,
  unwrapMasterKey,
  encryptSecret,
  decryptSecret,
  isUnlocked,
  getMasterKey,
  lock,
  initMasterKey,
  unlock,
  changePassphrase,
  resolvePassphraseSync,
  resolvePassphrase,
  promptHidden,
  setMasterKeyPath,
  lazyUnlockSync,
};
