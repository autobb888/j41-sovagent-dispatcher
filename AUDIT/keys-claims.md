# keys — claims checklist

Every claim the README or CLAUDE.md makes that an operator would act on, in the
key-custody / signing-authority domain. Sources: `README.md` lines 44, 184-186,
381-385, 435-442, 681, 737-750; `CLAUDE.md` (Data Directories, File Map,
Key Patterns); the module headers of `keystore.js`, `keys-file.js`,
`sign-broker.js`, `sign-channel-host.js`, `job-signer.js`, `broker-executors.js`.

Status: **VERIFIED** (code does what's claimed) / **DRIFT** (code differs — how)
/ **MISSING** (no implementation) / **UNVERIFIED** (couldn't determine).

---

## A. Key-at-rest encryption (14)

| # | Claim | Status | Evidence |
|---|---|---|---|
| A1 | `encrypt-keys` encrypts all agent WIFs at rest with a passphrase; opt-in | VERIFIED | `cli.js:4412-4471` → `keys-migrate.js:20-47` |
| A2 | `decrypt-keys` removes at-rest encryption; WIFs plaintext again | VERIFIED | `cli.js:4473-4484` → `keys-migrate.js:49-59` (decrypts into memory, `lock()`s, then writes) |
| A3 | `change-passphrase` changes the at-rest passphrase | VERIFIED | `cli.js:4486-4502` → `keystore.js:119-134` (re-wraps the same master key under a new salt+KEK) |
| A4 | Encryption is AES-GCM under a passphrase-derived master key | VERIFIED | `keystore.js:35-58` AES-256-GCM; `keystore.js:20,27-29` scrypt N=131072,r=8,p=1 KEK wrapping a random 32-byte master key |
| A5 | At-rest encryption is **opt-in**; the default install is plaintext at 0600 | VERIFIED | `keys-file.js:20` encrypts only when the keystore is unlocked, which requires `master-key.json` to exist |
| A6 | Passphrase sources "checked in order": 1. env `J41_KEYS_PASSPHRASE`, 2. systemd credential `j41-keys-passphrase` | **DRIFT** | `keystore.js:146` — `_credPassphrase(env) \|\| env.J41_KEYS_PASSPHRASE`. The **credential wins**, the README says the env var does. → finding **K5** |
| A7 | `start` and any key-dependent command prompt interactively when encryption is on | **DRIFT** | VERIFIED for `start` (`cli.js:3142-3155`) and for the 15 commands asserted in `test/cli-encryption-guard.test.js`; **`init` has no guard** (`cli.js:1351-1408`) → finding **K2** |
| A8 | Protects a stolen disk/backup; does NOT protect a live-compromised host | VERIFIED | Honest. Master key is process-resident after unlock (`keystore.js:61`), same caveat stated at `keystore.js:11-13`; zeroized on exit at `cli.js:4406` |
| A9 | `master-key.json` and `keys.json` written 0600, atomically | VERIFIED | `keystore.js:82-94` and `keys-file.js:28-37` — both open the tmp file with mode 0600, `fsync`, `chmod`, then `rename` |
| A10 | Agent dirs 0700 and `keys.json` 0600, repaired on every CLI invocation | VERIFIED | `cli.js:395-416` idempotent sweep |
| A11 | `encrypt-keys` is resumable after an interrupted run | VERIFIED | `cli.js:4416-4450` + `keys-migrate.js:70-79` (`listPlaintextKeys`); an unreadable file no longer aborts the loop (`keys-migrate.js:26-36`) |
| A12 | Setting a NEW passphrase refuses a non-TTY and says the keys are still plaintext | VERIFIED | `cli.js:4455-4459` |
| A13 | A wrong passphrase fails closed | VERIFIED | `keystore.js:109-115` — GCM tag failure → `EBADPASS`; `lazyUnlockSync` (`keystore.js:201-207`) rethrows rather than proceeding locked |
| A14 | `promptHidden` resolves `null` rather than hanging on a closed stdin / pipe / non-TTY | VERIFIED | `keystore.js:172-191` — both the `isTTY` early return and the `'close'` handler are present |

## B. The WIF never enters the job container (8)

| # | Claim | Status | Evidence |
|---|---|---|---|
| B1 | Broker signing is a default-on security default; no env var needed | VERIFIED | `cli.js:90` — `SIGNING_BROKER_ENABLED = process.env.J41_SIGNING_BROKER !== '0'` |
| B2 | Broker signing is mandatory on **every** network; a job refuses to launch without it | VERIFIED | `cli.js:8283-8288` throws before any container is created |
| B3 | Mainnet gate refuses `J41_SIGNING_BROKER=0` | VERIFIED | `mainnet-guard.js:26`, invoked at `cli.js:3123-3140` with sticky mainnet resolution (`mainnet-guard.js:63-65`) |
| B4 | `keys.json` is never bind-mounted into the container | VERIFIED | `cli.js:8356-8362` — Binds are exactly `jobDir`, the sign channel, and `SOUL.md:ro` |
| B5 | The WIF is never in the container environment | VERIFIED | `buildContainerEnv` (`cli.js:7927-8016`) never reads `keys.wif`; `J41_KEYS_FILE` is a *host* path and is stripped from `Env` at `cli.js:8418-8421` |
| B6 | job-agent refuses to start if broker mode is on and `/app/keys.json` exists | VERIFIED | `job-agent.js:468-474` |
| B7 | The WIF lives only in the `SignChannelHost` closure; never logged, never written to a file | VERIFIED | `sign-channel-host.js:100`; no `wif` appears in `control.js`, `control-api.js`, `logger.js`, `job-log.js` |
| B8 | `--dev-unsafe` local mode is the only path where a job process holds the WIF, and it is blocked without the flag and on mainnet | VERIFIED | `cli.js:8717-8731` (hard block), `mainnet-guard.js:27` (mainnet refusal), `cli.js:3492-3495` (docker-missing fallback also gated) |

## C. Broker policy — what a compromised container can obtain (14)

| # | Claim | Status | Evidence |
|---|---|---|---|
| C1 | It cannot inflate the amount — `Amt` comes from the authoritative job | VERIFIED | `sign-broker.js:69-75` — every field of `buildAcceptMessage` is read off `job`, none off `request` |
| C2 | It cannot sign for a different job | VERIFIED | `sign-broker.js:59-61` **and** the channel-level pin at `sign-channel-host.js:339-344` |
| C3 | It cannot get an arbitrary `J41-<ACTION>\|…` string signed via the generic path | VERIFIED | `sign-broker.js:161-164` → SDK `assertNotProtocolMessage` (NFKC + zero-width strip) |
| C4 | Identity updates and payments are not broker types (default-deny) | VERIFIED | `sign-broker.js:97-102` — `default:` throws `UNSUPPORTED_TYPE` |
| C5 | Generic signing is capped at 4096 bytes — no bulk oracle | VERIFIED | `sign-broker.js:35, 149-156` (UTF-8 byte length, not `.length`) |
| C6 | `executeOnChain` is default-deny; only explicitly registered executor names | VERIFIED | `sign-channel-host.js:298-312` — `Object.prototype.hasOwnProperty.call`, so `constructor`/`toString` cannot resolve |
| C7 | Only `jobCompletionUpdate` is registered | VERIFIED | `broker-executors.js:262-266` |
| C8 | The on-chain job record comes from the platform witness, not the container | VERIFIED | `broker-executors.js:181-222` — witness verified, cross-checked against `getJob`, container `jobRecord` used only as a soft pre-check; `decideWitnessWrite` fails closed on mainnet |
| C9 | Any unexpected error returns `ok:false` so the container blocks rather than silently succeeding | VERIFIED | `sign-channel-host.js:319-324, 362`; client raises on `ok:false` (`sign-channel-client.js:169-176`) |
| C10 | Per-request file size bounded before the read | VERIFIED | `sign-channel-host.js:211-240` — `fstat` on the fd, then a bounded positional read (closes the post-stat-append hole too) |
| C11 | Symlinked request files are refused (`O_NOFOLLOW`) | **DRIFT** | Holds for the request **file** (`sign-channel-host.js:214`). The `req/` and `resp/` **directories** are not checked, and the container has rw access to the channel root at the same uid → finding **K4** |
| C12 | `req.id` is validated before being used as the response filename (no traversal) | VERIFIED | `sign-channel-host.js:261-269` — falls back to the filename on any non-matching id |
| C13 | Channel directories are mode 0700 | **DRIFT** | Created 0700 (`sign-channel-host.js:122-127`), but a **pre-existing** dir is reused and the `chmod` failure is swallowed → finding **K3** |
| C14 | The channel is destroyed on container teardown | VERIFIED | `cli.js:8576` (start-path failure) and `cli.js:8648-8651` (normal teardown) → `sign-channel-host.js:168-175` |

## D. Other secret material (7)

| # | Claim | Status | Evidence |
|---|---|---|---|
| D1 | `control.token` is 32 random bytes, mode 0600, auto-created | VERIFIED | `control-api.js:46-58` |
| D2 | The control token is compared in constant time | VERIFIED | `control-api.js:69-75` — `crypto.timingSafeEqual` with a length-mismatch guard that still burns a compare |
| D3 | Provider API keys live in `config.toml` (0600) and are NEVER read from the dispatcher's `process.env` | VERIFIED | `cli.js:7934-7938` sources from `cfg.provider_keys` / `cfg.llm`; the local-runtime env is an explicit whitelist with no `...process.env` spread (`cli.js:8749-8757`) |
| D4 | `agent-config.json` is written 0600 (it holds API keys) | VERIFIED | `dashboard.js:1699` (mode at creation), `cli.js:3052-3053` (chmod), and it is in the repair sweep at `cli.js:405` |
| D5 | `api-keys.json` is 0600 | **DRIFT** | `api-key-manager.js:31-32` writes first and chmods after, and the file is **not** in the `cli.js:405` repair sweep → finding **K8** |
| D6 | The per-job canary token file is 0600 | VERIFIED | `cli.js:8263` |
| D7 | Job ids are validated before being used in filesystem paths | VERIFIED | `job-id.js:2`; enforced at `cli.js:8232` (docker) and `cli.js:8716` (local), both before the `/tmp/j41-sign-<jobId>` join |

---

**Totals: 43 claims — 37 VERIFIED · 6 DRIFT (A6, A7, C11, C13, D5, and the
`allowLocked` contract noted under K6) · 0 MISSING · 0 UNVERIFIED.**
