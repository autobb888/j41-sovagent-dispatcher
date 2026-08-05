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
  const skipped = [];
  for (const id of listAgentDirs(agentsDir)) {
    const p = path.join(agentsDir, id, 'keys.json');
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      // One unreadable file must not abort the loop. It used to throw uncaught,
      // stopping mid-pool — which in the new-passphrase path manufactured the
      // exact half-encrypted state this function exists to repair, and in the
      // resume path left every agent sorted after it plaintext forever, with a
      // stack trace as the only explanation.
      skipped.push(`${id} (${e.message})`);
      continue;
    }
    if (raw.v === 2) continue; // already encrypted
    writeKeysFile(p, raw); // keystore unlocked → writes v2
    count++;
  }
  if (skipped.length) {
    console.error(`⚠️  ${skipped.length} key file(s) could NOT be read and remain unencrypted:`);
    for (const s of skipped) console.error(`     ${s}`);
    console.error('   Fix or remove them, then re-run encrypt-keys to finish the pool.');
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

/**
 * Agent ids whose keys.json is still PLAINTEXT (v1).
 *
 * Needed because encrypt-keys is interruptible: it writes master-key.json first,
 * then re-encrypts each agent in turn. A crash mid-loop leaves a master key
 * present with some keys still in the clear — and the command then refused to
 * run again ("already encrypted"), so those WIFs stayed plaintext permanently
 * while the operator believed the pool was protected.
 */
function listPlaintextKeys(agentsDir) {
  const out = [];
  for (const id of listAgentDirs(agentsDir)) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(agentsDir, id, 'keys.json'), 'utf8'));
      if (raw.v !== 2) out.push(id);
    } catch { /* unreadable — report separately, not as plaintext */ }
  }
  return out;
}

module.exports = { listAgentDirs, encryptAllKeys, decryptAllKeys, listPlaintextKeys };
