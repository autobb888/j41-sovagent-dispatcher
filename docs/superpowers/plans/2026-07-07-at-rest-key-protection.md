# At-Rest WIF Key Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encrypt the agent WIF at rest (AES-256-GCM under a passphrase-derived key) so a stolen disk / copied `keys.json` / backup does not expose spendable keys, while the daemon still signs from an in-memory key unlocked once at startup.

**Architecture:** Two seams. (1) `keys-file.js` gains `readKeysFile`/`writeKeysFile` that funnel every host-side WIF access. (2) A new `keystore.js` holds an unwrapped 32-byte master key in RAM for the daemon's lifetime; the master key is itself wrapped by a scrypt-derived KEK stored in `master-key.json`. Encryption is transparent behind the funnel and strictly opt-in.

**Tech Stack:** Node.js CJS (no build step), `node:crypto` (`scryptSync`, `aes-256-gcm`, `randomBytes`), `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-07-at-rest-key-protection-design.md` — read it for the threat model and the honesty limitation (defends stolen-disk, NOT live compromise).

## Global Constraints

- **No new runtime dependency.** scrypt + AES-GCM are Node built-ins. Do NOT bump `@bitgo/utxo-lib` or `bs58check`; encryption must not touch WIF encoding/decoding.
- **Default OFF.** Encryption is opt-in only via `encrypt-keys`. A fresh setup writes plaintext v1 exactly as today.
- **Fail-closed everywhere.** No env-var kill switch that silently disables encryption or falls back to plaintext for a v2 file. A locked v2 read on the signing path throws `ELOCKED`; a wrong passphrase (GCM tag failure) throws `EBADPASS`; neither returns a partial/empty key.
- **Preserve mode 0600** on every `keys.json` and `master-key.json` write path.
- **scrypt params:** `N=131072, r=8, p=1`, 32-byte output. scrypt at N=131072 needs ~128 MB, above Node's 32 MB default — every `scryptSync` call MUST pass `maxmem: 256 * 1024 * 1024`.
- **Envelope versions are independent namespaces:** `keys.json` uses `v:2` for encrypted (absent/`v:1` = current plaintext); `master-key.json` uses `v:1` (new file).
- **Scope is host-side only.** `job-agent.js`'s `/app/keys.json` read is the legacy/dev path (container gets the WIF via the broker since commit `fc4903c`) and is OUT of scope.
- **CJS, no build step.** Validate with `node --check` and run tests with `node --test test/*.test.js`.

---

### Task 1: Read/write funnel (Tier 0 — no crypto, behavior-preserving)

Route every host-side `keys.json` access through `readKeysFile`/`writeKeysFile`. At this stage `readKeysFile` is a plaintext passthrough; the `allowLocked` option is accepted and documented but inert (no v2 exists yet). This task changes no observable behavior — it only establishes the seam so Task 4 can add encryption without touching call sites again.

**Files:**
- Modify: `src/keys-file.js` (add `readKeysFile`; keep `writeKeysFile` as-is)
- Modify: `src/cli.js:342-350` (`loadAgentKeys` → `readKeysFile`), `src/cli.js:1269-1271`, `src/cli.js:1370-1371`, `src/cli.js:1460-1462` (raw writes → `writeKeysFile`)
- Modify: `src/dashboard.js:63`, `src/dashboard.js:269`, `src/dashboard.js:1942` (reads → `readKeysFile(..., { allowLocked: true })`); add `const { readKeysFile } = require('./keys-file.js');` near the existing `writeKeysFile` import at `src/dashboard.js:18`
- Test: `test/keys-file-read.test.js` (new)

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `readKeysFile(p, { allowLocked = false } = {})` → object parsed from `p`. Tier 0: always `JSON.parse(fs.readFileSync(p,'utf8'))`. `allowLocked` currently has no effect.
  - `writeKeysFile(p, obj)` → unchanged existing helper (writes JSON at 0600).

- [ ] **Step 1: Write the failing test**

Create `test/keys-file-read.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readKeysFile, writeKeysFile } = require('../src/keys-file.js');

test('readKeysFile returns the plaintext object round-tripped through writeKeysFile', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kr-')), 'keys.json');
  const obj = { wif: 'Uabc', identity: 'a.platform@', iAddress: 'i123', network: 'verustest' };
  writeKeysFile(p, obj);
  assert.deepStrictEqual(readKeysFile(p), obj);
});

test('readKeysFile accepts an allowLocked option without changing plaintext behavior', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kr-')), 'keys.json');
  const obj = { wif: 'Uxyz', identity: 'b.platform@' };
  writeKeysFile(p, obj);
  assert.deepStrictEqual(readKeysFile(p, { allowLocked: true }), obj);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/keys-file-read.test.js`
Expected: FAIL — `readKeysFile is not a function`.

- [ ] **Step 3: Add `readKeysFile` to `src/keys-file.js`**

