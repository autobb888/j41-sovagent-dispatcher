# gpu-jail / Cat-1 compute SSH — audit report (re-pass)

**Date:** 2026-09-15 · **HEAD:** `5ca8776` (`5ca8776 Merge branch 'execute-plan/7000b96c-pr-12-g3-umount-fail-loud-g5-rebuild-jail' into execute-plan/ca3106a1-integrate`) · **Scope:** Cat-1 home-gpu jail + J41 compute-edge. Read-only; no src edits, no tests run, no commits, no banner-probe of `127.0.0.1:2222`, no dispatcher start. Live image `j41/gpu-jail:latest` inspected read-only.

**Counts (open):** crit 0 · high 0 · med 1 · low 2 · **total 3**

Claims: `AUDIT/gpu-jail-claims.md` — 24 VERIFIED · 2 VERIFIED-qualified (A6, A28) · 2 DRIFT (A25, A31) · 1 MISSING (A30) · 3 UNVERIFIED backend (A12–A14).

Prior pass 2026-09-14 is superseded. Isolation still holds in code: no root, no docker.sock, no nsenter, no host binds. Remaining open issues are a false-closed NVIDIA-runtime gate, one leftover PASTE-RECIPE comment, and compute-edge not re-dialed after dispatcher restart.

Live image `j41/gpu-jail:latest` `sha256:25daff26…` created `2026-09-14T23:13:42Z`: `LoginGraceTime 60`, init umount fail-loud (no `|| true`), `renter:*` uid 1000, `PermitRootLogin no`. Matches Dockerfile + `docker/gpu-jail-init.sh` on this HEAD.

---

## Prior findings status

| ID | 2026-09-14 | 2026-09-15 | Notes |
|---|---|---|---|
| G1 | med OPEN | **FIXED** | README Friend boot, CLAUDE.md Cat-1, dashboard `computeProviderScreen`, `test/friend-boot-docs.test.js` all say named TCP is not the product; buyer SSH is `renter@sovcompute.junction41.io` |
| G2 | med OPEN | **FIXED** | `ensureJailNetwork` throws `HOME_GPU_NO_NET`, never returns `'bridge'` |
| G3 | med OPEN | **FIXED** | `gpu-jail-init` umount fail-loud, no `\|\| true`, `printf` resolv only on umount success. Residual: umount failure still continues to sshd (logged, not exit 1) |
| G4 | low OPEN | **FIXED** | `JAIL_APPARMOR_PROFILE` is repo-root `docker/apparmor-gpu-jail`; deny warns once via `JAIL_APPARMOR_DENIED_WARN` |
| G5 | low OPEN | **FIXED** | `LoginGraceTime 60` in Dockerfile and live image; test forbids `LoginGraceTime 0` |
| G6 | low OPEN | **STILL OPEN** | unchanged: `assertNvidiaRuntime` still required; waitReady still does not use `DeviceRequests` |

---

## Findings (open)

| ID | Sev | Summary | Anchor |
|---|---|---|---|
| G6 | low | `assertNvidiaRuntime` still requires the nvidia docker runtime after waitReady stopped using DeviceRequests | `src/docker-host.js:73-88,110` vs `src/providers/home-gpu.js:494-518` |
| G7 | low | PASTE RECIPE still says LAN `ssh_hostname` fails `rental-setup`; live `rental-setup` skips `assertPublicSshHost` when `compute.outbound-ssh-v1` is on | `docs/config.toml.example:188` vs `src/rental-setup.js:41-43` |
| G8 | med | Boot `adoptLiveRentals` re-tracks the jail/lease but does not re-`attachAndDial`; seller restart drops the public SSH door for a paid box | `src/rental-worker.js:313-358` vs `startRentalJob` `:131-176`; caller `src/cli.js:7015-7019` |

---

### G6 — low — STILL OPEN — NVIDIA runtime still required after toolkit binds removed

**Where:** `assertNvidiaRuntime` `src/docker-host.js:73-88`, called from `assertHomeGpuHostReady` `:110`. Start gate `src/cli.js:5742-5750` (`homeGpuConfigured` → `assertHomeGpuHostReady`). waitReady `src/providers/home-gpu.js:494-518` uses `Devices` + `injectNvidiaUserspace`, `DeviceRequests` unset (test `test/providers-home-gpu.test.js:242`).

**Path.** `j41-dispatcher start` with a `home-gpu` provider → `assertHomeGpuHostReady` → `docker info --format "{{json .Runtimes}}"` must match `/nvidia/i`. A host with `/dev/nvidia*` + `nvidia-smi`/`libcuda` (exactly what waitReady needs) is refused if the docker `nvidia` runtime entry is missing.

**Trigger.** GPU host with device nodes and userspace libs, nvidia-container-toolkit not registered as a docker runtime (or a stub dockerode). `start` exits before accept; waitReady would have worked.

