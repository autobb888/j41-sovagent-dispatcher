# Jail fingerprint hardening after 7b93dc4c (2026-09-14)

Mac: in as renter; not a jailbreak. Leaked host kernel/CPU/RAM/disk layout via /proc and a host bind on /workspace.

Fix for the next hire:
- `/workspace` is overlay + `disk_gb` StorageOpt, not a host bind (no host LV path, no `ssh/` keys in workspace)
- only bind: `authorized_keys` → `/home/renter/.ssh:ro`
- MaskedPaths: cpuinfo, meminfo, version, cmdline, mounts, diskstats, DMI
- hostname `gpu-jail`
- `uname` still reports the host kernel (container shares it; needs a VM to hide)

Round 2 (after 7e5d7a74): no host binds at all — authorized_keys injected onto overlay via putArchive. Mask `/proc/self/mountinfo` so findmnt cannot name overlay2 / j41-docker-xfs.img / LVM. NVIDIA driver binds from nvidia-container-toolkit remain (needed for nvidia-smi); GPU UUID is the rented card. nproc still follows host CPU count unless we pin a cpuset.