Replace the module body of `src/keys-file.js` with:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/keys-file-read.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Route `loadAgentKeys` through `readKeysFile`**

In `src/cli.js`, ensure the import at the top includes `readKeysFile` (the file already imports `writeKeysFile` at `src/cli.js:32`):

```js
const { writeKeysFile, readKeysFile } = require('./keys-file.js');
```

Change `loadAgentKeys` (`src/cli.js:342-350`) so the final line reads:

```js
function loadAgentKeys(agentId) {
  // P2-4: Validate agentId format to prevent path traversal
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(agentId) || agentId.includes('..')) {
    throw new Error(`Invalid agent ID format: ${agentId}`);
  }
  const keysPath = path.join(AGENTS_DIR, agentId, 'keys.json');
  if (!fs.existsSync(keysPath)) return null;
  return readKeysFile(keysPath);
}
```

- [ ] **Step 6: Route the three raw `keys.json` writes through `writeKeysFile`**

`src/cli.js:1269-1271` becomes:

```js
      writeKeysFile(path.join(agentDir, 'keys.json'), { ...keys, network: J41_NETWORK });
```

`src/cli.js:1370-1371` becomes:

```js
      writeKeysFile(path.join(AGENTS_DIR, agentId, 'keys.json'), keys);
```

`src/cli.js:1460-1462` becomes:

```js
        writeKeysFile(path.join(AGENTS_DIR, agentId, 'keys.json'), keys);
```

(Each replaces a `fs.writeFileSync(... { mode: 0o600 })` plus, at 1269/1460, a following `fs.chmodSync(..., 0o600)`. `writeKeysFile` performs both.)

- [ ] **Step 7: Route the three dashboard reads through `readKeysFile`**

In `src/dashboard.js`, extend the import at `src/dashboard.js:18`:

```js
const { writeKeysFile, readKeysFile } = require('./keys-file.js');
```

`src/dashboard.js:63` becomes:

```js
        const keys = readKeysFile(path.join(AGENTS_DIR, id, 'keys.json'), { allowLocked: true });
```

`src/dashboard.js:269` becomes:

```js
  const keys = readKeysFile(path.join(agentDir, 'keys.json'), { allowLocked: true });
```

`src/dashboard.js:1942` becomes:

```js
  const keysData = readKeysFile(keysPath, { allowLocked: true });
```

- [ ] **Step 8: Syntax-check and run the full suite**

Run: `node --check src/cli.js src/dashboard.js src/keys-file.js && node --test test/keys-file-read.test.js test/keys-write.test.js`
Expected: PASS. (`test/keys-write.test.js` still passes — `writeKeysFile` is unchanged.)

- [ ] **Step 9: Commit**

```bash
git add src/keys-file.js src/cli.js src/dashboard.js test/keys-file-read.test.js
git commit -m "refactor(keys): funnel all host-side keys.json reads/writes through keys-file helpers"
```

---

### Task 2: `keystore.js` crypto core (pure functions)

Add the pure cryptographic primitives with no singleton state and no file I/O for secrets yet. Fully unit-testable in isolation.

**Files:**
- Create: `src/keystore.js`
- Test: `test/keystore-crypto.test.js` (new)

**Interfaces:**
- Consumes: nothing.
- Produces (all exported from `src/keystore.js`):
  - `SCRYPT_PARAMS` = `{ N: 131072, r: 8, p: 1 }`
  - `deriveKek(passphrase, { N, r, p, salt })` → `Buffer` (32 bytes). `salt` is a `Buffer`.
  - `createMasterKey()` → `Buffer` (32 random bytes).
  - `wrapMasterKey(masterKey, kek)` / `unwrapMasterKey(wrapped, kek)` — AES-256-GCM. `wrapped` = `{ alg, iv, ct, tag }` (base64 strings). `unwrap` returns a `Buffer`, throws on tag mismatch.
  - `encryptSecret(masterKey, plaintextBuf)` → `{ alg, iv, ct, tag }`; `decryptSecret(masterKey, envelope)` → `Buffer`, throws on tag mismatch.

- [ ] **Step 1: Write the failing test**

