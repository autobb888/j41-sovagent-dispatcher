# gpu-jail / Cat-1 compute SSH — audit report

**Date:** 2026-09-14 · **Scope:** uncommitted Cat-1 home-gpu jail + J41
compute-edge (vanilla SSH) on `execute-plan/ca3106a1-integrate`. Read-only;
no src edits, no tests run in this pass, no commits.

**Counts:** crit 0 · high 0 · med 3 · low 3 · **total 6**

Claims: `AUDIT/gpu-jail-claims.md` — 22 VERIFIED · 3 DRIFT (A9, A25, A26) ·
1 MISSING (A30, physical limit) · 3 UNVERIFIED (backend-only A12–A14) ·
2 VERIFIED-qualified (A6, A27, A28).

Mac stranger probes (`e0446456` SSH publickey; later fingerprint tables)
showed **isolation holds** (no root, no docker.sock, no nsenter, no host
paths). Remaining issues are docs drift, silent fallbacks, and
fingerprint — not jailbreak.

---

## Findings

| ID | Sev | Summary | Anchor |
|---|---|---|---|
| G1 | med | Friend-boot docs still prescribe a seller-run named TCP tunnel; live product is seller-outbound `compute.outbound-ssh-v1` | README:857, CLAUDE.md:29 vs `src/compute-edge.js:1-7`, `src/ssh-host.js:83-96` |
| G2 | med | Jail docker network create failure silently uses docker0 (`172.17.0.0/16`) | `src/providers/home-gpu.js:178-179` |
| G3 | med | `gpu-jail-init` umount of Docker hosts/resolv binds is best-effort; failure leaves `/mnt/…/j41-docker-xfs.img` on `df`/`findmnt` | `docker/gpu-jail-init.sh:9` |
| G4 | low | AppArmor profile never loads as this operator; failure is silent | `src/providers/home-gpu.js:190-196` |
| G5 | low | `LoginGraceTime 0` means OpenSSH waits forever for auth (intentional for slow Mac kex; DoS sshd) | `Dockerfile.gpu-jail` sshd_config.d |
| G6 | low | `assertNvidiaRuntime` still requires the nvidia docker runtime after waitReady stopped using DeviceRequests | `src/docker-host.js:73-88` vs `home-gpu.js:479-493` |

---

### G1 — med — Docs still teach named TCP tunnel as the product

**Where:** `README.md:857` step 3 (“Point a Cloudflare named TCP tunnel … at
`127.0.0.1:$ssh_tunnel_port`”). `CLAUDE.md:29` (“named TCP tunnel to
`127.0.0.1:$ssh_tunnel_port`”).

**Path.** Advertise/accept: `shouldRefuseLanGpuRental` returns false when
`opts.outboundSshV1` (`ssh-host.js:84`). Doctor `rental.ssh_public` passes on
the feature token (`doctor.js` outboundSshV1 branch). Runtime: seller
`attachAndDial` (`compute-edge.js:209`) `net.connect`s attach `host:port`,
splices to `127.0.0.1:ssh_tunnel_port`. Buyer SSH is
`renter@sovcompute.junction41.io` from attach 200 / rental-access.

**Trigger.** Operator following README on a box with RFC1918 `ssh_hostname`
and live `compute.outbound-ssh-v1` still spends time on CF TCP tunnels that
the dispatcher no longer publishes. Conversely, without the feature token,
LAN `ssh_hostname` is still refused (good).

**Proposed fix (not applied).** Rewrite friend boot: jail still publishes
22/tcp on `127.0.0.1:$ssh_tunnel_port`; public reachability is J41 compute
edge, not a seller tunnel. Keep `ssh_hostname` only as a legacy/LAN-override
field.

---

### G2 — med — Network create failure falls back to docker0

**Where:** `ensureJailNetwork` `src/providers/home-gpu.js:158-180`.

**Path.** `waitReady` → `ensureJailNetwork`. If `createNetwork` throws
anything except “already exists”, it `console.warn`s and returns `'bridge'`.
Default docker0 is `172.17.0.0/16` — the Mac `bda22d4f` NAT leak.

**Trigger.** Docker without permission to create networks, IPAM collision on
`10.255.255.0/24`, or a stub/old dockerode. Jail still starts.

**Proposed fix.** Fail closed (`HOME_GPU_NO_NET`) instead of returning
`bridge`, or retry a different subnet. Do not silently undo the custom net.

---

### G3 — med — Init umount ignore-errors

**Where:** `docker/gpu-jail-init.sh:6-12`.

**Path.** Pid 1 copies `/etc/resolv.conf|/etc/hosts|/etc/hostname`,
`umount` / `umount -l` with `|| true`, copies back, writes 1.1.1.1 DNS.
If umount fails (no SYS_ADMIN yet, busy mount), the copy writes **through**
Docker’s bind onto the docker-xfs loop. Mac `7fc6611a`: `df` those files →
`/dev/loop26` / backing_file `/mnt/2_3TB_partition/j41-docker-xfs.img`.

