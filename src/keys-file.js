'use strict';

/**
 * Shared helpers for reading and writing keys.json files.
 * writeKeysFile always enforces mode 0600. readKeysFile is the single read
 * seam through which every host-side WIF access flows (see Task 4 for the
 * encrypted-file behavior added behind this seam).
 */

const fs = require('fs');

/**
 * Write `obj` as pretty-printed JSON to `p` with mode 0600.
 * @param {string} p   Absolute path to keys.json
 * @param {object} obj Keys object to serialise
 */
function writeKeysFile(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch (_) {}
}

/**
 * Read a keys.json file. Plaintext (v1 / no version) files are returned as-is.
 * @param {string} p Absolute path to keys.json
 * @param {{ allowLocked?: boolean }} [opts] allowLocked is reserved for
 *        encrypted (v2) files (Task 4); it has no effect on plaintext files.
 * @returns {object}
 */
function readKeysFile(p, { allowLocked = false } = {}) {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  // v2 (encrypted) handling is added in Task 4. Until then everything is
  // plaintext and returned verbatim.
  void allowLocked;
  return raw;
}

module.exports = { writeKeysFile, readKeysFile };