Create `test/keystore-crypto.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const ks = require('../src/keystore.js');

test('deriveKek is deterministic for a fixed salt and 32 bytes long', () => {
  const salt = Buffer.alloc(16, 7);
  const a = ks.deriveKek('hunter2', { ...ks.SCRYPT_PARAMS, salt });
  const b = ks.deriveKek('hunter2', { ...ks.SCRYPT_PARAMS, salt });
  assert.equal(a.length, 32);
  assert.ok(a.equals(b));
});

test('deriveKek differs for a different passphrase', () => {
  const salt = Buffer.alloc(16, 7);
  const a = ks.deriveKek('hunter2', { ...ks.SCRYPT_PARAMS, salt });
  const b = ks.deriveKek('hunter3', { ...ks.SCRYPT_PARAMS, salt });
  assert.ok(!a.equals(b));
});

test('encryptSecret/decryptSecret round-trip', () => {
  const mk = ks.createMasterKey();
  const pt = Buffer.from(JSON.stringify({ wif: 'Uabc123' }), 'utf8');
  const env = ks.encryptSecret(mk, pt);
  assert.equal(env.alg, 'aes-256-gcm');
  assert.ok(ks.decryptSecret(mk, env).equals(pt));
});

test('decryptSecret throws on a wrong key (tag mismatch)', () => {
  const env = ks.encryptSecret(ks.createMasterKey(), Buffer.from('x'));
  assert.throws(() => ks.decryptSecret(ks.createMasterKey(), env));
});

test('decryptSecret throws on tampered ciphertext', () => {
  const mk = ks.createMasterKey();
  const env = ks.encryptSecret(mk, Buffer.from('hello'));
  const bad = Buffer.from(env.ct, 'base64'); bad[0] ^= 0xff;
  assert.throws(() => ks.decryptSecret(mk, { ...env, ct: bad.toString('base64') }));
});

test('wrapMasterKey/unwrapMasterKey round-trip', () => {
  const kek = crypto.randomBytes(32);
  const mk = ks.createMasterKey();
  assert.ok(ks.unwrapMasterKey(ks.wrapMasterKey(mk, kek), kek).equals(mk));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/keystore-crypto.test.js`
Expected: FAIL — cannot find module `../src/keystore.js`.

- [ ] **Step 3: Implement `src/keystore.js` crypto core**

Create `src/keystore.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/keystore-crypto.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/keystore.js test/keystore-crypto.test.js
git commit -m "feat(keystore): AES-256-GCM crypto core + scrypt KEK derivation"
```

---

### Task 3: keystore singleton, `master-key.json` lifecycle, passphrase resolution

Add the in-memory master-key singleton, the `master-key.json` create/unlock/change-passphrase functions, and the passphrase resolver (systemd-cred → env → interactive), plus a hidden TTY prompt. This is the Tier 2 unattended sourcing folded into the keystore.

**Files:**
- Modify: `src/keystore.js` (append singleton + file lifecycle + resolver)
- Test: `test/keystore-singleton.test.js` (new)

**Interfaces:**
- Consumes: everything from Task 2.
- Produces (added exports on `src/keystore.js`):
  - `isUnlocked()` → boolean; `getMasterKey()` → `Buffer` (throws `Error{code:'ELOCKED'}` if locked); `lock()` → void (zeroizes + drops the key).
  - `initMasterKey(passphrase, masterKeyPath)` → void. Creates `master-key.json` (0600, `v:1`) and leaves the keystore unlocked. Throws if the file already exists.
  - `unlock(passphrase, masterKeyPath)` → void. Loads `master-key.json`, derives KEK, unwraps master key into memory. Throws `Error{code:'EBADPASS'}` on a wrong passphrase.
  - `changePassphrase(oldPass, newPass, masterKeyPath)` → void. Re-wraps the same master key under a new KEK; rewrites `master-key.json`.
  - `resolvePassphraseSync({ env })` → string | null. Non-interactive: systemd-cred file then `J41_KEYS_PASSPHRASE`, else null.
  - `resolvePassphrase({ env, promptFn })` → Promise<string>. systemd-cred → env → `promptFn()` (only if `process.stdin.isTTY`); throws `Error{code:'ENOPASS'}` if none available.
  - `promptHidden(question)` → Promise<string>. Reads a line from the TTY without echoing.

- [ ] **Step 1: Write the failing test**

