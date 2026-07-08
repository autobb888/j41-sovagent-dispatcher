'use strict';

/**
 * Pool-wide migration between plaintext (v1) and encrypted (v2) keys.json.
 * All functions require the keystore to already be unlocked (the CLI command
 * handles passphrase prompting). decryptAllKeys locks the keystore before
 * writing so writeKeysFile emits plaintext.
 */

const fs = require('fs');
const path = require('path');
const keystore = require('./keystore.js');
const { readKeysFile, writeKeysFile } = require('./keys-file.js');

function listAgentDirs(agentsDir) {
  if (!fs.existsSync(agentsDir)) return [];
  return fs.readdirSync(agentsDir).filter((id) => fs.existsSync(path.join(agentsDir, id, 'keys.json')));
}

function encryptAllKeys(agentsDir) {
  let count = 0;
  for (const id of listAgentDirs(agentsDir)) {
    const p = path.join(agentsDir, id, 'keys.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (raw.v === 2) continue; // already encrypted
    writeKeysFile(p, raw); // keystore unlocked → writes v2
    count++;
  }
  return count;
}

function decryptAllKeys(agentsDir) {
  const ids = listAgentDirs(agentsDir);
  // Decrypt everything into memory first (needs the key), then lock and write
  // plaintext so writeKeysFile does not re-encrypt.
  const loaded = ids
    .map((id) => ({ p: path.join(agentsDir, id, 'keys.json'), obj: readKeysFile(path.join(agentsDir, id, 'keys.json')) }))
    .filter(({ obj }) => obj.wif !== undefined);
  keystore.lock();
  for (const { p, obj } of loaded) writeKeysFile(p, obj); // locked → plaintext
  return loaded.length;
}

module.exports = { listAgentDirs, encryptAllKeys, decryptAllKeys };
