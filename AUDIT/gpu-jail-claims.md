# gpu-jail / Cat-1 compute SSH — claims checklist (re-pass)

Date: 2026-09-15. HEAD `5ca8776`. Source: README “Raw GPU rental (Cat-1)” + Friend boot, CLAUDE.md Cat-1 paragraph, `docs/config.toml.example` PASTE RECIPE, live orchard product lock (J41-hosted L4 vanilla SSH, `compute.outbound-ssh-v1`). Prior pass 2026-09-14 superseded.

A claim is anything an operator would act on.

## Prior claim status (A1–A30)

| ID | 2026-09-14 | 2026-09-15 |
|----|------------|------------|
| A1–A5, A7–A8, A10–A11, A15–A24, A29 | VERIFIED | VERIFIED (re-checked) |
| A6 | VERIFIED (qualified) | VERIFIED (qualified) — G6 still open |
| A9 | **DRIFT** | **VERIFIED** — named TCP is not the product in README/CLAUDE/dashboard |
| A12–A14 | UNVERIFIED (backend) | UNVERIFIED (backend) |
| A25 | **DRIFT** | **DRIFT** (unchanged — buyer complete does not yank) |
| A26 | **DRIFT** | **VERIFIED (qualified)** — docs now admit AppArmor does not load as this user; warn-once on deny |
| A27 | VERIFIED (qualified, bridge fallback) | **VERIFIED** — create failure is `HOME_GPU_NO_NET` |
| A28 | VERIFIED (qualified, umount `\|\| true`) | **VERIFIED (qualified)** — fail-loud; umount failure still continues |
| A30 | MISSING (cannot) | MISSING (cannot) |

New this pass: A31 DRIFT (example PASTE RECIPE LAN sentence), A32 MISSING (boot does not re-attach edge).

---