Create `test/keystore-singleton.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ks = require('../src/keystore.js');

function tmpMk() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-')), 'master-key.json');
}

test('initMasterKey creates a 0600 v:1 file and leaves the pool unlocked', () => {
  const mk = tmpMk();
  ks.lock();
  ks.initMasterKey('pw', mk);
  assert.ok(ks.isUnlocked());
  assert.equal(fs.statSync(mk).mode & 0o777, 0o600);
  const doc = JSON.parse(fs.readFileSync(mk, 'utf8'));
  assert.equal(doc.v, 1);
  assert.equal(doc.kdf.alg, 'scrypt');
  ks.lock();
});

test('initMasterKey refuses to overwrite an existing file', () => {
  const mk = tmpMk();
  ks.initMasterKey('pw', mk); ks.lock();
  assert.throws(() => ks.initMasterKey('pw', mk), /already exists/);
});

test('unlock with the correct passphrase unlocks; getMasterKey returns 32 bytes', () => {
  const mk = tmpMk();
  ks.initMasterKey('correct horse', mk); ks.lock();
  assert.ok(!ks.isUnlocked());
  ks.unlock('correct horse', mk);
  assert.ok(ks.isUnlocked());
  assert.equal(ks.getMasterKey().length, 32);
  ks.lock();
});

test('unlock with a wrong passphrase throws EBADPASS and stays locked', () => {
  const mk = tmpMk();
  ks.initMasterKey('right', mk); ks.lock();
  assert.throws(() => ks.unlock('wrong', mk), (e) => e.code === 'EBADPASS');
  assert.ok(!ks.isUnlocked());
});

test('getMasterKey throws ELOCKED when locked', () => {
  ks.lock();
  assert.throws(() => ks.getMasterKey(), (e) => e.code === 'ELOCKED');
});

test('changePassphrase preserves the master key (old fails, new unlocks)', () => {
  const mk = tmpMk();
  ks.initMasterKey('old', mk);
  const before = Buffer.from(ks.getMasterKey());
  ks.lock();
  ks.changePassphrase('old', 'new', mk);
  assert.throws(() => ks.unlock('old', mk), (e) => e.code === 'EBADPASS');
  ks.unlock('new', mk);
  assert.ok(ks.getMasterKey().equals(before));
  ks.lock();
});

test('resolvePassphraseSync prefers systemd credential, then env, else null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-'));
  fs.writeFileSync(path.join(dir, 'j41-keys-passphrase'), 'from-cred\n');
  assert.equal(ks.resolvePassphraseSync({ env: { CREDENTIALS_DIRECTORY: dir, J41_KEYS_PASSPHRASE: 'from-env' } }), 'from-cred');
  assert.equal(ks.resolvePassphraseSync({ env: { J41_KEYS_PASSPHRASE: 'from-env' } }), 'from-env');
  assert.equal(ks.resolvePassphraseSync({ env: {} }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/keystore-singleton.test.js`
Expected: FAIL — `ks.initMasterKey is not a function`.

- [ ] **Step 3: Append the singleton, lifecycle, and resolver to `src/keystore.js`**

Add `const fs = require('fs');` and `const path = require('path');` to the requires at the top of `src/keystore.js`, then insert before `module.exports`:

```js
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
```

