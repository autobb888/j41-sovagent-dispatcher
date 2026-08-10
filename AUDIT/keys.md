# keys — soft-launch audit

**Date:** 2026-08-10 · **Scope:** key custody, at-rest encryption, the signing
broker, and every other secret the dispatcher writes to disk.
**Method:** read-only static trace. No code run, no tests executed, no live calls.

The headline: the *signing* side of this domain is in good shape — the broker is
mandatory, default-deny, and the WIF genuinely never reaches the container. The
problems are all on the *custody* side, and they only appear **after an operator
runs `encrypt-keys`**. On a default plaintext install, K1 and K2 are both inert.
That is the opposite of the usual pattern: here, opting into the security feature
is what exposes you.

---

## Findings

| # | Sev | File:line | Summary |
|---|-----|-----------|---------|
| **K1** | **crit** | `src/dashboard.js:1942` → `1970,1991,2002,2032` | Dashboard "Retry Registration" **irrecoverably destroys an encrypted agent's WIF** |
| **K2** | **high** | `src/cli.js:1351-1391` | `init` skips the unlock guard, so new agents' WIFs are written **plaintext** onto an encrypted pool |
| **K3** | **med** | `src/sign-channel-host.js:122-127` | Predictable `/tmp/j41-sign-<jobId>`; a pre-existing dir is reused and the `chmod` failure is swallowed → local signing oracle |
| **K4** | **med** | `src/sign-channel-host.js:182,202,368,377` | `O_NOFOLLOW` guards the request file but not `req/`/`resp/`; the container can symlink them and steer host writes/deletes |
| **K5** | **low** | `src/keystore.js:146` vs `README.md:435-438` | Documented passphrase precedence is backwards — the systemd credential wins, not the env var |
| **K6** | **low** | `src/keys-file.js:40-42` | `allowLocked: true` is a no-op on plaintext files — "display-only" callers hold the WIF anyway |
| **K7** | **low** | `src/cli.js:9467` | `viewAgentProfile` reads without the secret then passes `keys.wif` — silently broken once `encrypt-keys` has run |
| **K8** | **low** | `src/api-key-manager.js:31-32` | `api-keys.json` created at umask mode then chmodded, and it is not in the 0600 repair sweep |
| **K9** | **low** | `src/api-key-manager.js:74` | Bearer API keys compared with `===` from unauthenticated network input; cache-miss path re-scans every agent from disk |

---

### K1 — crit — Dashboard "Retry Registration" destroys an encrypted agent's WIF

**File:** `src/dashboard.js:1942`, writes at `:1970`, `:1991`, `:2002`, `:2032`.

**The code path.**

1. `readKeysFile(keysPath, { allowLocked: true })` — `keys-file.js:44` destructures
   `const { v, encrypted, ...pub } = raw` and `:50`/`:55` return **`pub`**. For a
   v2 file that object has neither `wif` **nor** the `encrypted` envelope, and no
   `v` marker. Note `:55` returns `pub` *even when the keystore is unlocked*, so a
   passphrase in the environment does not save you.
2. `writeKeysFile(keysPath, keysData)` — `keys-file.js:20` tests
   `keystore.isUnlocked() && obj.wif !== undefined`. `obj.wif` is `undefined`, so
   the encryption branch is skipped and `toWrite = obj`.
3. `keys-file.js:37` `fs.renameSync(tmp, p)` — atomically replaces `keys.json`
   with a plaintext v1 file containing only the public fields.

The ciphertext is gone. There is no backup, no `.bak`, no second copy. The master
key still decrypts nothing, because the envelope it protected no longer exists.

**Trigger.** Operator has run `encrypt-keys`. Dashboard → `[1] View Agents` → pick
any agent where `!keys.identity || !keys.iAddress` (`dashboard.js:288` — i.e. any
agent created but not yet registered on-chain) → the `── Fix ──` entry
"Retry Registration (on-chain identity)" (`dashboard.js:328-330`) → **any** of the
three actions. `recover` writes at `:1970`, `clean_register` at `:1991` and
`:2002`, `register` at `:2032`. All three destroy it; there is no path through
`retryRegisterScreen` that doesn't write.