**Trigger.** HostConfig without `SYS_ADMIN`+`SETPCAP` (old dispatcher + new
image: init skips drop and never had SYS_ADMIN, umount fails). Or umount
EPERM for another reason.

**Proposed fix.** If `capsh --has-p=cap_sys_admin` and umount still fails,
log loudly; optional fail-closed. Do not `|| true` without a line in
dispatcher logs. Mask `/sys/block` (already in `JAIL_MASKED_PATHS` this
tree) so backing_file is hidden even if the bind remains.

---

### G4 — low — AppArmor load is silent

**Where:** `loadJailApparmor` `home-gpu.js:183-198`.

**Path.** `apparmor_parser -r` needs policy admin. This user: “Access
denied”. Function returns `false`; `SecurityOpt` is only
`no-new-privileges:true`. Live inspect confirmed.

**Trigger.** Any non-root docker-group operator.

**Proposed fix.** `console.warn` once: profile not loaded, mountinfo glob
deny inactive. Do not claim AppArmor in operator docs until load is
verified.

---

### G5 — low — LoginGraceTime 0

**Where:** `Dockerfile.gpu-jail` `sshd_config.d/j41-jail.conf`.

**Path.** OpenSSH: `LoginGraceTime 0` = no time limit waiting for auth.
Set so slow Mac kex is not killed. Combined with `LoginGraceTime 0` +
sshd on the splice, a client that connects and never auths holds a worker.

**PidsLimit: 1024** bounds process count. Still a cheap stall.

**Proposed fix.** Finite grace (e.g. 60s) now that keepalive/`end:false`
holds the edge TCP independently of a single kex.

---

### G6 — low — NVIDIA runtime still required after toolkit binds removed

**Where:** `assertNvidiaRuntime` `docker-host.js:73-88`; waitReady
`home-gpu.js:479-493` uses `Devices` + overlay copy, not `DeviceRequests`.

**Trigger.** Host with `/dev/nvidia*` and libs but no `nvidia` runtime
entry: `start` refuses even though waitReady would work.

**Proposed fix.** Gate on device nodes + `collectNvidiaUserspace().length`,
or keep the runtime check and document it as “toolkit installed, not used
for mounts”.

---

## Adversarial pass

Untrusted party is the **paying renter** (uid 1000 in the jail) plus the
**platform attach port**.

Shortest paths considered:

1. **Escape to host.** CapDrop ALL, no docker.sock, no nsenter, no sudo,
   `no-new-privileges`, overlay `/workspace`. SYS_ADMIN is in `CapAdd` but
   `gpu-jail-init` drops it from the bounding set before exec sshd when
   SETPCAP is present; if SYS_ADMIN cannot be dropped, init **exits 1**
   (`gpu-jail-init.sh:21-23`). Mac probes could not root. No traced escape
   in this tree.

2. **Steal next renter’s key.** Per-job `ssh-keygen` + `putArchive`
   authorized_keys; jail dir 0700; `release` `rmSync`s the jail dir.
   Overlay dies with the container. No host bind of `~/.ssh`.

3. **Deliverable leak of host/key on job GET.** Dispatcher notice cannot
   contain host/password/key (`noticeLeaksSecret`). Secret is POST
   rental-secret. Whether GET `/v1/jobs/:id` omits them is **backend**
   (A11 dispatcher VERIFIED, A12 UNVERIFIED).

4. **LAN SSH published.** Attach host is `assertPublicSshHost`. Loopback
   publish only. `J41_ALLOW_LAN_RENTAL=1` is the explicit override.

5. **Fingerprint the seller machine.** Yes, still: `uname`, `nproc`, GPU
   UUID, overlay2 IDs on `/`. That is a container-on-shared-kernel limit
   (A30), not a jailbreak.

No path from renter SSH to host funds/signing channel: the jail is not the
job-agent image, has no sign bind, no WIF.

---

## Checked and found clean

- HostIp `127.0.0.1` for 22/tcp; never `NetworkMode: host`
- CapDrop ALL + no-new-privileges
- `Binds: []`; keys and nvidia userspace via putArchive
- StorageOpt `disk_gb`; Memory `memory_mb`
- PasswordAuthentication no; PermitRootLogin no; renter `*` not `!`
- `deliverSealed` fail-closed without client/signer; notice leak check
- Attach parse requires public host; LAN override is env-gated
- `ctl stop-rental` does not call complete/cancel
- Start gate `assertHomeGpuHostReady` before any accept
- Re-attach budget (`REATTACH_MAX = 3`) + splice `{ end: false }`
- `reclaimStaleHomeGpuLocks` on compute-supply boot
- Tests: `test/providers-home-gpu.test.js`, `jail-image-gate.test.js`,
  `compute-edge.test.js`, `rental-worker.test.js` (not re-run this pass)

---

## Uncommitted tree (commit slicing, not applied)

Do **not** dump the whole dirty worktree as one commit. Unrelated to this
domain: `src/executors/local-llm.js` (~210 lines), `src/proxy-handler.js`
(IPv4 pin + alias log), `src/preflight-gate.js` (PREFLIGHT log),
`src/llm-health.js` (probe timeout 15s).