**Proposed fix (not applied).** Gate on device nodes + `collectNvidiaUserspace().length` (waitReady already does), or keep the runtime check and document it as “toolkit installed, not used for mounts”. Docs (README Friend boot step 4, CLAUDE.md Cat-1) still claim toolkit is required, so this is a false-closed start gate, not a docs lie.

---

### G7 — low — PASTE RECIPE leftover: LAN hostname still “fails rental-setup”

**Where:** `docs/config.toml.example:188` (`#    LAN ssh_hostname still fails rental-setup (assertPublicSshHost).`).

**Path.** Operator pastes the Cat-1 recipe. Live `assertRentalSetupAllowed` (`src/rental-setup.js:41-43`) skips `assertPublicSshHost` when `outboundSshV1` or `hasOutboundSshV1(version)` is true; CLI `rental-setup` fetches `GET /v1/version` first (`src/cli.js:5300-5315`). README Friend boot step 6 (`README.md:878`) and `test/friend-boot-docs.test.js:31` already forbid “LAN ssh_hostname still fails rental-setup” in README; the example comment was not updated. Four lines above (`:187`) the same recipe correctly calls `ssh_hostname` leftover / LAN-override.

**Trigger.** Operator with RFC1918 `ssh_hostname` on a platform that already has `compute.outbound-ssh-v1`, reading only the example file, concludes `rental-setup` will fail and spends time on a public hostname / named TCP tunnel.

**Proposed fix (not applied).** Delete line 188 or replace with the README sentence: LAN `ssh_hostname` is allowed at `rental-setup` when `GET /v1/version` has `compute.outbound-ssh-v1`. Optionally extend `test/friend-boot-docs.test.js` to `doesNotMatch` that phrase in `docs/config.toml.example`.

---

### G8 — med — Restart re-adopts the jail, not the compute-edge splice

**Where:** `adoptLiveRentals` `src/rental-worker.js:313-358` writes `state.active` (`kind: 'gpu-rental'`, leaseId, agentInfo) and returns. No `attachAndDial`, no `keepOutboundUntilBuyer`, no `postRentalSecret`. Boot caller `src/cli.js:7015-7019` (after crash recovery, before first poll). The only attach path is `startRentalJob` `:131-176`, which runs for new hires only.

**Path.** Paid Cat-1 job is `delivered`; jail container still running (docker, independent of the dispatcher process); seller→edge TCP lives in the dispatcher process (`attachAndDial` + `holdRemoteToLocal`). Dispatcher restart (upgrade, crash, `ctl shutdown` + `start`) kills that TCP. `adoptLiveRentals` puts the job back in `state.active` so extensions and the orphan sweep work (`test/rental-extension.test.js:146-158` asserts kind/leaseId/persist — not edge). Buyer `ssh -i <jobkey> -p <oldport> renter@sovcompute.junction41.io` hits a dead attach port. No new secret is POSTed. Jail stays until `expiresAt` (YANK is cancelled/resolved only — A25). All-or-nothing billing; no dispatcher refund.

**Trigger.** Seller dispatcher process exits and comes back during a live home-gpu rental while `state.outboundSshV1` is true. In-process outbound death is handled (`keepOutboundUntilBuyer`, `REATTACH_MAX = 3`); process death is not.

**Proposed fix (not applied).** After adopt, if `outboundSshV1` and the lease still has a published local port, re-run `attachAndDial` + `keepOutboundUntilBuyer` + `postRentalSecret` (buyer re-GETs rental-access for the new port), same as `startRentalJob`. Fail loud if re-attach exhausts; do not leave a paid box with a dead public door and a green `state.active`.

---

## Adversarial pass

Untrusted party is the **paying renter** (uid 1000 in the jail) plus the **platform attach port**.

Shortest paths considered:

1. **Escape to host.** CapDrop ALL, no docker.sock, no nsenter, no sudo, `no-new-privileges`, overlay `/workspace`, `Binds: []`. SYS_ADMIN is in `CapAdd` but `gpu-jail-init` drops it from the bounding set before exec sshd when SETPCAP is present; if SYS_ADMIN cannot be dropped, init **exits 1** (`docker/gpu-jail-init.sh:27-29`). Renter SSH cannot start until after that drop. No traced escape in this tree. Live image matches.

2. **Steal next renter’s key.** Per-job `ssh-keygen` + `putArchive` authorized_keys; jail dir 0700; `release` `rmSync`s the jail dir. Overlay dies with the container. Persist redacts `ssh.privateKey` (`src/config.js:131-144`). No host bind of `~/.ssh`.

3. **Deliverable leak of host/key on job GET.** Dispatcher notice cannot contain host/password/key (`noticeLeaksSecret`). Secret is POST rental-secret. Whether GET `/v1/jobs/:id` omits them is **backend** (A11 dispatcher VERIFIED, A12 UNVERIFIED). Seller CLI `start` / `rental-setup` / `complete` do not print the sealed private key (complete honesty prints LAN/unreachable warnings, never `ssh -i`).