**Consequence.** The agent's R-address is still displayed, so an operator who
funded it for registration sees a balance they can no longer spend. The VerusID
(if it was mid-registration) is unrecoverable. `wallet send`/`sweep` will fail for
that agent forever.

**Why it hasn't bitten yet.** On a plaintext (v1) install `readKeysFile` returns at
`keys-file.js:42` *before* the `allowLocked` branch, so the full object including
`wif` comes back and is written straight back out. That is K6 — and it is the only
reason this is latent rather than a live outage.

**Proposed fix (not applied).** Two independent guards, both worth having:
- In `dashboard.js:1942`, drop `{ allowLocked: true }` — this screen writes, so it
  must hold the secret. It will then fail closed with `ELOCKED` if the pool cannot
  be unlocked, which is the correct outcome.
- In `keys-file.js:18`, make `writeKeysFile` refuse to clobber: `lstat`/read the
  target first, and if the existing file is `v === 2` while `obj` carries neither
  `wif` nor `encrypted`, throw rather than write. A function that can silently
  delete a private key should not be reachable by omission.

---

### K2 — high — `init` writes new WIFs in plaintext onto an encrypted pool

**File:** `src/cli.js:1351-1408`, write at `:1391`.

**The code path.** The `init` action never calls
`ensureKeystoreUnlockedIfEncrypted()`. Nothing else in that action reads a keys
file either, so `keystore.lazyUnlockSync()` (`keys-file.js:48`, reached only from
the secret-needed *read* path) never runs. `keystore.isUnlocked()` is therefore
`false` at `:1391`, and `writeKeysFile` takes the plaintext branch.

**Trigger.** `j41-dispatcher encrypt-keys`, then later `j41-dispatcher init -n 12`
to grow the pool. The new agents' WIFs land on disk in the clear. The command
prints `✅ 12 agents initialized` and says nothing about encryption.

**Why this is a gap and not a decision.** `test/cli-encryption-guard.test.js:10-12`
names its deliberate exclusions — `start` (has its own unlock block) and `privacy`
(read-only). `init` is in neither category, and the sibling `setup` command does
call the guard, at `cli.js:2750`, immediately before its identical
`generateKeypair` → `writeKeysFile` pair at `:2811-2816`. `createNewAgent` in the
interactive shell does the same at `cli.js:9601-9605`. `init` is the one that was
missed.

**Consequence.** The operator believes the pool is encrypted; `encrypt-keys` will
refuse to re-run only if there are zero stragglers, so re-running it *would*
repair this (`cli.js:4421-4450`) — but nothing prompts them to. A stolen backup
leaks exactly the newest agents.

**Proposed fix (not applied).** Add `await ensureKeystoreUnlockedIfEncrypted();`
as the first statement of the `init` action, matching `cli.js:2750`. Add `init` to
the `COMMANDS` list in `test/cli-encryption-guard.test.js`.

---

### K3 — med — Predictable channel path in `/tmp`, reused if it already exists

**File:** `src/sign-channel-host.js:122-127`; path built at `src/cli.js:8291`.

**The code path.** `signerChannelDir = path.join(os.tmpdir(), 'j41-sign-' + job.id)`
— fully predictable given the job id, which the buyer knows the moment they create
the job. `start()` then does `mkdir(..., { recursive: true, mode: 0o700 })`, which
**applies the mode only to directories it creates**, followed by
`try { chmod(0o700) } catch { /* not our dir */ }`. The comment is accurate about
the hazard and the `catch` is the bug: when the directory belongs to someone else
the `chmod` raises `EPERM`, it is swallowed, and the host proceeds to use it.