| ID | Claim | Status | Anchor |
|----|--------|--------|--------|
| A1 | Jail is contained SSH, never host SSH | VERIFIED | `home-gpu.js` `PortBindings['22/tcp'][0].HostIp === '127.0.0.1'`; `NetworkMode` is `j41-gpu-jail`, never `host` (`waitReady` createContainer `:498-500`) |
| A2 | Jail SSH is never published on `0.0.0.0` | VERIFIED | same `HostIp: '127.0.0.1'`. Inside the namespace sshd still binds `0.0.0.0:22` (`EXPOSE 22` + sshd default); that is not a host publish. `cli.js:7089` `0.0.0.0` is the job-agent egress proxy, not jail SSH |
| A3 | `start` refuses without the jail image when home-gpu is configured | VERIFIED | `cli.js:5742-5759` `homeGpuConfigured` + `assertHomeGpuHostReady` / `jailImageRef(pcfg)` before accept |
| A4 | `build-image` builds job-agent **and** `j41/gpu-jail` | VERIFIED | `cli.js` `build-image` still calls `buildJailImageScriptPath`; `scripts/build-jail-image.sh`; `test/jail-image-gate.test.js` |
| A5 | `memory_mb >= 256`, `disk_gb >= 1`, StorageOpt enforced or refuse | VERIFIED | `assertJailResources`; `StorageOpt: { size: diskGb G }`; quota errors wrapped `HOME_GPU_NO_DISK_QUOTA`; `docker-host.js` `supportsStorageOpt` |
| A6 | NVIDIA toolkit + docker.sock required on the GPU host | VERIFIED (qualified) | Docs and `assertNvidiaRuntime` still require a docker `nvidia` runtime. WaitReady does not use `DeviceRequests` / toolkit bind-mounts; devices are mknod copies + overlay-copied userspace. Toolkit is a start gate, not the mount path (G6) |
| A7 | `RENTAL_SECRETS_KEY` is a platform env, not dispatcher | VERIFIED | no `process.env.RENTAL_SECRETS_KEY` in `src/`; CLI only maps platform `RENTAL_SECRETS_KEY_MISSING` (`cli.js:5370-5372`) |
| A8 | `--price` required on `rental-setup`; no free default | VERIFIED | `cli.js:5279-5293` missing `--price` with `--register` exits; no default `0` |
| A9 | Friend boot: operator must point a **named TCP tunnel** at `127.0.0.1:$ssh_tunnel_port` | **VERIFIED (negated)** | README:871, CLAUDE.md:35, dashboard `computeProviderScreen`:2237-2239, `docs/config.toml.example:189`, `test/friend-boot-docs.test.js` — named TCP is **not** the product. Public SSH is `compute.outbound-ssh-v1`; buyer `renter@sovcompute.junction41.io`. `ssh_tunnel_port` is the **loopback jail publish**. `tunnel-setup` remains for HTTP model `publicUrl` |
| A10 | `ssh_hostname` must not be loopback / `0.0.0.0` / HTTP | VERIFIED | `assertTunnelHostname`. RFC1918 is warn-only at write; accept/deliver refuse unless `J41_ALLOW_LAN_RENTAL=1` **or** outbound-ssh-v1 |
| A11 | Deliverable must not put host/key on `GET /v1/jobs/:id` | VERIFIED (dispatcher) | `deliverSealed` POSTs `/v1/jobs/:id/rental-secret` then `deliverJob` a notice; `noticeLeaksSecret` refuses if notice contains host/password/privateKey (`rental-delivery.js:30-41,85-96`) |
| A12 | Buyer-only `GET /v1/jobs/:id/rental-access` | UNVERIFIED (backend) | Dispatcher never serves that GET. Platform contract |
| A13 | Seller is first TCP on the attach port; extras RST | UNVERIFIED (backend) | Dispatcher `attachAndDial` is one outbound `net.connect`. Extra-RST is the edge |
| A14 | Challenge/attach/secret allowed while **delivered**; complete/cancel still 400 | UNVERIFIED (backend) | `keepOutboundUntilBuyer` comments this; dispatcher POSTs secret on re-attach. HTTP 400/200 is platform |
| A15 | CLI `complete` does not print SSH | VERIFIED | `runBuyerComplete` + `leftoverCompleteHonesty`; LAN leftover prints warning not `✅`. No `ssh -i` / privateKey in seller `start` / `rental-setup` stdout |
| A16 | CapDrop ALL on the jail | VERIFIED | `HostConfig.CapDrop: ['ALL']` then scoped `CapAdd` (`JAIL_CAP_ADD`) |
| A17 | Renter is not root | VERIFIED | Dockerfile `useradd renter`; sshd `PermitRootLogin no`; live image `renter:x:1000:1000` |
| A18 | No host binds for `/workspace` or authorized_keys | VERIFIED | `Binds: []`; keys via `putArchive` onto overlay |
| A19 | `/workspace` is overlay-capped at `disk_gb` | VERIFIED | StorageOpt size; start/rental-setup refuse without `supportsStorageOpt` |
| A20 | Jail image renter is not shadow-locked (`!`) | VERIFIED | `usermod -p '*'`; live image shadow `renter:*`; `jail-image-gate` test |
| A21 | Password auth off, pubkey only | VERIFIED | `sshd_config.d/j41-jail.conf` in Dockerfile and live image |
| A22 | Public SSH host on attach is not RFC1918 | VERIFIED | `parseAttachBody` → `assertPublicSshHost` (`compute-edge.js:72`); test throws on `192.168.1.69` |
| A23 | Re-attach on outbound TCP death, buyer re-GETs rental-access | VERIFIED (in-process only) | `keepOutboundUntilBuyer` + `postRentalSecret` (`rental-worker.js:155-167`). **Does not cover dispatcher process restart** — see A32 / G8 |
| A24 | `ctl stop-rental` drops jail + edge, does not complete/cancel on-chain | VERIFIED | `control.js:651-657` `stopRentalJob` only; CLI copy `Does not complete or cancel on-chain` |
| A25 | Buyer complete yanks the jail immediately | **DRIFT** | `YANK_RENTAL_STATUSES` is `cancelled` / `resolved` / `resolved_rejected` only (`rental-worker.js:286-290`). Comment: delivered/completed is NOT a yank — box until `expiresAt`. Operator `ctl stop-rental` is the explicit teardown. Unchanged from prior pass |
| A26 | AppArmor `j41-gpu-jail` confines mountinfo/modules | VERIFIED (qualified) | Profile exists (`docker/apparmor-gpu-jail`); `JAIL_APPARMOR_PROFILE` is repo-root (`home-gpu.js:157`). `loadJailApparmor` warns once on parser deny (`JAIL_APPARMOR_DENIED_WARN`) and hire proceeds with `SecurityOpt: ["no-new-privileges:true"]` only. README:881 and CLAUDE.md:35 now say AppArmor cannot load as this user; isolation is CapDrop |
| A27 | Custom network, not docker0 `172.17.0.0/16` | VERIFIED | `ensureJailNetwork` creates `j41-gpu-jail` `10.255.255.0/24` icc off. Missing `createNetwork` / permission / IPAM collision throws `HOME_GPU_NO_NET` — never returns `'bridge'` (`home-gpu.js:160-189`; tests `:361-401`) |
| A28 | DNS is not host LAN resolv | VERIFIED (qualified) | `HostConfig.Dns 1.1.1.1/8.8.8.8`; init rewrites `/etc/resolv.conf` **only if umount succeeds**. UMount failure logs `gpu-jail-init: umount $f failed` (no `\|\| true`); sshd still starts. `/sys/block` is in `JAIL_MASKED_PATHS` |
| A29 | NVIDIA toolkit binds do not leak host LV | VERIFIED | No `DeviceRequests`. Devices + `injectNvidiaUserspace` |
| A30 | `uname` / GPU UUID / overlay `/` mountinfo hidden | MISSING (cannot) | Container shares host kernel. Documented in README Friend boot and CLAUDE.md. Not a broken README claim |
| A31 | PASTE RECIPE: LAN `ssh_hostname` still fails `rental-setup` | **DRIFT** | `docs/config.toml.example:188`. Live `assertRentalSetupAllowed` skips `assertPublicSshHost` when `outboundSshV1` / version token (`rental-setup.js:41-43`). README:878 states the opposite. G7 |
| A32 | After dispatcher restart, public GPU SSH is restored | **MISSING** | `adoptLiveRentals` (`rental-worker.js:313-358`) re-tracks lease for extensions/orphan sweep; does not `attachAndDial`. In-process re-attach (A23) dies with the process. G8 |
