# gpu-jail / Cat-1 compute SSH — claims checklist

Date: 2026-09-14. Source: README “Raw GPU rental (Cat-1)” + friend boot,
CLAUDE.md Cat-1 paragraph, live orchard product lock (J41-hosted L4 vanilla
SSH, `compute.outbound-ssh-v1`). Implementing code as of uncommitted
`execute-plan/ca3106a1-integrate` worktree.

A claim is anything an operator would act on.

| ID | Claim | Status | Anchor |
|----|--------|--------|--------|
| A1 | Jail is contained SSH, never host SSH | VERIFIED | `home-gpu.js` `PortBindings['22/tcp'][0].HostIp === '127.0.0.1'`; `NetworkMode` is `j41-gpu-jail` or `bridge`, never `host` (`waitReady` createContainer) |
| A2 | Jail SSH is never published on `0.0.0.0` | VERIFIED | same `HostIp: '127.0.0.1'` (`home-gpu.js` PortBindings). Inside the namespace sshd still binds `0.0.0.0:22` (`sshd` default + `EXPOSE 22`); that is not a host publish |
| A3 | `start` refuses without the jail image when home-gpu is configured | VERIFIED | `cli.js` start gate: `homeGpuConfigured` + `assertHomeGpuHostReady` / `jailImageRef(pcfg)` before accept |
| A4 | `build-image` builds job-agent **and** `j41/gpu-jail` | VERIFIED | `cli.js` `build-image` still calls `buildJailImageScriptPath`; `scripts/build-jail-image.sh`; `test/jail-image-gate.test.js` |
| A5 | `memory_mb >= 256`, `disk_gb >= 1`, StorageOpt enforced or refuse | VERIFIED | `assertJailResources`; `StorageOpt: { size: diskGb G }`; quota errors wrapped `HOME_GPU_NO_DISK_QUOTA`; `docker-host.js` `supportsStorageOpt` |
| A6 | NVIDIA toolkit + docker.sock required on the GPU host | VERIFIED (qualified) | `assertNvidiaRuntime` still requires a docker `nvidia` runtime. WaitReady no longer uses `DeviceRequests` / toolkit bind-mounts; devices are mknod copies + overlay-copied userspace. Toolkit is still a start gate, not the mount path |
| A7 | `RENTAL_SECRETS_KEY` is a platform env, not dispatcher | VERIFIED | no dispatcher reader of `RENTAL_SECRETS_KEY` in `src/` (grep); 503 is platform |
| A8 | `--price` required on `rental-setup`; no free default | VERIFIED | prior rental-setup (untouched this pass; `rental-setup.js` still requires price) |
| A9 | Friend boot: operator must point a **named TCP tunnel** at `127.0.0.1:$ssh_tunnel_port` | **DRIFT** | README:857 and CLAUDE.md:29 still say this. Live advertise/accept gate is `compute.outbound-ssh-v1` (`compute-edge.js`, `shouldRefuseLanGpuRental` skipped when `outboundSshV1`). Seller dials attach `host:port`; buyer SSH is `renter@sovcompute.junction41.io`. `ssh_tunnel_port` is still the **loopback jail publish**, not the public port |
| A10 | `ssh_hostname` must not be loopback / `0.0.0.0` / HTTP | VERIFIED | `assertTunnelHostname`. RFC1918 is warn-only at write; accept/deliver refuse unless `J41_ALLOW_LAN_RENTAL=1` **or** outbound-ssh-v1 |
| A11 | Deliverable must not put host/key on `GET /v1/jobs/:id` | VERIFIED (dispatcher) | `deliverSealed` POSTs `/v1/jobs/:id/rental-secret` then `deliverJob` a notice; `noticeLeaksSecret` refuses if notice contains host/password/privateKey (`rental-delivery.js:30-41,85-96`) |
| A12 | Buyer-only `GET /v1/jobs/:id/rental-access` | UNVERIFIED (backend) | Dispatcher never serves that GET. Platform contract |
| A13 | Seller is first TCP on the attach port; extras RST | UNVERIFIED (backend) | Dispatcher `attachAndDial` is one outbound `net.connect`. Extra-RST is the edge |
| A14 | Challenge/attach/secret allowed while **delivered**; complete/cancel still 400 | UNVERIFIED (backend) | `keepOutboundUntilBuyer` comments this; dispatcher POSTs secret on re-attach. HTTP 400/200 is platform |
| A15 | CLI `complete` does not print SSH | VERIFIED | `runBuyerComplete` + `leftoverCompleteHonesty`; LAN leftover prints warning not `✅` |
| A16 | CapDrop ALL on the jail | VERIFIED | `HostConfig.CapDrop: ['ALL']` then scoped `CapAdd` (`JAIL_CAP_ADD`) |
| A17 | Renter is not root | VERIFIED | Dockerfile `useradd renter`; sshd `PermitRootLogin no`; Mac audits uid 1000 |
| A18 | No host binds for `/workspace` or authorized_keys | VERIFIED | `Binds: []`; keys via `putArchive` onto overlay |
| A19 | `/workspace` is overlay-capped at `disk_gb` | VERIFIED | StorageOpt size; Mac `df /` 20G overlay |
| A20 | Jail image renter is not shadow-locked (`!`) | VERIFIED | `usermod -p '*'`; jail-image-gate test |
| A21 | Password auth off, pubkey only | VERIFIED | `sshd_config.d/j41-jail.conf` |
| A22 | Public SSH host on attach is not RFC1918 | VERIFIED | `parseAttachBody` → `assertPublicSshHost` (`compute-edge.js:51`) |
| A23 | Re-attach on outbound TCP death, buyer re-GETs rental-access | VERIFIED | `keepOutboundUntilBuyer` + `postRentalSecret` (`rental-worker.js:155-167`) |
| A24 | `ctl stop-rental` drops jail + edge, does not complete/cancel on-chain | VERIFIED | `control.js` stop-rental; CLI copy `Does not complete or cancel on-chain` |
| A25 | Buyer complete yanks the jail immediately | **DRIFT** | `YANK_RENTAL_STATUSES` is `cancelled` / `resolved` / `resolved_rejected` only (`rental-worker.js:288-290`). Comment: delivered/completed is NOT a yank — box until `expiresAt`. Operator `ctl stop-rental` is the explicit teardown |
| A26 | AppArmor `j41-gpu-jail` confines mountinfo/modules | **DRIFT** | Profile exists (`docker/apparmor-gpu-jail`). `loadJailApparmor` (`home-gpu.js:183-198`) returns false on parser deny and does not log. Live inspect `SecurityOpt: ["no-new-privileges:true"]` only |
| A27 | Custom network, not docker0 `172.17.0.0/16` | VERIFIED (qualified) | `ensureJailNetwork` creates `j41-gpu-jail` `10.255.255.0/24` icc off. On create failure it **warns and uses `bridge`** (`home-gpu.js:178-179`) |
| A28 | DNS is not host LAN resolv | VERIFIED (qualified) | `HostConfig.Dns 1.1.1.1/8.8.8.8`; init rewrites `/etc/resolv.conf`. Docker still bind-mounts resolv from docker-xfs until init umounts; umount failure is ignored (`gpu-jail-init.sh:9`) |
| A29 | NVIDIA toolkit binds do not leak host LV | VERIFIED (this tree) | No `DeviceRequests`. Devices + `injectNvidiaUserspace`. Throwaway: `df nvidia-smi` overlay |
| A30 | `uname` / GPU UUID / overlay `/` mountinfo hidden | MISSING (cannot) | Container shares host kernel. Documented in jail-init comments; Mac table still shows them. Not a broken claim in README (README never promised anonymity) |