**Trigger.** An unprivileged local account on the dispatcher host (`/tmp` is
sticky-but-world-writable) pre-creates `/tmp/j41-sign-<jobId>` mode 0777 before the
dispatcher picks the job up. `mkdir` sees `EEXIST` and succeeds; `chmod` fails
silently; `req/` and `resp/` are then created *inside the attacker's directory*.

**Consequence.** The attacker can read `resp/` (every signature the agent produces
for that job) and write into `req/`. The `signMessage` path (`sign-channel-host.js:288-296`)
will sign any ≤4 KB non-protocol-shaped string with the agent's WIF — which is
exactly the shape of a platform auth challenge (`sign-broker.js:132-138` lists it
first). That is enough to authenticate to the platform as the agent. The brokered
path stays safe (job-pinned, amount from the authoritative record), so this is an
impersonation/oracle issue, not a direct fund-drain.

**Proposed fix (not applied).** Do not create recursively and do not swallow. Create
the leaf with `fs.mkdirSync(dir, { mode: 0o700 })`; on `EEXIST`, `lstat` it and
refuse to start the channel unless it is a real directory (not a symlink) with
`uid === process.getuid()` and `(mode & 0o777) === 0o700`. A channel that cannot be
established safely should fail the job, not run degraded. Adding a random suffix to
the directory name (`j41-sign-<jobId>-<8 random hex>`) removes the predictability
as a second layer.

---

### K4 — med — `O_NOFOLLOW` covers the request file but not the channel directories

**File:** `src/sign-channel-host.js:182` (`readdir`), `:202` (path join), `:368`
(`_writeResponse`), `:377` (`_removeReq`).

**The code path.** The container is bind-mounted `/tmp/j41-sign-<id>` → `/app/sign`
**rw** (`cli.js:8351`) and runs as the host uid (`cli.js:8414`), so it owns the
channel root and both subdirectories outright. `ReadonlyRootfs` and `CapDrop: ALL`
do not restrict it there. Nothing on the host side re-checks that `this.reqDir` and
`this.respDir` are still the directories it created:

- `_drainOnce` `readdir`s `this.reqDir` — follows a directory symlink.
- `_tryProcess` opens `path.join(this.reqDir, filename)` with `O_NOFOLLOW`, which
  rejects a symlinked *leaf* but happily traverses a symlinked *parent*.
- `_removeReq` `unlink`s through the same resolved path.
- `_writeResponse` writes `path.join(this.respDir, id + '.json')`.

**Trigger.** A compromised container (RCE, not mere prompt injection — the job-agent's
own code paths don't do this) runs
`rm -rf /app/sign/resp && ln -s /home/op/.j41/dispatcher/queue /app/sign/resp`,
then issues any sign request with `id` matching `/^[a-f0-9-]{1,80}$/i`
(`sign-channel-host.js:269`).

**Consequence.** A host-side file-create primitive outside the channel: attacker-chosen
directory, filename constrained to `[a-f0-9-]{1,80}.json`, content a JSON broker
response. The symmetric `req/` redirect gives a matching delete primitive over files
whose names match `REQ_FILENAME_RE`. Neither reaches `keys.json` or `master-key.json`
(their names fall outside the character class), which is what keeps this at med
rather than high — but it is an unintended write/delete out of a sandbox that is
otherwise carefully closed.

**Proposed fix (not applied).** Open the channel root once at `start()` and hold the
fd, then use `openat`-relative operations (`fs.opendirSync` + `dirfd`) for every
subsequent access; or, minimally, `lstat` `req/` and `resp/` at the top of
`_drainOnce` and `_writeResponse` and refuse (stop the channel, fail the job) if
either is not a directory owned by us. Alternatively bind-mount `req/` and `resp/`
into the container as two separate mounts and leave the channel root outside the
container's reach — the container never needs write access to the parent.

---

### K5 — low — Documented passphrase precedence is backwards

**File:** `src/keystore.js:145-147` vs `README.md:435-438`.

`resolvePassphraseSync` returns `_credPassphrase(env) || env.J41_KEYS_PASSPHRASE`
— the systemd credential is consulted **first**. The README lists them as
"checked in order: 1. Env var … 2. systemd credential".

**Trigger.** An operator running under systemd with `LoadCredential=` set, who sets
`J41_KEYS_PASSPHRASE` in the unit to override it during a passphrase rotation. The
override is ignored and unlock fails with `EBADPASS`, pointing at the wrong cause.

**Proposed fix (not applied).** The code's order is arguably the better one (a
file-based credential is harder to leak than an env var). Correct the README rather
than the code, and say why the credential wins.