Extend `module.exports` to add: `isUnlocked, getMasterKey, lock, initMasterKey, unlock, changePassphrase, resolvePassphraseSync, resolvePassphrase, promptHidden`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/keystore-singleton.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/keystore.js test/keystore-singleton.test.js
git commit -m "feat(keystore): master-key.json lifecycle, unlock/lock singleton, passphrase resolution"
```

---

### Task 4: Wire encryption into the funnel

Upgrade `readKeysFile`/`writeKeysFile` to handle v2 envelopes, and make `readKeysFile` transparently lazy-unlock from a non-interactive source (env / systemd-cred) when it meets a locked v2 file on the default (secret-needed) path — so every one-off signing command (register-service, dispute, etc.) works under `J41_KEYS_PASSPHRASE`/systemd-cred without threading unlock logic through ~40 call sites. `start` still unlocks interactively up-front (Task 6). Because `readKeysFile` lives in `keys-file.js` (which must stay path-agnostic and unit-testable), the lazy unlock finds `master-key.json` through a path the `keystore` singleton holds; `cli.js` registers it once at startup via `keystore.setMasterKeyPath(MASTER_KEY_PATH)`. In unit tests the path is unregistered, so lazy unlock is a deterministic no-op and the "locked → ELOCKED" behavior is preserved.

**Files:**
- Modify: `src/keystore.js` (add `setMasterKeyPath` + `lazyUnlockSync`, extend exports)
- Modify: `src/keys-file.js` (`readKeysFile` v2 branch with lazy-unlock; `writeKeysFile` v2 branch)
- Modify: `src/cli.js` (add `MASTER_KEY_PATH` constant + `keystore` import + `keystore.setMasterKeyPath(MASTER_KEY_PATH)` at module load). `loadAgentKeys` is NOT changed — Task 1 already routed it through `readKeysFile`, which now handles lazy unlock itself.
- Test: `test/keys-file-encrypted.test.js` (new)

**Interfaces:**
- Consumes: `keystore.{isUnlocked,getMasterKey,encryptSecret,decryptSecret,unlock,resolvePassphraseSync}` (Tasks 2–3).
- Produces:
  - `keystore.setMasterKeyPath(p)` → void. Stores the `master-key.json` path in module state so `lazyUnlockSync` can find it. Unset in unit tests → lazy unlock is a no-op.
  - `keystore.lazyUnlockSync()` → boolean. Returns `false` (no-op) if already unlocked, no path registered, the file is absent, or no non-interactive passphrase is available; otherwise calls `unlock(pass, path)` (may throw `EBADPASS` on a wrong env/cred passphrase — fail closed) and returns `true`.
  - `readKeysFile(p, { allowLocked })`: v1 → plaintext; v2 + unlocked → decrypt & merge `wif`, return without `v`/`encrypted`; v2 + locked + default → attempt `keystore.lazyUnlockSync()`, then if still locked throw `Error{code:'ELOCKED'}`; v2 + locked + `allowLocked` → public fields only (no `wif`/`v`/`encrypted`), no unlock attempted.
  - `writeKeysFile(p, obj)`: keystore unlocked AND `obj.wif` defined → write `{ v:2, ...public, encrypted }`; otherwise plaintext (unchanged).
  - `MASTER_KEY_PATH` constant in `cli.js` = `path.join(DISPATCHER_DIR, 'master-key.json')`.

- [ ] **Step 1: Write the failing test**

Create `test/keys-file-encrypted.test.js`. Note test ordering: the ELOCKED test must run before any test registers a master-key path, so keep the auto-unlock test LAST (it registers a path + env passphrase and resets both in a `finally`).

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ks = require('../src/keystore.js');
const { readKeysFile, writeKeysFile } = require('../src/keys-file.js');

function tmpKeys() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ke-')), 'keys.json');
}
const OBJ = { wif: 'Usecret123', identity: 'a.platform@', iAddress: 'i9', network: 'verustest' };

test('unlocked write produces a v2 envelope with public fields in the clear', () => {
  const mk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ke-mk-')), 'master-key.json');
  ks.lock(); ks.initMasterKey('pw', mk);
  const p = tmpKeys();
  writeKeysFile(p, OBJ);
  const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(onDisk.v, 2);
  assert.equal(onDisk.identity, 'a.platform@');
  assert.equal(onDisk.wif, undefined);
  assert.ok(onDisk.encrypted && onDisk.encrypted.alg === 'aes-256-gcm');
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  ks.lock();
});

test('v2 round-trips when unlocked (wif recovered, no envelope markers leak)', () => {
  const mk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ke-mk-')), 'master-key.json');
  ks.lock(); ks.initMasterKey('pw', mk);
  const p = tmpKeys();
  writeKeysFile(p, OBJ);
  assert.deepStrictEqual(readKeysFile(p), OBJ);
  ks.lock();
});

test('v2 read while locked throws ELOCKED by default (no path registered, no lazy unlock)', () => {
  const mk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ke-mk-')), 'master-key.json');
  ks.lock(); ks.initMasterKey('pw', mk);
  const p = tmpKeys(); writeKeysFile(p, OBJ);
  ks.lock();
  assert.throws(() => readKeysFile(p), (e) => e.code === 'ELOCKED');
});

test('v2 read while locked with allowLocked returns public fields only', () => {
  const mk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ke-mk-')), 'master-key.json');
  ks.lock(); ks.initMasterKey('pw', mk);
  const p = tmpKeys(); writeKeysFile(p, OBJ);
  ks.lock();
  const pub = readKeysFile(p, { allowLocked: true });
  assert.equal(pub.identity, 'a.platform@');
  assert.equal(pub.iAddress, 'i9');
  assert.equal(pub.wif, undefined);
  assert.equal(pub.v, undefined);
  assert.equal(pub.encrypted, undefined);
});

test('locked write (no unlock) stays plaintext v1', () => {
  ks.lock();
  const p = tmpKeys();
  writeKeysFile(p, OBJ);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), OBJ);
});

test('v2 read lazy-unlocks from J41_KEYS_PASSPHRASE when a master-key path is registered', () => {
  const mk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ke-mk-')), 'master-key.json');
  ks.lock(); ks.initMasterKey('envpw', mk);
  const p = tmpKeys(); writeKeysFile(p, OBJ);
  ks.lock();
  ks.setMasterKeyPath(mk);
  process.env.J41_KEYS_PASSPHRASE = 'envpw';
  try {
    assert.deepStrictEqual(readKeysFile(p), OBJ); // lazy-unlocks then decrypts
    assert.ok(ks.isUnlocked());
  } finally {
    delete process.env.J41_KEYS_PASSPHRASE;
    ks.setMasterKeyPath(null);
    ks.lock();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/keys-file-encrypted.test.js`
Expected: FAIL — the first test finds `onDisk.v === undefined` (write still plaintext); the lazy-unlock test fails with `ks.setMasterKeyPath is not a function`.

- [ ] **Step 3: Add `setMasterKeyPath` + `lazyUnlockSync` to `src/keystore.js`**

In `src/keystore.js`, insert before `module.exports` (it already requires `fs` and `path` from Task 3):

```js
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
```

Extend `module.exports` to also export `setMasterKeyPath` and `lazyUnlockSync` (keep every existing export).

- [ ] **Step 4: Upgrade `src/keys-file.js`**

Replace the body of `src/keys-file.js` with:

```js
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
  fs.writeFileSync(p, JSON.stringify(toWrite, null, 2), { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch (_) {}
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/keys-file-encrypted.test.js test/keys-file-read.test.js test/keys-write.test.js`
Expected: PASS (all — plaintext behavior preserved, v2 behavior + lazy unlock added).

