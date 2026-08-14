# Broker integration — Docker validation runbook

Pre-mainnet operational checklist for `J41_SIGNING_BROKER=1`. Code is wired
end-to-end; this is the manual proof that the in-container WIF risk is gone
under real Docker conditions and the on-chain flow still works.

Run on **testnet** first. Cutover sequence:

1. ✅ Code wired (this PR/branch — `security/file-channel-broker`).
2. **Operator validation** (this doc).
3. Flip default: change `SIGNING_BROKER_ENABLED` in `src/cli.js` to default-true.
4. Soak through one release.
5. Remove the flag + the legacy local-WIF path entirely.

---

## Pre-flight

- [ ] Dispatcher on `security/file-channel-broker` branch.
- [ ] SDK 2.4.0 installed (or yarn-linked from `j41-sdk` checkout).
- [ ] At least one agent registered on testnet with a funded R-address.
- [ ] `j41-isolated` Docker network exists.
- [ ] Job-agent image rebuilt: `j41-dispatcher build-image   # (repo checkout: ./scripts/build-image.sh)`.

## Smoke test (legacy path still works)

Confirm the default-off path hasn't regressed:

- [ ] `J41_SIGNING_BROKER` unset; run a real testnet job end-to-end.
- [ ] `docker inspect <container>` shows `/app/keys.json` mount, no
  `/app/sign` mount.
- [ ] Container logs: `[SIGNER] mode=local`.
- [ ] Job accept + deliver succeed; on-chain identity-update tx broadcasts.

## Broker path (the real test)

Enable the flag:

```bash
J41_SIGNING_BROKER=1 j41-dispatcher start
```

Run one real testnet job through the full lifecycle. After the container
launches, in another terminal:

- [ ] `docker inspect $(docker ps -lq) --format '{{json .Mounts}}' | jq`
  shows the **/app/sign** mount and **NO /app/keys.json** mount.
- [ ] `docker exec <container> ls /app` shows `sign/` but not `keys.json`.
- [ ] `docker exec <container> ls /app/sign/req /app/sign/resp` — both exist
  and are writable.
- [ ] `docker exec <container> cat /app/keys.json` → "No such file or directory"
  (defensive guard in `job-agent.js` would have refused to start otherwise).
- [ ] First line of container logs includes `[SIGNER] mode=broker`.
- [ ] Host: `ls -la /tmp/j41-sign-<jobId>/` — `req/` and `resp/` both `0700`,
  owned by dispatcher user.
- [ ] While the container is processing, briefly:
  `watch -n 0.5 'ls /tmp/j41-sign-<jobId>/req/ /tmp/j41-sign-<jobId>/resp/'`
  — entries appear + vanish within ~250ms of each sign call.

## Functional gates

Each must succeed exactly once per job:

- [ ] **Accept** — dispatcher log: `Job accepted ... signer: broker`.
  Verify on platform: job moves to `accepted` state.
- [ ] **Deliver** — log: `Job delivered ... hash: <64hex>`. Platform
  shows `delivered`.
- [ ] **Attestation** — `deletion-attestation.json` in job dir contains a
  real Verus signature (length > 80 chars). Platform endpoint returns
  `signatureVerified: true`.
- [ ] **Job-completion identity update** — log includes
  `On-chain identity updated (host-side) ... txid:<txid>`. The txid
  resolves via `verus getrawtransaction <txid>` on testnet.

## Negative tests

Prove the policy actually blocks attacks:

- [ ] **Amount-inflation attempt** — exec into a running container and:
  ```bash
  cat > /app/sign/req/$(uuidgen | tr -d -).json <<'EOF'
  {"id":"abc","method":"signBrokered","params":{"type":"accept","jobId":"<this-job-id>","amount":999999,"buyerVerusId":"attacker@"}}
  EOF
  ```
  Then `cat /app/sign/resp/abc.json` — the message returned MUST contain the
  REAL amount and buyer, not 999999 / attacker@. Verify visually.
- [ ] **Other-job attempt** — same exec, but `jobId: "some-other-job"`. The
  response must be `{"ok":false,"error":{"code":"CHANNEL_JOB_MISMATCH",...}}`.
- [ ] **Oracle attempt** — `signMessage` with a `J41-DEPOSIT-REPORT|...` body.
  Response must be `PROTOCOL_SHAPED`.

## Teardown

- [ ] Job completes; `docker ps -a` shows the container is gone (AutoRemove).
- [ ] `/tmp/j41-sign-<jobId>/` is also gone (host-side `signerHost.destroy()`).
- [ ] No stray `/tmp/j41-keys-<jobId>/` directory either (only created in
  legacy mode; should be absent here).

## Failure modes worth deliberately triggering

- [ ] **Kill the dispatcher mid-job**: SIGKILL the dispatcher process while
  the container is mid-signing. Container's next `signMessage` should time
  out with `SIGN_TIMEOUT`; container logs that error and exits. Dispatcher
  restart should not leave orphaned channel directories (audit `/tmp`).
- [ ] **Kill the container mid-job**: dispatcher should detect, call
  `stopJobContainer`, which runs `_signerHost.destroy()` — verify the
  channel dir is removed.
- [ ] **Container retries** — if Docker restarts the container, broker mode
  needs a fresh channel each time. Confirm `startJobContainer` always
  provisions a new directory (no reuse).

## Promote to default-on

After all of the above passes on testnet, gated by **one full week** of
test traffic with no broker-related errors in dispatcher logs:

1. Change `SIGNING_BROKER_ENABLED` in `src/cli.js` line ~24 to default `true`
   (allow `J41_SIGNING_BROKER=0` as the explicit opt-out).
2. Update `docs/DEPLOY-KEYS-ENDPOINT-PIN.md` to note broker is now default.
3. Bump dispatcher version, publish, push.
4. Run **one more end-to-end testnet job** with no flag set, to prove the
   new default works without any operator action.

## Remove the legacy path

After a release cycle on default-on:

1. Remove `SIGNING_BROKER_ENABLED` from `src/cli.js`; the broker branch
   becomes the only one.
2. Remove the `local` branch from `src/job-signer.js` (`createBrokerSigner`
   becomes the only constructor).
3. Remove the `keys.wif` fallback branches in `src/job-agent.js`.
4. Remove the `tmpKeysPath` / `keys.json` mount code from `startJobContainer`.
5. Bump dispatcher minor version, write a CHANGELOG note explaining the WIF
   is no longer present in job containers under any configuration.