---

### K6 — low — `allowLocked: true` does not strip the WIF from plaintext files

**File:** `src/keys-file.js:40-42`.

`if (raw.v !== 2) return raw;` returns **before** the `allowLocked` handling, so on
the default plaintext install every "public fields only" caller gets the full
object including `wif`. `test/keys-file-read.test.js:22` asserts this
(`deepStrictEqual(readKeysFile(p, { allowLocked: true }), obj)`), so it is current
intended behaviour — but it contradicts the comment at `keys-file.js:55`
("never expose wif") and the mental model every call site was written against
(`dashboard.js:63, 269, 1942`; `cli.js:7915, 9389, 9467`).

**Consequence.** No direct leak — it stays in-process. It matters because it is the
reason K1 is latent on plaintext installs and fires on encrypted ones, i.e. the
option's behaviour flips exactly where it matters most.

**Proposed fix (not applied).** Strip `wif` on the v1 path too when `allowLocked` is
set, so the flag means one thing on both file versions. Update
`test/keys-file-read.test.js` to assert the strip. Doing this **first** would turn
K1 into an immediate, visible failure on every install rather than a silent one on
encrypted installs — which is why K1's fix should not depend on it.

---

### K7 — low — `viewAgentProfile` reads without the secret, then uses it

**File:** `src/cli.js:9467` then `:9478`.

`readKeysFile(keysPath, { allowLocked: true })` followed by
`new J41Agent({ ..., wif: keys.wif, ... })`. On an encrypted pool `keys.wif` is
`undefined` and `a.login()` fails; the surrounding `catch` at `:9508` prints
`Error: …`. Works today only because of K6.

**Trigger.** Run `encrypt-keys`, then use the interactive shell's "View Profile".

**Proposed fix (not applied).** Drop `{ allowLocked: true }` at `:9467`. It is the
same mistake as K1 in a read-only screen, where the cost is a confusing error rather
than key loss.

---

### K8 — low — `api-keys.json` mode window, and it is not in the repair sweep

**File:** `src/api-key-manager.js:28-32`.

`fs.writeFileSync(p, ...)` with no `mode`, then `fs.chmodSync(p, 0o600)`. At first
creation the file exists at `0666 & ~umask` (typically 0644) between the two calls,
holding live `sk-…` bearer secrets. If the process dies in that window — or if the
file was ever created by an older build — the mode is never repaired, because the
idempotent 0600 sweep at `cli.js:405` lists `keys.json`, `agent-config.json`,
`finalize-state.json`, `vdxf-update.json`, `vdxf-update.cmd` and **not**
`api-keys.json`.

**Proposed fix (not applied).** `fs.writeFileSync(p, data, { mode: 0o600 })`, and add
`api-keys.json` to the `cli.js:405` list. (`wallet-pending.json` is also absent from
that list; it holds no secret, so it is noted here rather than filed.)

---

### K9 — low — Non-constant-time API-key compare on an unauthenticated path

**File:** `src/api-key-manager.js:74` (and `:91`, `:129`).

`data.keys.find(k => k.key === key)` reached from
`proxy-handler.js:246` → `findKeyOwner(key)`, whose input is a raw
`Authorization: Bearer` header from an unauthenticated remote caller
(`proxy-handler.js:237-243`). The comparison is a plain `===` over the full
`sk-<6hex>-<64hex>` secret.