4. **LAN SSH published.** Jail `PortBindings['22/tcp'][0].HostIp === '127.0.0.1'` never `0.0.0.0`; `NetworkMode` is `j41-gpu-jail` never `host`. Attach host is `assertPublicSshHost`. `J41_ALLOW_LAN_RENTAL=1` is the explicit override. Custom net `10.255.255.0/24` icc off (G2 FIXED — create failure is `HOME_GPU_NO_NET`, not docker0). Residual: a container on that bridge can still route to the docker gateway (`10.255.255.1`) and, depending on host iptables, seller LAN — inherent docker-bridge, not a silent fallback. Not claimed as “no LAN from inside.”

5. **Platform attach MITM.** Seller dials `parseAttachBody` host/dial (public only). A compromised platform can point `dial` at an attacker box and become the L4 door to the jail. Extra-RST “seller is first TCP” is backend (A13 UNVERIFIED). Dispatcher cannot fix a lying attach 200.

6. **Fingerprint the seller machine.** Yes, still: `uname`, `nproc`, GPU UUID (`nvidia-smi` is copied onto the overlay), overlay2 IDs on `/`. Shared-kernel limit (A30), documented in README Friend boot and CLAUDE.md.

7. **Public door dies (G8).** Not a jailbreak. Renter is locked out of a paid box after seller restart until expiry.

No path from renter SSH to host funds/signing channel: the jail is not the job-agent image, has no sign bind, no WIF. `cli.js:7089` `0.0.0.0` bind is the **job-agent egress proxy**, not jail SSH.

---

## Checked and found clean (re-verified)

- HostIp `127.0.0.1` for 22/tcp; never `NetworkMode: host`; never `DeviceRequests`
- CapDrop ALL + no-new-privileges; AppArmor warn-once on deny
- `Binds: []`; keys and nvidia userspace via putArchive
- StorageOpt `disk_gb`; Memory `memory_mb`; PidsLimit 1024
- PasswordAuthentication no; PermitRootLogin no; renter `*` not `!` (live image shadow matches)
- `LoginGraceTime 60` (Dockerfile + live image + `test/jail-image-gate.test.js`)
- `gpu-jail-init` umount fail-loud, `printf` resolv only if umounted, SYS_ADMIN drop-or-exit
- `ensureJailNetwork` fail-closed `HOME_GPU_NO_NET`; icc off; subnet `10.255.255.0/24`
- `deliverSealed` fail-closed without client/signer; notice leak check; `assertPublicSshHost` on sealed host
- Attach parse requires public host; LAN override is env-gated
- `rental-setup` skips `assertPublicSshHost` when `outboundSshV1` / version token; without token still `RENTAL_LAN_HOST`
- Doctor callers (`cli.js` `doctorLiveInputs`, dashboard doctor + status) `fetchOutboundSshV1` → `GET /v1/version`; miss is false
- `ctl stop-rental` does not call complete/cancel (`src/control.js:651-657`, CLI copy)
- Start gate `assertHomeGpuHostReady` before any accept
- In-process re-attach (`REATTACH_MAX = 3`) + splice `{ end: false }`
- `reclaimStaleHomeGpuLocks` on compute-supply boot
- `--price` required on `rental-setup`; no dispatcher reader of `RENTAL_SECRETS_KEY`
- Tests (not re-run): `test/providers-home-gpu.test.js`, `jail-image-gate.test.js`, `compute-edge.test.js`, `rental-worker.test.js`, `rental-setup-command.test.js`, `friend-boot-docs.test.js`, `ssh-host.test.js`, `docker-host.test.js`

---

## 12-PR checklist (expected this re-pass)

| Expected | Status |
|---|---|
| G1 docs: named TCP no longer the product; outbound-ssh-v1; `renter@sovcompute.junction41.io` | **VERIFIED** README / CLAUDE / dashboard / friend-boot-docs test |
| G2: `ensureJailNetwork` throws `HOME_GPU_NO_NET`, never returns bridge | **VERIFIED** `home-gpu.js:160-189` + tests |
| G3: gpu-jail-init umount fail-loud, no `\|\| true`, printf resolv only if umounted | **VERIFIED** source + live image |
| G4: AppArmor path repo-root `docker/apparmor-gpu-jail`; warn once on deny | **VERIFIED** `JAIL_APPARMOR_PROFILE` / `warnApparmorDeniedOnce` |
| G5: `LoginGraceTime 60` | **VERIFIED** Dockerfile + live image |
| G6: nvidia runtime vs DeviceRequests | **STILL OPEN** (low) |
| `rental-setup` skips `assertPublicSshHost` when `outboundSshV1` | **VERIFIED** `rental-setup.js:41-43` |
| Doctor callers fetch `GET /v1/version` | **VERIFIED** |
| Jail SSH `127.0.0.1` never `0.0.0.0`; CLI does not print sealed SSH | **VERIFIED** |
