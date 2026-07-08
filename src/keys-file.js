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