Two issues, both small: the compare is not constant-time (exploiting it over a
network against a V8 string compare is impractical but the primitive is free to fix
— `control-api.js:69-75` already does it correctly for the control token); and the
cache-miss path at `:97-105` does `readdirSync(AGENTS_DIR)` plus a
`readFileSync` + `JSON.parse` **per agent, per request**, so a remote attacker
sending garbage keys forces O(agents) disk reads each time, with no negative cache.

**Proposed fix (not applied).** Compare with `crypto.timingSafeEqual` over
fixed-length buffers after a length check; add a short-TTL negative cache for
unknown keys so a bad key costs one lookup rather than a full pool scan.

---

## Adversarial pass: shortest path from untrusted input to a bad outcome

**1. Buyer message / job description / LLM output → the WIF.** *No path.* The
executor never holds a key. In the only supported runtime the container has no
`keys.json` mounted (`cli.js:8356-8362`), no WIF in its env (`cli.js:7940-7963`),
and `job-agent.js:468-474` refuses to boot if a keys file appears anyway. Every
signature must go through `SignChannelClient`, and the six reachable signing calls
are fixed code paths in `job-agent.js` — an injected instruction cannot invent a
seventh. The brokered path rebuilds the message from a freshly-fetched authoritative
job (`sign-channel-host.js:327-359`), so the worst an injected agent achieves is a
correctly-formed `accept`/`deliver`/`dispute_respond` for its own job at the real
amount.

**2. Full container compromise (RCE) → signing oracle.** Reachable, bounded, and
already documented as residual risk at `sign-broker.js:30-35`: `signMessage` will
sign any ≤4 KB string that isn't `J41-<ACTION>|…`-shaped. That covers platform auth
challenges. The 4 KB cap and `assertNotProtocolMessage` are the only limits — by
design. **K4** widens this same compromise into a host filesystem write/delete
primitive, which is the part that isn't by design.

**3. Local unprivileged user → signing oracle.** **K3**. Pre-create
`/tmp/j41-sign-<jobId>` and inherit the channel. Needs local shell plus advance
knowledge of the job id; the buyer has the latter by construction.

**4. Platform API response → a signature over attacker-chosen values.** The broker's
root of trust for amount/buyer/jobHash is `getJob()` against the platform
(`cli.js:8308-8326`). A hostile platform can therefore change what an `accept`
commits to. This is the platform-trust boundary, not the key boundary, and the SDK
refuses to run on mainnet without `J41_PLATFORM_SIGNER` (`mainnet-guard.js:6-11`).
Out of scope here; noted so it isn't mistaken for coverage.

**5. Operator UI action → permanent key loss.** **K1**. Not untrusted input, but the
highest-impact reachable outcome in this domain, and it needs no attacker at all.

---

## Checked and found clean

- **Crypto primitives** — AES-256-GCM with a random 12-byte IV per envelope and an
  authenticated tag that is verified on decrypt (`keystore.js:35-58`); scrypt at
  N=131072, r=8, p=1 with an explicit 256 MB `maxmem` so it doesn't silently throw
  (`keystore.js:20-28`); 16-byte random salt per master doc; the master key is a
  fresh 32 random bytes, never derived from the passphrase.
- **Atomic writes** — `keys.json` and `master-key.json` both use
  open(0600) → write → `fsync` → `chmod` → `rename`. No torn file can survive a
  crash, and the tmp file is never world-readable (`keys-file.js:28-37`,
  `keystore.js:82-94`).
- **Fail-closed unlock** — wrong passphrase → GCM tag failure → `EBADPASS`
  (`keystore.js:109-115`); `lazyUnlockSync` rethrows rather than continuing locked
  (`keystore.js:201-207`); a `^D` at the prompt yields `null` → `scryptSync` throws
  → caught → `exit 1` (`cli.js:3150-3154`).
