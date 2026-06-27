'use strict';

/**
 * Shared helper for writing keys.json files.
 * Always enforces mode 0600 via both writeFileSync option and an explicit
 * chmodSync (defence-in-depth: handles pre-existing files with looser perms).
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

module.exports = { writeKeysFile };
