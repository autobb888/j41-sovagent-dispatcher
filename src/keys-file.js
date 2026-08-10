'use strict';

/**
 * Shared helpers for reading and writing keys.json files, with transparent
 * at-rest encryption behind the read/write seam.
 *
 * v1 / no-version files are plaintext (current behavior, and the default —
 * encryption is opt-in via `j41-dispatcher encrypt-keys`). v2 files carry an
 * `encrypted` AES-256-GCM envelope of the secret fields; public fields stay in
 * the clear so listing works without unlocking. On a locked v2 file the default
 * (secret-needed) read attempts a non-interactive lazy unlock (env / systemd-
 * cred) before failing closed. See keystore.js and the design spec.
 */

const fs = require('fs');
const keystore = require('./keystore.js');

function writeKeysFile(p, obj) {
  // K1 (critical) — NEVER let a write destroy the private key.
  //
  // `readKeysFile(path, { allowLocked: true })` returns the public fields only: on a
  // v2 file it strips BOTH `wif` and the `encrypted` envelope. Four call sites in the
  // dashboard's "Retry Registration" screen read that way and write the object
  // straight back. With no `wif` present the encryption branch below is skipped, and
  // the atomic rename drops a plaintext, key-less file over the ciphertext — the WIF
  // is gone, there is no backup, and the master key now decrypts nothing.
  //
  // Guarding the primitive rather than the call sites: any future caller that reads
  // locked and writes back is covered, and the failure is loud instead of silent.
  try {
    if (fs.existsSync(p) && obj && obj.wif === undefined && obj.encrypted === undefined) {
      const existing = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (existing && (existing.wif !== undefined || existing.encrypted !== undefined)) {
        throw new Error(
          `refusing to write ${p}: the object carries no wif and no encrypted envelope, ` +
          'but the file on disk holds key material. This would destroy the private key ' +
          'irrecoverably. The caller almost certainly read with { allowLocked: true } — ' +
          're-read unlocked, or merge onto the existing record.',
        );
      }
    }
  } catch (e) {
    if (/refusing to write/.test(e.message)) throw e;
    // A corrupt/unreadable existing file must not block a legitimate write.
  }

  let toWrite = obj;
  if (keystore.isUnlocked() && obj.wif !== undefined) {
    const { wif, ...pub } = obj;
    const encrypted = keystore.encryptSecret(keystore.getMasterKey(), Buffer.from(JSON.stringify({ wif }), 'utf8'));
    toWrite = { v: 2, ...pub, encrypted };
  }
  // Atomic write: temp file + fsync + rename, so a crash mid-write can never
  // leave a torn/corrupt keys.json. Mode 0600 is enforced on the temp file
  // before the rename replaces the target. Mirrors keystore._writeMasterDoc.
  const tmp = p + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(toWrite, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.chmodSync(tmp, 0o600); } catch (_) {}
  fs.renameSync(tmp, p); // atomic replace
}

function readKeysFile(p, { allowLocked = false } = {}) {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (raw.v !== 2) return raw; // v1 / no version → plaintext

  const { v, encrypted, ...pub } = raw;
  // Default (secret-needed) path: try a non-interactive lazy unlock before
  // giving up. Display path (allowLocked) never unlocks — it only needs public
  // fields.
  if (!keystore.isUnlocked() && !allowLocked) keystore.lazyUnlockSync();
  if (!keystore.isUnlocked()) {
    if (allowLocked) return pub; // public fields only; no secret
    const e = new Error(`agent keys are encrypted and the pool is locked: ${p}`);
    e.code = 'ELOCKED';
    throw e;
  }
  if (allowLocked) return pub; // unlocked, but caller only wants public fields — never expose wif
  const secret = JSON.parse(keystore.decryptSecret(keystore.getMasterKey(), encrypted).toString('utf8'));
  return { ...pub, ...secret };
}

module.exports = { writeKeysFile, readKeysFile };
