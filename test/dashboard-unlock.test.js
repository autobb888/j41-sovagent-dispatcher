'use strict';

/**
 * K10 — encrypt-keys must not blind the TUI.
 *
 * dashboard.js calls main() on require, so this is a source + behaviour hybrid:
 * the unlock sequence is the same as cli.js start / ensureKeystoreUnlockedIfEncrypted
 * (keystore.resolvePassphrase then keystore.unlock). getAgents stays allowLocked
 * (listing never sees wif). Write/sign screens secret-read without allowLocked.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ks = require('../src/keystore.js');
const { readKeysFile, writeKeysFile } = require('../src/keys-file.js');

const DASH = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');

const OBJ = {
  wif: 'Usecret123',
  identity: 'a.platform@',
  iAddress: 'i9',
  address: 'Raddr',
  network: 'verustest',
};

function functionBody(src, name) {
  const re = new RegExp(`^(?:async )?function ${name}\\(`, 'm');
  const m = re.exec(src);
  assert.ok(m, `missing function ${name}`);
  const start = m.index;
  const after = src.slice(start + m[0].length);
  const next = /^(?:async )?function /m.exec(after);
  return next ? src.slice(start, start + m[0].length + next.index) : src.slice(start);
}

function readKeysFileCalls(body) {
  const calls = [];
  const needle = 'readKeysFile(';
  let from = 0;
  while (true) {
    const start = body.indexOf(needle, from);
    if (start === -1) break;
    let i = start + needle.length;
    let depth = 1;
    while (i < body.length && depth > 0) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')') depth--;
      i++;
    }
    calls.push(body.slice(start, i));
    from = i;
  }
  return calls;
}

function hasSecretRead(body) {
  return readKeysFileCalls(body).some((c) => !/allowLocked/.test(c));
}

function mainEntryBeforeMenu() {
  const mainAt = DASH.indexOf('async function main()');
  assert.ok(mainAt > -1, 'missing main()');
  const ttyAt = DASH.indexOf('if (!process.stdin.isTTY)', mainAt);
  const whileAt = DASH.indexOf('while (true)', mainAt);
  assert.ok(ttyAt > mainAt, 'TTY check missing in main()');
  assert.ok(whileAt > ttyAt, 'menu loop must follow the TTY check');
  return DASH.slice(ttyAt, whileAt);
}

function caseBlock(src, label) {
  const start = src.indexOf(`case '${label}'`);
  assert.ok(start > -1, `missing case '${label}'`);
  const next = src.indexOf('\n      case ', start + 8);
  return src.slice(start, next === -1 ? start + 2500 : next);
}

// ── Behaviour: encrypted fixture + the same unlock sequence cli start uses ──

test('encrypted pool: allowLocked listing has no wif; unlock then secret read returns wif', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-dash-unlock-'));
  const mk = path.join(dir, 'master-key.json');
  const keysPath = path.join(dir, 'agents', 'agent-1', 'keys.json');
  fs.mkdirSync(path.dirname(keysPath), { recursive: true });

  ks.lock();
  ks.initMasterKey('dash-unlock-pw', mk);
  writeKeysFile(keysPath, OBJ);
  ks.lock();

  const listed = readKeysFile(keysPath, { allowLocked: true });
  assert.equal(listed.identity, 'a.platform@');
  assert.equal(listed.iAddress, 'i9');
  assert.equal(listed.wif, undefined, 'getAgents-style allowLocked must not expose wif');

  process.env.J41_KEYS_PASSPHRASE = 'dash-unlock-pw';
  ks.setMasterKeyPath(mk);
  try {
    assert.equal(ks.isUnlocked(), false);
    const pass = await ks.resolvePassphrase();
    ks.unlock(pass, mk);
    const secret = readKeysFile(keysPath);
    assert.equal(secret.wif, 'Usecret123');
    assert.equal(secret.identity, 'a.platform@');
  } finally {
    delete process.env.J41_KEYS_PASSPHRASE;
    ks.setMasterKeyPath(null);
    ks.lock();
  }
});

// ── CLASS: dashboard entry unlocks the way cli.js start does ──

test('CLASS: dashboard does not require cli.js and has no mustUnlockForWriteScreens helper', () => {
  assert.doesNotMatch(DASH, /require\(\s*['"]\.\/cli(?:\.js)?['"]\s*\)/);
  assert.doesNotMatch(DASH, /mustUnlockForWriteScreens/);
  assert.ok(
    /require\(\s*['"]\.\/keystore(?:\.js)?['"]\s*\)/.test(DASH),
    'dashboard must import keystore.js (not cli.js) for the unlock sequence',
  );
});

test('CLASS: main() unlocks an encrypted pool after the TTY check and before the menu loop', () => {
  const entry = mainEntryBeforeMenu();
  assert.match(entry, /v\s*===\s*2/, 'must look for v:2 keys.json');
  assert.match(entry, /isUnlocked\s*\(/, 'must skip unlock when already unlocked');
  const resolveAt = entry.search(/keystore\.resolvePassphrase\s*\(/);
  const unlockAt = entry.search(/keystore\.unlock\s*\(/);
  assert.ok(resolveAt > -1, 'main() must call keystore.resolvePassphrase (same as cli start)');
  assert.ok(unlockAt > resolveAt, 'main() must call keystore.unlock after resolvePassphrase');
  assert.match(entry, /MASTER_KEY_PATH/, 'unlock must use the dispatcher master-key path');
});

test('CLASS: getAgents listing stays on allowLocked', () => {
  const body = functionBody(DASH, 'getAgents');
  const calls = readKeysFileCalls(body);
  assert.ok(calls.length > 0, 'getAgents must read keys.json');
  assert.ok(calls.every((c) => /allowLocked/.test(c)), 'listing must never secret-read wif');
});

// ── CLASS: screens that sign or write on-chain secret-read after unlock ──

const WRITE_SCREENS = [
  'batchActivateScreen',
  'browseBountiesScreen',
  'postBountyScreen',
  'myBountiesScreen',
  'apiEndpointSetupScreen',
  'configureServicesScreen',
  'fetchCategories',
  'agentDetailScreen',
];

test('CLASS: sign/on-chain screens secret-read keys without allowLocked', () => {
  const missing = [];
  for (const name of WRITE_SCREENS) {
    const body = functionBody(DASH, name);
    if (!hasSecretRead(body)) missing.push(name);
  }
  assert.deepStrictEqual(missing, [],
    `these screens need wif but never call readKeysFile without allowLocked: ${missing.join(', ')}`);
});

test('CLASS: inspect/inbox/earnings secret-read keys instead of trusting getAgents wif', () => {
  const main = functionBody(DASH, 'main');
  const missing = [];
  for (const label of ['inspect', 'inbox', 'earnings']) {
    const block = caseBlock(main, label);
    const secret = hasSecretRead(block);
    const needsKeys = /createAgent|vdxfScreen/.test(block);
    if (needsKeys && !secret) missing.push(label);
  }
  assert.deepStrictEqual(missing, [],
    `these menu cases create an agent without a secret keys read: ${missing.join(', ')}`);
});
