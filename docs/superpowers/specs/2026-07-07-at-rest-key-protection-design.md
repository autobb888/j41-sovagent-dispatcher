# At-Rest WIF Key Protection — Design

**Date:** 2026-07-07
**Status:** Approved for planning
**Item:** L1 in the Verus daemonless-signing disclosure (`docs/verus-review/`) — the
agent WIF is stored plaintext at `~/.j41/dispatcher/agents/<id>/keys.json` (mode
0600 the only protection). This design adds at-rest encryption, mirroring
verusd `encryptwallet`.

---

## Goal

Encrypt the agent WIF at rest so a stolen disk, copied `keys.json`, or backup does
not expose spendable keys. One passphrase unlocks the whole dispatcher pool at
startup; the unwrapped key lives only in RAM.

## Threat model — stated honestly

**Defends:** stolen disk, copied `keys.json`, leaked backup, another local user
reading the file, a snapshot/image of the host filesystem.

**Does NOT defend:** a live-compromised running dispatcher. Once unlocked, the
master key is resident in process memory for the daemon's lifetime, so an attacker
who compromises the running process (or reads its memory) can recover keys. This is
identical to verusd's posture with an unlocked wallet. Defending live compromise
requires an external/HSM signer (approach C below), which is a separate later
effort and explicitly out of scope here.

The spec, and the Verus disclosure doc that references it, must carry this
limitation verbatim. Do not overstate the guarantee.

## Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Unlock model | Passphrase primary + opt-in unattended | Strong interactive default; headless restart still possible, labeled weaker |
| Master-key scope | Per-install (one master key) | One operator owns the whole pool; matches verusd's single wallet; one prompt |
| KDF | scrypt (Node built-in) | Zero new dependency, memory-hard, sufficient for a passphrase KEK |
| Default | Off, opt-in via `encrypt-keys` | Validate live before flipping on; no onboarding-UX change on ship |

## Scope narrowing (discovered during grounding)