- [ ] **Step 6: Wire `MASTER_KEY_PATH` + keystore registration into `src/cli.js`**

In `src/cli.js`, add near the `keys-file` import (`src/cli.js:32`, which already imports `readKeysFile`/`writeKeysFile`):

```js
const keystore = require('./keystore.js');
```

Add a `MASTER_KEY_PATH` constant next to where `AGENTS_DIR`/`DISPATCHER_DIR` are defined (search for `AGENTS_DIR =`), and register it with the keystore on the next line so every command's `readKeysFile` calls can lazy-unlock:

```js
const MASTER_KEY_PATH = path.join(DISPATCHER_DIR, 'master-key.json');
keystore.setMasterKeyPath(MASTER_KEY_PATH);
```

Do NOT change `loadAgentKeys` — Task 1 already routed it through `readKeysFile`, which now performs the lazy unlock itself. Verify `loadAgentKeys` still reads `return readKeysFile(keysPath);` and leave it.

- [ ] **Step 7: Syntax-check and run the suite**

Run: `node --check src/cli.js src/keys-file.js src/keystore.js && node --test test/keys-file-encrypted.test.js test/keys-file-read.test.js test/keys-write.test.js test/keystore-crypto.test.js test/keystore-singleton.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/keystore.js src/keys-file.js src/cli.js test/keys-file-encrypted.test.js
git commit -m "feat(keys): transparent v2 at-rest encryption + lazy unlock behind the read/write funnel"
```

---

### Task 5: Migration helpers + `encrypt-keys` / `decrypt-keys` / `change-passphrase` commands

Add a pure migration module and wire the three CLI commands. The pure functions are unit-tested; the command actions are thin interactive wiring over them.

**Files:**
- Create: `src/keys-migrate.js`
- Modify: `src/cli.js` (three new `.command(...)` blocks; place them alongside other command definitions, e.g. after the `start` command near `src/cli.js:2926`)
- Test: `test/keys-migrate.test.js` (new)

**Interfaces:**
- Consumes: `keystore.*` (Tasks 2–3), `readKeysFile`/`writeKeysFile` (Task 4).
- Produces (exported from `src/keys-migrate.js`):
  - `listAgentDirs(agentsDir)` → string[] of agent ids that have a `keys.json`.
  - `encryptAllKeys(agentsDir)` → number. Requires the keystore unlocked. Rewrites each v1 `keys.json` as v2; skips those already v2. Returns count encrypted.
  - `decryptAllKeys(agentsDir)` → number. Requires the keystore unlocked. Reads+decrypts every v2 file into memory, then locks the keystore and writes each back as plaintext. Returns count decrypted.

- [ ] **Step 1: Write the failing test**

Create `test/keys-migrate.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ks = require('../src/keystore.js');
const { writeKeysFile } = require('../src/keys-file.js');
const mig = require('../src/keys-migrate.js');

function makePool() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-'));
  const agentsDir = path.join(root, 'agents');
  for (const id of ['a1', 'a2']) {
    fs.mkdirSync(path.join(agentsDir, id), { recursive: true });
    ks.lock(); // ensure plaintext write
    writeKeysFile(path.join(agentsDir, id, 'keys.json'), { wif: `wif-${id}`, identity: `${id}@`, network: 'verustest' });
  }
  return { root, agentsDir, mk: path.join(root, 'master-key.json') };
}

test('encrypt then decrypt round-trips every WIF and removes/adds envelopes', () => {
  const { agentsDir, mk } = makePool();
  ks.lock(); ks.initMasterKey('pw', mk);
  assert.equal(mig.encryptAllKeys(agentsDir), 2);
  // On disk both are v2 now.
  for (const id of ['a1', 'a2']) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentsDir, id, 'keys.json'), 'utf8')).v, 2);
  }
  // decryptAllKeys leaves the keystore locked and files plaintext.
  assert.equal(mig.decryptAllKeys(agentsDir), 2);
  assert.ok(!ks.isUnlocked());
  for (const id of ['a1', 'a2']) {
    const onDisk = JSON.parse(fs.readFileSync(path.join(agentsDir, id, 'keys.json'), 'utf8'));
    assert.equal(onDisk.v, undefined);
    assert.equal(onDisk.wif, `wif-${id}`);
  }
});

test('encryptAllKeys skips files already encrypted', () => {
  const { agentsDir, mk } = makePool();
  ks.lock(); ks.initMasterKey('pw', mk);
  assert.equal(mig.encryptAllKeys(agentsDir), 2);
  assert.equal(mig.encryptAllKeys(agentsDir), 0); // idempotent
  ks.lock();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/keys-migrate.test.js`
Expected: FAIL — cannot find module `../src/keys-migrate.js`.

- [ ] **Step 3: Implement `src/keys-migrate.js`**

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/keys-migrate.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the three CLI commands in `src/cli.js`**