- **`encrypt-keys` resumability** — an interrupted run is detected and finished
  rather than refused (`cli.js:4416-4450`), and one unreadable file no longer
  aborts the pool loop (`keys-migrate.js:26-36`). `decryptAllKeys` decrypts
  everything into memory *before* locking and writing, so a mid-loop failure leaves
  `master-key.json` in place (`keys-migrate.js:49-59`).
- **Broker default-deny** — unknown method, unknown executor kind, unknown brokered
  type, prototype-inherited executor names, oversized request, oversized generic
  message, malformed JSON, `req.id` traversal: every one returns `ok:false`, and
  `sign-channel-client.js:169-176` turns that into a throw so the container blocks.
- **`jobCompletionUpdate`** — the one registered executor. Container-supplied
  `jobRecord` is a soft pre-check only; the on-chain record comes from a
  cryptographically verified platform witness, cross-checked against the
  authoritative job, with an 8 KB cap and a jobId binding on the container-authored
  review/attestation fields (`broker-executors.js:55-68, 138-252`).
- **Mainnet stickiness** — `J41_NETWORK` cannot downgrade a mainnet config file to
  dodge the gate (`mainnet-guard.js:63-65`), and `--dev-unsafe` — the only mode in
  which a job process holds a WIF — is on the refusal list.
- **No WIF in observable surfaces** — `control.js`, `control-api.js`, `logger.js`,
  `job-log.js`, `webhook-server.js` and `proxy-handler.js` contain no `wif`
  reference. The sign-channel log sink prints codes and filenames only.
- **Control token** — 32 random bytes, 0600, `timingSafeEqual` with a
  length-mismatch guard that still performs a compare (`control-api.js:46-75`).
- **Provider API keys** — sourced from `cfg.provider_keys`, never from the
  dispatcher's `process.env`; the local-runtime child env is an explicit whitelist
  with no spread (`cli.js:8749-8757`).
- **Permission repair sweep** — agent dirs forced to 0700 and the five listed
  sensitive files to 0600 on every CLI invocation (`cli.js:395-416`).
- **Path safety** — `agentId` validated against traversal at `cli.js:421-423` and
  `:454-456`; `job.id` validated by `isValidJobId` at `cli.js:8232` and `:8716`,
  both *before* the `/tmp/j41-sign-<jobId>` join, so the channel path cannot be
  steered by a hostile platform response.
- **Channel teardown** — `destroy()` (stop watcher, clear timer, `rm -rf` the
  channel) runs on both the start-path failure (`cli.js:8576`) and normal teardown
  (`cli.js:8648-8651`).

---

## Not covered in this pass, and why

- **The SDK's own key handling** — `keypairFromWIF`, `signMessage`,
  `buildIdentityUpdateTx`, `assertNotProtocolMessage`. `src/keygen.js` is a 25-line
  passthrough; the entropy source, WIF encoding and signature construction all live
  in `@junction41/sovagent-sdk`, outside this repo. Auditing them means auditing the
  SDK.
- **Whether `encrypt-keys` is *reachable* from the dashboard's Security menu.**
  `dashboard.js:2105` offers it, but the handler for the `encrypt-keys` value was
  not traced (only `change-passphrase` at `:2116-2117` was). `dashboard.js` cannot
  be imported under `node --test`, and the audit is read-only. Low stakes either
  way — the CLI command is the documented entry point.
- **Container escape below the key layer** — gVisor/seccomp/AppArmor/bwrap posture,
  the egress proxy, SovGuard, canary tokens. K4 assumes a compromised container and
  asks only what it can do *to the signing channel*; whether it can get there is the
  isolation domain.
- **Platform-side trust.** The broker's authoritative source is `getJob()` against
  `api.junction41.io`. What the platform does with what we send, and whether its
  witness signatures are what they claim, needs a backend-side check.
- **Runtime verification of any finding.** Read-only pass per the audit rules. K1
  in particular is traced statically through three files; it destroys a private key
  if reproduced, so any reproduction should be done against a throwaway
  `~/.j41/dispatcher` with a copied-aside `keys.json`.