Since commit `fc4903c` ("remove legacy WIF-into-container mount; broker signing now
mandatory"), the **container never receives the WIF at rest**. `job-agent.js`'s
`/app/keys.json` read is the legacy/dev-only path; in production the host-side
signing broker holds the WIF. Therefore this work targets **host-side
`keys.json` only** — the reads in `cli.js` and `dashboard.js`. `job-agent.js` is
out of scope.

---

## Approach

**Chosen — A: choke-point + keystore singleton.** Two seams:

1. `readKeysFile` / `writeKeysFile` in `keys-file.js` funnel every WIF access.
2. A new `keystore.js` holds the unwrapped master key in RAM for the daemon's
   lifetime.

Decryption is transparent — once callers route through the funnel, they do not
change again when encryption is switched on.

**Rejected — B: per-read passphrase.** Re-derive/decrypt on each read. scrypt is
~100 ms per derivation and a signing daemon cannot re-prompt per signature. Breaks
the core use case.

**Rejected (deferred) — C: external signer service.** Move signing out of process
entirely — the only approach that defends live compromise. But tx-building still
needs the WIF locally, so it is a large separate effort, not part of #9.

---

## Components

### `src/keystore.js` (new) — crypto core + in-RAM master key

Pure, unit-testable functions plus a module-level singleton for the unwrapped
master key.

- `deriveKek(passphrase, { N, r, p, salt })` → 32-byte KEK via `crypto.scryptSync`.
  Defaults: `N = 131072 (2^17)`, `r = 8`, `p = 1`.
- `createMasterKey()` → 32 random bytes (`crypto.randomBytes(32)`).
- `wrapMasterKey(masterKey, kek)` / `unwrapMasterKey(wrapped, kek)` — AES-256-GCM.
- `encryptSecret(masterKey, plaintextBuf)` → `{ alg, iv, ct, tag }` (AES-256-GCM,
  random 12-byte IV).
- `decryptSecret(masterKey, envelope)` → plaintext buffer. GCM tag mismatch throws
  (wrong key / tampered) — fail closed.
- Singleton API: `unlock(passphrase)` (loads `master-key.json`, derives KEK,
  unwraps, stores master key in a module variable), `isUnlocked()`,
  `getMasterKey()` (throws if locked), `lock()` (overwrite the buffer with zeros,
  drop the reference).

### `master-key.json` (`~/.j41/dispatcher/`, mode 0600)

```json
{
  "v": 1,
  "kdf": { "alg": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<base64>" },
  "wrapped": { "alg": "aes-256-gcm", "iv": "<base64>", "ct": "<base64>", "tag": "<base64>" }
}
```

`unlock`: `scrypt(passphrase, salt)` → KEK → AES-GCM-decrypt `wrapped` → 32-byte
master key in RAM. Tag failure = wrong passphrase → clear error, exit non-zero.

### Encrypted `keys.json` (v2)

Public fields stay plaintext so `dashboard` listing works **without** unlock; only
the secret is encrypted.

```json
{
  "v": 2,
  "identity": "agent@",
  "iAddress": "i...",
  "network": "verustest",
  "encrypted": { "alg": "aes-256-gcm", "iv": "<base64>", "ct": "<base64>", "tag": "<base64>" }
}
```

`ct` = AES-256-GCM ciphertext of `JSON.stringify({ wif })` (a sub-object, so future
secret fields — e.g. a z-address spending key — extend cleanly). The current
plaintext form is **v1**; if a `keys.json` has no `v` or `v: 1`, it reads
transparently as plaintext (no `v` field is treated as v1).

### `src/keys-file.js` (extend) — the funnel

- **`readKeysFile(path)`** (new):
  - v1 → `JSON.parse(fs.readFileSync(path))` passthrough (exact current behavior).
  - v2 → require `keystore.isUnlocked()`; `decryptSecret` the `encrypted` field;
    merge the decrypted `{ wif }` back onto the object; return. Locked → throw a
    clear "key pool is locked" error.
- **`writeKeysFile(path, obj)`** (extend; keep signature):
  - If `master-key.json` exists **and** `keystore.isUnlocked()` → split the secret
    (`wif`) out, `encryptSecret` it, write a v2 envelope.
  - Else → write v1 plaintext (current behavior).
  - Enforce mode 0600 in both branches (unchanged).

### `src/cli.js` (modify)

- Route `loadAgentKeys` (`cli.js:342`) through `readKeysFile` (covers its ~7
  callers).
- Replace the three raw `fs.writeFileSync(...keys.json...)` + `chmodSync` sites
  (`cli.js:1269`, `1370`, `1460`) with `writeKeysFile` — so no path writes
  plaintext behind the funnel's back.
- Add unlock step to `start` (see Lifecycle).
- New commands: `encrypt-keys`, `decrypt-keys`, `change-passphrase`.

### `src/dashboard.js` (modify)

- Route the three read sites (`dashboard.js:63`, `269`, `1942`) through
  `readKeysFile`.
- Interactive operations that need the WIF prompt for a passphrase (via
  `keystore.unlock`) if the pool is encrypted and not yet unlocked.

---

## Unlock lifecycle (`j41-dispatcher start`)

1. Scan agents. If any `keys.json` is v2, the pool needs unlocking.
2. Resolve passphrase in priority order:
   1. `$CREDENTIALS_DIRECTORY/j41-keys-passphrase` (systemd credential file),
   2. `J41_KEYS_PASSPHRASE` env var,
   3. interactive hidden TTY prompt.
   If v2 and none available (no TTY, no source) → **fail closed** with a clear
   message naming the three options.
3. `keystore.unlock(passphrase)` → master key in RAM.
4. Wrong passphrase = GCM tag failure → clear "incorrect passphrase" error, exit
   non-zero.

**Lifetime:** once unlocked, the master key stays in RAM for the daemon's life —
**no mid-run re-lock timeout**. A signing daemon must sign any job at any moment; a
timeout would break signing without adding security (the key must be resident to
sign at all). Matches verusd's unlocked-wallet posture. Cleared on process exit
(best-effort `lock()` on shutdown signals).

**Unattended honesty:** sources (1) and (2) mean the passphrase is readable by the
same machine, so they defend stolen-disk only, not live compromise. Documented as
such at the point of use and in the disclosure doc.

---

## Commands & migration

- **`encrypt-keys`** — opt-in migration. Refuses if `master-key.json` already
  exists. Prompts for a new passphrase (entered twice, confirmed), generates +
  wraps a master key → `master-key.json` (0600), then rewrites every agent
  `keys.json` v1→v2. Idempotent guard: skips agents already v2.
- **`decrypt-keys`** — opt-out. Unlock, rewrite all v2→v1, then remove
  `master-key.json`. Prints a plaintext-at-rest warning.
- **`change-passphrase`** — unlock with the current passphrase, derive a new KEK
  from a new passphrase, re-wrap the **same** master key → new `master-key.json`.
  Agent `keys.json` files are untouched (cheap; the master key does not change).

---

## Error handling (fail-closed invariants)

- A v2 read while locked throws — never returns an object without `wif`, never
  falls back to plaintext.
- GCM tag mismatch (wrong passphrase or tampered ciphertext) throws — never
  returns garbage or a partial key.
- `encrypt-keys` refuses to run twice; `decrypt-keys`/`change-passphrase` refuse if
  no `master-key.json`.
- `start` on an encrypted pool with no passphrase source and no TTY exits non-zero
  with instructions — it does not start unlocked-but-unusable.

---

## Testing

- `keystore.js` units: encrypt→decrypt round-trip; wrong-passphrase rejection
  (tag failure); tampered-ciphertext rejection; `deriveKek` determinism for fixed
  salt; `wrapMasterKey`/`unwrapMasterKey` round-trip; `lock()` zeroization.
- Funnel units: v1 passthrough unchanged; v2 decrypt-when-unlocked; v2 throws when
  locked; `writeKeysFile` writes v1 when no master key, v2 when unlocked.
- Migration test: v1 → `encrypt-keys` → v2 → `decrypt-keys` → v1 preserves the WIF
  byte-for-byte.
- Public-field test: a v2 `keys.json` exposes `identity`/`iAddress`/`network` to a
  reader that has NOT unlocked (dashboard listing path).

---

## Build order (tiers → plan tasks)

1. **Tier 0** — `readKeysFile` funnel + route all reads/writes through the helpers.
   No crypto, no behavior change. Safe, independently shippable.
2. **Tier 1** — `keystore.js`, `master-key.json`, v2 envelope, `start` unlock,
   `encrypt-keys`/`decrypt-keys`/`change-passphrase`.
3. **Tier 2** — unattended passphrase sourcing (systemd-cred + env), honesty
   labels.

Tier 3 (external/HSM signer) is out of scope — tracked separately as the only
defense against live compromise.

---

## Global constraints

- No new runtime dependency (scrypt is Node built-in). Do not bump
  `@bitgo/utxo-lib` or `bs58check` — unrelated, but the encryption must not touch
  WIF encoding/decoding.
- Default off on ship; encryption is strictly opt-in via `encrypt-keys`.
- Fail-closed everywhere: no env-var kill switch that silently disables
  encryption or falls back to plaintext for a v2 file.
- Preserve mode 0600 on `keys.json` and `master-key.json` in every write path.
- No build step (CJS); validate with `node --check` and `node --test`.