Add these command definitions (near the other `.command(...)` blocks, e.g. after the `start` command at `src/cli.js:2926`). They rely on `MASTER_KEY_PATH`, `AGENTS_DIR`, `keystore`, and the `keys-migrate` module:

```js
const { encryptAllKeys, decryptAllKeys } = require('./keys-migrate.js');

program
  .command('encrypt-keys')
  .description('Encrypt all agent WIFs at rest with a passphrase (opt-in)')
  .action(async () => {
    if (fs.existsSync(MASTER_KEY_PATH)) {
      console.error('❌ Keys are already encrypted (master-key.json exists). Use change-passphrase.');
      process.exit(1);
    }
    const p1 = await keystore.promptHidden('New passphrase: ');
    const p2 = await keystore.promptHidden('Confirm passphrase: ');
    if (!p1 || p1 !== p2) { console.error('❌ Passphrases empty or do not match.'); process.exit(1); }
    keystore.initMasterKey(p1, MASTER_KEY_PATH); // creates file + unlocks
    const n = encryptAllKeys(AGENTS_DIR);
    keystore.lock();
    console.log(`\n🔐 Encrypted ${n} agent key file(s).`);
    console.log('   The daemon will prompt for this passphrase on `start`.');
    console.log('   Unattended: set J41_KEYS_PASSPHRASE or a systemd credential (j41-keys-passphrase).');
    console.log('   Note: at-rest encryption protects a stolen disk/backup, not a live-compromised host.');
  });

program
  .command('decrypt-keys')
  .description('Remove at-rest encryption; store WIFs as plaintext again')
  .action(async () => {
    if (!fs.existsSync(MASTER_KEY_PATH)) { console.error('❌ Keys are not encrypted.'); process.exit(1); }
    const pass = await keystore.resolvePassphrase({ promptFn: () => keystore.promptHidden('Passphrase: ') });
    try { keystore.unlock(pass, MASTER_KEY_PATH); }
    catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
    const n = decryptAllKeys(AGENTS_DIR); // locks the keystore internally
    fs.rmSync(MASTER_KEY_PATH);
    console.log(`\n🔓 Decrypted ${n} agent key file(s). WIFs are now plaintext at rest (mode 0600 only).`);
  });

program
  .command('change-passphrase')
  .description('Change the at-rest encryption passphrase')
  .action(async () => {
    if (!fs.existsSync(MASTER_KEY_PATH)) { console.error('❌ Keys are not encrypted.'); process.exit(1); }
    const oldPass = await keystore.promptHidden('Current passphrase: ');
    const n1 = await keystore.promptHidden('New passphrase: ');
    const n2 = await keystore.promptHidden('Confirm new passphrase: ');
    if (!n1 || n1 !== n2) { console.error('❌ New passphrases empty or do not match.'); process.exit(1); }
    try { keystore.changePassphrase(oldPass, n1, MASTER_KEY_PATH); }
    catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
    console.log('\n🔐 Passphrase changed.');
  });
```

- [ ] **Step 6: Syntax-check and run the suite**

Run: `node --check src/cli.js src/keys-migrate.js && node --test test/keys-migrate.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/keys-migrate.js src/cli.js test/keys-migrate.test.js
git commit -m "feat(cli): encrypt-keys / decrypt-keys / change-passphrase commands + migration"
```

---

### Task 6: Startup unlock in `start` + honest logging + shutdown lock

Make the daemon unlock the pool once at startup (single interactive prompt, or non-interactive source), fail closed if it cannot, and best-effort zeroize on shutdown. Verify the mainnet security gate does not reject the passphrase env var.

**Files:**
- Modify: `src/cli.js` (`start` action near `src/cli.js:2931`, after `ensureDirs()` and the mainnet gate, before it uses agents; plus the existing SIGTERM/SIGINT/exit shutdown path)
- Test: `test/keystore-resolve.test.js` (new — covers the fail-closed resolver precedence used by `start`)

**Interfaces:**
- Consumes: `keystore.{resolvePassphrase,unlock,lock,promptHidden}`, `MASTER_KEY_PATH` (Tasks 3–4), `findMainnetSecurityViolations` (existing, `src/cli.js:2937`).
- Produces: `start` unlocks up-front when `master-key.json` exists; exits non-zero with guidance if no passphrase source is available.

- [ ] **Step 1: Write the failing test**

Create `test/keystore-resolve.test.js` (locks in the fail-closed precedence `start` depends on; the interactive prompt path is not unit-tested):

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const ks = require('../src/keystore.js');

test('resolvePassphrase returns the env passphrase without prompting', async () => {
  const v = await ks.resolvePassphrase({ env: { J41_KEYS_PASSPHRASE: 'envpass' }, promptFn: () => { throw new Error('should not prompt'); } });
  assert.equal(v, 'envpass');
});

