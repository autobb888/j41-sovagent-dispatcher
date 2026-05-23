# Runbook — Enable the identity-keys trust anchor (`J41_PLATFORM_SIGNER`)

**Date:** 2026-05-23
**What this does:** locks the dispatcher (and SDK) into rejecting any
`/v1/identity/:id/keys` response that isn't signed by the pinned platform key.
Closes the trust-anchor MITM described in backend report #2.
**Blast radius:** every signature-verification flow (`verifyCanonicalSignatures`,
`verifyDepositReport`) depends on this endpoint. If you pin before the backend
is signing, every verification fails. Order of operations matters.

---

## Pre-flight (must pass before pinning)

1. **Backend container is on the signing build** (junction41 commit `349c82d`
   or later) with `PLATFORM_SIGNER_ADDRESS` configured.

2. **Feature flag is active.** Check:
   ```bash
   curl -s https://<platform>/v1/version | jq -r '.flags[]' | grep identity.signed-keys-v1
   ```
   Must print `identity.signed-keys-v1`. If absent, **do not pin** — the backend
   isn't signing yet and pinning will hard-fail every verification flow.

3. **Sanity-check a real signed response.** Pick any known identity:
   ```bash
   curl -s "https://<platform>/v1/identity/<id>/keys" | jq '.data.platformSignature'
   ```
   Must be a non-null base64 string.

## Staging address
```
RBgxQwD7mMLCfciTN68RjBQHsH68vcnUKb
```
(Mainnet will differ — see the cutover section below.)

## Enabling on the dispatcher

Set in the dispatcher's runtime env (docker-compose / systemd / your secrets
store) and restart:

```bash
J41_PLATFORM_SIGNER=RBgxQwD7mMLCfciTN68RjBQHsH68vcnUKb
```

That's it. No code change. The SDK (**`@junction41/sovagent-sdk@2.3.1`+**) sees
the env at every `getIdentityKeys` call, requires `platformSignature` on the
response, recomputes the JCS-canonical payload, and verifies it as a Verus
message signature against the pinned R-address. Failures throw `J41Error` with
`code === 'KEYS_UNSIGNED'` or `'KEYS_BAD_SIGNATURE'`.

> **SDK 2.3.0 is NOT compatible with verusd `signmessage`** — its Verus
> message verifier was tautologically cross-tested against a sibling client
> that shared the same bug. Pinning on 2.3.0 would brick every
> `getIdentityKeys` call with `KEYS_BAD_SIGNATURE`. **Use 2.3.1 or later.**
> End-to-end verified live against the real staging signer
> `RBgxQwD7mMLCfciTN68RjBQHsH68vcnUKb`.

## Post-deploy verification

1. Tail dispatcher logs while a buyer deposits — you should see deposits credit normally.
2. Tail logs while an access request is minted — you should see signatures verify.
3. Search the logs for `KEYS_UNSIGNED` or `KEYS_BAD_SIGNATURE`. **Zero occurrences** is the goal:
   - A `KEYS_UNSIGNED` means the backend served an unsigned response (signing pipeline degraded — escalate to the platform team; do **not** unpin).
   - A `KEYS_BAD_SIGNATURE` means the response was signed by the wrong key, or tampered (possible MITM — investigate immediately; do not unpin).

The dispatcher returns **502** to upstream on either, so they show up as
platform faults in your monitoring, not 4xx client errors.

## Fail-safe behaviour (what we expect)

- `verifyCanonicalSignatures` (access-key minting): catch → returns `false` →
  the discovery handler rejects the access request with "Buyer signature
  verification failed". **No fallback to unverified data.**
- `verifyDepositReport` (deposit credit): catch → returns
  `{ ok:false, code:'KEYS_UNSIGNED' | 'KEYS_BAD_SIGNATURE' }` → webhook route
  returns **502**. **No deposit is credited on the unverified path.**

## Rollback

Unsetting `J41_PLATFORM_SIGNER` and restarting reverts to the
pre-pinning behaviour (the SDK skips the platform-signature check entirely;
TLS is the only integrity bound). Use only if the backend's signing is broken
and cannot be fixed quickly — the trust anchor is degraded while unpinned.

## Mainnet cutover (when the time comes)

1. Generate a fresh mainnet signing address on the mainnet `verusd`:
   ```bash
   docker exec verusd-mainnet verus getnewaddress
   ```
2. `verus dumpwallet` → secure backup; `verus encryptwallet <passphrase>` and
   script `verus walletpassphrase <passphrase> 0` on container start (otherwise
   signing silently degrades to unsigned after any restart).
3. **Update in lock-step:** the platform's `PLATFORM_SIGNER_ADDRESS` and the
   dispatcher's `J41_PLATFORM_SIGNER` must change to the new mainnet R-address
   at the same time. If they drift, every verification fails until they match.

## SDK pitfall (dev only — does not affect production)

The SDK's pin enforcement lives in `src/client/index.ts:getIdentityKeys`. If
you're testing against a **yarn-linked local SDK** (not the published npm
tarball), the local `dist/` is gitignored and won't auto-rebuild after a branch
switch — stale `dist/` could silently bypass the check. Always
`yarn build` in `j41-sdk` after source changes, or validate against the
published `@junction41/sovagent-sdk@2.3.0`. Production installs from npm via
the `prepare: tsc` hook on install, so this can't happen in deployed
environments.