test('resolvePassphrase throws ENOPASS when no source and no TTY prompt', async () => {
  await assert.rejects(
    ks.resolvePassphrase({ env: {}, promptFn: undefined }),
    (e) => e.code === 'ENOPASS',
  );
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `node --test test/keystore-resolve.test.js`
Expected: PASS (these exercise Task 3 code). If it fails, fix the resolver before continuing. This test guards the behavior `start` relies on.

- [ ] **Step 3: Add the startup unlock block to the `start` action**

In `src/cli.js`, inside the `start` action (after the mainnet-gate block that ends near `src/cli.js:2950`, before `const agents = listRegisteredAgents();` at `src/cli.js:2952`), insert:

```js
    // ── Unlock the at-rest key pool (if encryption is enabled) ──
    // One prompt at startup; the master key then lives in memory for the life
    // of the daemon. At-rest encryption protects a stolen disk/backup — NOT a
    // live-compromised running host (the key is resident once unlocked).
    if (fs.existsSync(MASTER_KEY_PATH)) {
      try {
        const pass = await keystore.resolvePassphrase({ promptFn: () => keystore.promptHidden('🔐 Unlock passphrase: ') });
        keystore.unlock(pass, MASTER_KEY_PATH);
        console.log('  🔓 Key pool unlocked (WIFs decrypted in memory only)');
      } catch (e) {
        console.error(`\n❌ Cannot unlock the key pool: ${e.message}`);
        process.exit(1);
      }
    }
```

- [ ] **Step 4: Zeroize on shutdown**

Find the existing shutdown handler(s) in `src/cli.js` (search for `SIGTERM` within the `start` action) and add `keystore.lock();` to the cleanup so the master key is wiped on graceful exit. If a single `shutdown` function exists, add the call there; otherwise add to each `process.on('SIGTERM'|'SIGINT', ...)` handler:

```js
      keystore.lock();
```

- [ ] **Step 5: Verify the mainnet gate tolerates the passphrase env var**

Run: `node -e "const {findMainnetSecurityViolations}=require('./src/mainnet-guard.js'); console.log(findMainnetSecurityViolations({J41_KEYS_PASSPHRASE:'x'}, {devUnsafe:false}))"`
Expected: `[]` (empty — `J41_KEYS_PASSPHRASE` is a passphrase source, not an insecure escape hatch). If it appears in the violations, that is a bug in this plan's assumption — stop and report; do NOT weaken the gate to work around it.

- [ ] **Step 6: Syntax-check and run the whole suite**

Run: `node --check src/cli.js && node --test test/*.test.js`
Expected: PASS (all tests, including the pre-existing suite).

- [ ] **Step 7: Manual smoke (documented, not automated)**

```bash
# In a scratch HOME so the real ~/.j41 is untouched:
export J41_TEST_HOME=$(mktemp -d)
# (Only run if you have a throwaway agent set up; otherwise skip — this is a
# manual confidence check, not a gate.)
```

Confirm by reasoning from the tests that: `encrypt-keys` → `keys.json` shows `v:2`; `start` prompts once and logs "Key pool unlocked"; `J41_KEYS_PASSPHRASE=... start` does not prompt; `decrypt-keys` restores `v:1`.

- [ ] **Step 8: Commit**

```bash
git add src/cli.js test/keystore-resolve.test.js
git commit -m "feat(start): unlock at-rest key pool at startup, fail-closed, zeroize on shutdown"
```

---

## Self-Review

**Spec coverage:**
- keystore.js crypto core → Task 2. ✓
- master-key.json + unlock/lock singleton → Task 3. ✓
- v2 envelope, public fields plaintext → Task 4. ✓
- read/write funnel + all call sites → Task 1 (route) + Task 4 (encryption). ✓
- encrypt-keys/decrypt-keys/change-passphrase → Task 5. ✓
- start unlock, passphrase resolution (systemd-cred → env → TTY), fail-closed → Task 3 (resolver) + Task 6 (wiring). ✓
- Threat-model honesty in user-facing output → Task 5/6 console notes. ✓
- Default OFF (opt-in) → no fresh-setup change; `encrypt-keys` is the only entry. ✓
- No new dependency, 0600 preserved, no plaintext-fallback kill switch → Global Constraints + enforced in each write path. ✓
- Scope host-side only (job-agent.js untouched) → confirmed; not in any task's file list. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test shows real assertions. ✓

**Type consistency:** `readKeysFile(p, {allowLocked})`, `writeKeysFile(p, obj)`, `encryptSecret/decryptSecret(env={alg,iv,ct,tag})`, `unlock/initMasterKey/changePassphrase(..., masterKeyPath)`, error codes `ELOCKED`/`EBADPASS`/`ENOPASS`, `MASTER_KEY_PATH` — used identically across Tasks 1–6. `readKeysFile` never returns `v`/`encrypted` markers (Task 4), which Task 5's `decryptAllKeys` relies on when writing plaintext. ✓
