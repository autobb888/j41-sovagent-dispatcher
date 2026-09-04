# Distro operability for Junction41 dispatcher mass-onboarding

**Date:** 2026-09-04
**Status:** Design only. Do not treat this as shipped installer behaviour.
**Scope:** `scripts/install.sh` + `j41-dispatcher doctor` copy-paste blocks.
**Non-scope:** `src/` production changes, GPU Mac/Windows, native Win32, auto-rewriting Docker storage.

An engineer implementing installer/doctor must switch on real `ID` / `ID_LIKE` / `VERSION_ID` and real package names. “Linux in general” is how today’s installer fails.

Evidence was checked against live package indexes and vendor docs on 2026-09-04. Rows that could not be confirmed are marked **UNVERIFIED**.

---

## 0. What is broken today (do not repeat)

Canonical files:

- `scripts/install.sh` (advertised `curl | bash`)
- `setup.sh` (in-tree one-shot)
- `j41-secure-setup/lib/detect-platform.js` (reads `/etc/os-release` `ID=` only)
- `j41-secure-setup/lib/install-gvisor.js` / `install-bwrap.js` (hard-coded distro lists)

Facts against current `install.sh`:

| Defect | Evidence |
|---|---|
| Clones `https://github.com/junction41/j41-sovagent-dispatcher` | 404. Live git remote is `autobb888/j41-sovagent-dispatcher`. |
| `J41_VERSION="latest"` tarball fallback | Not a git tag; `releases/download/vlatest/...` will 404. |
| Installs into `~/.j41/dispatcher` | That path is the runtime data dir (`src/config.js`), not a git worktree. |
| `if command -v apt-get` then NodeSource | Ubuntu, Debian, Mint, Pop, LMDE all have `apt-get` and need **different** Docker/Node recipes. |
| NodeSource `setup_22.x \| sudo bash` | Rewrites apt sources; fights distro `nodejs`; do not use as the default path. |
| `curl https://get.docker.com \| sh` with no sudo/trust note | Script needs root. It is a third-party root execution. |
| Non-TTY (`curl \| bash`) sets `RUNTIME=local` and writes `config.json` | `install.sh:97–100, 169–173`. `start` then refuse-closes unless `--dev-unsafe` (`cli.js` F7). Mass-onboarding looks “installed” and then dead. |
| `dockerode` is `new Docker()` | Default sock `/var/run/docker.sock`. Snap, Desktop, rootless, Colima all miss this. |
| `detect-platform.js` only parses `ID=` | Mint (`linuxmint`), Pop (`pop`), LMDE, Rocky, Alma, WSL Ubuntu all need `ID_LIKE` + `VERSION_ID` + extra probes. |
| gVisor yum path is `dnf install runsc` with no repo | Will fail on stock Fedora/RHEL. Binary pin path is the real fallback. |

Product constraints the installer must honour:

- `package.json` `engines.node` is `>=20.0.0`. Recommend Node **22** (Jod, maintenance LTS through 2027-04-30).
- Labour jobs need a working Docker Engine (dockerode + `Dockerfile.job-agent` `FROM node:22-slim`).
- Cat-1 GPU additionally needs NVIDIA Container Toolkit **and** StorageOpt (`src/docker-host.js` `supportsStorageOpt`: classic `overlay2` over XFS `prjquota`/`pquota`, or `btrfs`/`zfs`). Labour does **not** need StorageOpt.
- Never persist `runtime=local` from the installer.

---

## 1. Detection (installer and doctor share this)

Do **not** key off `command -v apt-get` / `dnf` / `pacman` alone.

```
detect_os():
  uname -s  → Linux | Darwin | *  (Darwin/Windows: refuse Linux copy, see §8)
  uname -m  → x86_64 | aarch64 | * (32-bit / other: fail-closed)
  parse /etc/os-release:
    ID, ID_LIKE, VERSION_ID, VERSION_CODENAME, UBUNTU_CODENAME
  extra:
    WSL if WSL_DISTRO_NAME is set OR /proc/version matches [Mm]icrosoft
    ostree/immutable if /run/ostree-booted exists OR rpm-ostree is the only pkg tool
    snap docker if snap list docker succeeds OR sock is under /var/snap/docker/
    rootless if DOCKER_HOST is unix://$XDG_RUNTIME_DIR/docker.sock
              OR dockerd is a user unit
    podman-only if docker is a podman wrapper AND /var/run/docker.sock missing
                 AND podman.socket is the only listener
```

Family mapping (installer `case`):

| `ID` | `ID_LIKE` (typical) | Family | Class |
|---|---|---|---|
| `ubuntu` | `debian` | ubuntu | first-class |
| `debian` | — | debian | first-class |
| `fedora` | — | fedora | first-class |
| `rhel` | `fedora` | rhel9 | first-class |
| `rocky` | `rhel centos fedora` | rhel9 | first-class |
| `almalinux` | `rhel centos fedora` | rhel9 | first-class |
| `linuxmint` | `ubuntu debian` | ubuntu-derivative | best-effort (Mint) / debian if LMDE |
| `pop` | `ubuntu debian` | ubuntu-derivative | best-effort |
| `elementary` | `ubuntu debian` | ubuntu-derivative | best-effort |
| `arch` | — | arch | best-effort |
| `manjaro` | `arch` | arch | best-effort |
| `opensuse-leap`, `opensuse-tumbleweed` | `suse opensuse` | suse | best-effort |
| `amzn` | — | amazon | best-effort |
| `alpine` | — | — | unsupported |
| `nixos` | — | — | unsupported |
| `gentoo` | — | — | unsupported |
| `clearlinux` | — | — | unsupported |
| Silverblue/Kinoite (`VARIANT_ID=silverblue` etc.) | fedora | ostree | unsupported |

WSL is **not** an `ID`. It is Ubuntu (or Debian) plus extra probes. First-class WSL is **WSL2 + Ubuntu 22.04/24.04/26.04**.

`j41-secure-setup` today treats `ubuntu|debian|linuxmint|pop|elementary` as apt and `fedora|centos|rhel|rocky|almalinux|amzn|amazonlinux` as yum. Installer/doctor must be stricter (VERSION_ID branches) but should not contradict those IDs.

---

## 2. Shared rules (every first-class distro)

### 2.1 Node — never distro `nodejs` as the install path

Must not `apt/dnf/yum/pacman/zypper install nodejs` if that package is `<20`. Even when it is ≥20 (Debian 13, Ubuntu 26.04, current Fedora), the **installer path** is still:

1. If `node` is already on PATH and `node -p process.versions.node` ≥ 20 → accept. Print origin (`command -v node`).
2. Else nvm: source `$HOME/.nvm/nvm.sh` or install nvm, then `nvm install 22`.
3. Else official tarball → `~/.local/node` (Linux x64/arm64 only). Darwin: nvm only, no tarball (see §8).

**Do not** NodeSource (`deb.nodesource.com` / `rpm.nodesource.com`). It rewrites distro apt/dnf, replaces `/usr/bin/node`, and breaks later `apt upgrade`. If an operator already has NodeSource, doctor should say so and not fight it, as long as version ≥ 20.

Tarball sketch (Linux only):

```bash
# Node 22 official tarball → ~/.local/node  (glibc; not Alpine)
arch=$(uname -m)
case "$arch" in
  x86_64)  narch=x64 ;;
  aarch64) narch=arm64 ;;
  *) echo "unsupported arch $arch"; exit 1 ;;
esac
ver=22.19.0   # pin at implement time; do not float "latest"
mkdir -p "$HOME/.local"
curl -fsSL "https://nodejs.org/dist/v${ver}/node-v${ver}-linux-${narch}.tar.xz" \
  | tar -xJ -C "$HOME/.local"
rm -rf "$HOME/.local/node"
mv "$HOME/.local/node-v${ver}-linux-${narch}" "$HOME/.local/node"
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
```

After Node: `npm install -g yarn@1.22.22` (matches `package.json` `packageManager`). Global prefix is writable under nvm and `~/.local/node`. Distro `/usr/bin/npm` often needs sudo — another reason not to use it.

PATH:

| Origin | Binaries | Shell hook |
|---|---|---|
| nvm | `~/.nvm/versions/node/v22.*/bin` | `source ~/.nvm/nvm.sh` in bashrc/zshrc |
| tarball | `~/.local/node/bin` | `export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"` |
| distro (only if ≥20 already) | `/usr/bin/node` | none |
| yarn / `j41-dispatcher` shim | `~/.local/bin` | same PATH line |

Doctor must print which of those is active. A login shell without the hook is the #2 “node: command not found after install” failure.

### 2.2 Docker — detect a daemon, not a package name

Need **all** of:

- `docker` CLI on PATH
- a listening engine at a sock dockerode will use (`/var/run/docker.sock` unless `DOCKER_HOST` is set)
- `docker info` succeeding **without sudo**
- unit enabled if the host is systemd (`systemctl is-enabled docker` or `docker.socket`)

Permission taxonomy doctor must distinguish (today `getActiveJobs` lumps them and suggests `config --runtime local` — do not copy that):

| Symptom | Typical cause | Fix shape |
|---|---|---|
| `ENOENT` connecting to `/var/run/docker.sock` | daemon not installed, not started, or sock is elsewhere (snap, Desktop, rootless) | start unit **or** point at the real sock; never “install docker” blindly |
| `EACCES` / `permission denied` | sock exists; user not in `docker` group; or SELinux AVC | `usermod -aG docker`; **new session**; SELinux `:z` — not “Docker is missing” |
| CLI exists, `docker info` “Is the docker daemon running?” | package installed, unit disabled, or WSL without systemd | `systemctl enable --now docker` |
| `docker` is podman wrapper | Fedora/RHEL `podman-docker` | unsupported unless a real `docker.sock` exists |
| snap `docker` | classic snap, cgroup/sock mismatch | fail/warn — see §7 |

Group name is `docker` on every first-class distro. Sock path is `/var/run/docker.sock` → `/run/docker.sock` for Engine. **Not** a named pipe, **not** `~/.docker/run/docker.sock` (that is Desktop on macOS).

`newgrp docker` on systemd distros:

```bash
# usermod does not change the current session
id -nG          # must list docker after a *new login*
newgrp docker   # new shell in this tty only; or close the terminal and open another
# WSL2: close the tab; if group still missing: from Windows: wsl --shutdown, reopen
```

`sg docker -c 'docker info'` is a one-shot check without replacing the shell.

### 2.3 `get.docker.com` is a trust decision

Convenience script: `https://get.docker.com` → Docker CE (`docker-ce`). It **must** run as root (`sudo sh get-docker.sh`).

Print, do not hide:

```
This downloads a script from get.docker.com and runs it as root.
That is a trust decision. Prefer the distro-specific sudo block below
if you do not want to execute remote bash as root.
```

Known script behaviour (Docker Engine install docs, 2026-08/10):

- Debian/Ubuntu: installs **and starts** the service.
- Fedora/RHEL/CentOS: installs, **does not start**. Doctor/installer must `systemctl enable --now docker`.
- Detects distro from os-release; still fails on derivatives if `VERSION_CODENAME` is not a Docker-supported suite (Mint must use `UBUNTU_CODENAME`).
- Does **not** add the user to group `docker`. Always `usermod -aG docker "$USER"` afterwards.

First-class installer should **print the native sudo block** (package names below). `get.docker.com` is the best-effort fallback and the non-interactive “I accept remote root bash” path, never the silent default.

### 2.4 Docker 29 `overlayfs` vs classic `overlay2` (GPU, all distros)

This is an **engine-version** trap, not Ubuntu-only.

Docker Engine **29.0+** on a **fresh** install defaults to the containerd image store. `docker info` then reports:

```
Storage Driver: overlayfs
  driver-type: io.containerd.snapshotter.v1
```

`src/docker-host.js` `supportsStorageOpt()` accepts only:

- driver `overlay2` **and** host mount options matching `\b(?:pquota|prjquota)\b`
- or driver `btrfs` / `zfs`

Driver name `overlayfs` (snapshotter) → `false` → Cat-1 `HOME_GPU_NO_DISK_QUOTA`. Labour does not call this gate.

Proven GPU-box recipe (keep fail-closed; do not auto-rewrite daemon.json from install.sh):

```json
{
  "storage-driver": "overlay2",
  "features": { "containerd-snapshotter": false }
}
```

plus Docker data-root on XFS mounted `-o prjquota` (loop file is OK).

Will Fedora/RHEL Docker 29 do the same? **Yes.** Docker docs state Engine 29.0+ uses the containerd image store by default on fresh installs, with no distro exception. `docker-ce` 29.x is what `download.docker.com` currently ships for Ubuntu noble, Fedora, and RHEL 9 (`5:29.8.0-1~ubuntu.24.04~noble`, `3:29.8.0-1.el9`). Distro `docker.io` / `moby-engine` version decides whether a given host hits it:

| Package (2026-09-04) | Typical driver on fresh install | GPU StorageOpt |
|---|---|---|
| Ubuntu 22.04/24.04/26.04 `docker.io` **29.1.3** (amd64) | `overlayfs` snapshotter | fail-closed until overlay2+XFS |
| Debian 12 `docker.io` **20.10.24** | classic `overlay2` | possible if XFS prjquota |
| Debian 13 `docker.io` **26.1.5** | classic graph driver (pre-29) | possible if XFS prjquota |
| `docker-ce` 29.x (any distro, fresh) | `overlayfs` snapshotter | fail-closed until overlay2+XFS |
| Fedora `moby-engine` | **UNVERIFIED** version/driver; treat as “probe `docker info`” | probe |
| AL2023 `docker` ~25.x | classic (pre-29) | possible if XFS prjquota |

Doctor row: `docker info --format '{{.Driver}}'` + `mount | grep -E 'pquota|prjquota'`. Do not tell labour users to reformat disks.

### 2.5 Architecture

| Arch | Labour | Cat-1 GPU |
|---|---|---|
| `x86_64` / `amd64` | first-class | first-class (NVIDIA toolkit) |
| `aarch64` / `arm64` (Pi, Apple-silicon UTM) | supported if they **build locally** | **no** — do not design NVIDIA on ARM for this product |
| 32-bit (`i386`, `armhf`, `armv7l`) | fail-closed | fail-closed |

`Dockerfile.job-agent` is `FROM node:22-slim`. Official `node:22-slim` is multi-arch (`amd64`, `arm64v8`, plus others). A local `docker build` on aarch64 pulls the arm64 base. Do **not** assume a pre-built amd64 image on Hub will run under QEMU without the operator knowing.

`Dockerfile.gpu-jail` is `FROM debian:bookworm-slim` + sshd. GPU jail is Linux x86_64 + NVIDIA runtime only.

### 2.6 Clock

systemd hosts: `timedatectl status` / `timedatectl set-ntp true`.
WSL extra: Windows host clock; `sudo hwclock -s` or `wsl --shutdown` if skew returns.
OpenRC / busybox / Alpine: **no** `timedatectl` — unsupported family, doctor says so.

Signed API window is tight; ~30s skew already looks like “platform down”.

### 2.7 systemd

Every first-class distro is systemd. `systemctl enable --now docker` is the start/enable line.

Exceptions:

- WSL2 without `[boot] systemd=true` in `/etc/wsl.conf` — service will not stay up. First-class WSL **requires** systemd.
- Snap docker uses `snap.docker.dockerd` not `docker.service`.
- Rootless uses `docker.service` of the **user** manager (`systemctl --user`).

---

## 3. FIRST-CLASS distros

Ubuntu 25.04 (Plucky) and 25.10 (Questing) are **EOL** as of 2026-09-04 (EOL 2026-01-15 and 2026-07-09). Not a first-class branch. If `ID=ubuntu` and `VERSION_ID` is `25.04`/`25.10`, doctor: “Ubuntu interim is EOL; treat as apt-family at your own risk; upgrade to 24.04 or 26.04.”

Ubuntu **26.04 LTS** (Resolute) **is** first-class: it is the current LTS, Docker Engine docs list it, NVIDIA toolkit lists it.

Fedora 40 is EOL (standard Fedora ~13-month window). Keep a `fedora` branch that covers 40–42 as requested; doctor should warn if `VERSION_ID<42`. Fedora 43–44 use the same packages (`docker-ce` / `moby-engine`, `nodejs` metapackage).

---

### 3.1 Ubuntu 22.04 LTS (Jammy)

**Detect:** `ID=ubuntu` `VERSION_ID=22.04` `VERSION_CODENAME=jammy` `ID_LIKE=debian`

**Node:** MUST NOT `apt install nodejs`. Universe `nodejs` is **12.22.9** (`packages.ubuntu.com` jammy / jammy-updates, 2026-09-04). That fails `engines.node >=20` immediately.

Recommended: nvm 22 or official tarball → `~/.local/node`.

**Docker:**

| Item | Value |
|---|---|
| Distro package | `docker.io` (universe). amd64 **29.1.3-0ubuntu3~22.04.2** in jammy-updates/security as of 2026-09-04 → Docker 29 overlayfs trap. arm64 page still listed older builds in one view — **probe `docker version`**, do not assume. |
| Preferred package | `docker-ce` from `https://download.docker.com/linux/ubuntu` suite `jammy` |
| Unit | `docker.service` (+ `docker.socket`) |
| Group | `docker` |
| Sock | `/var/run/docker.sock` |

`get.docker.com` works (Ubuntu is a first-class Docker Engine platform). Still print the native block.

**Permissions:** EACCES after install = not in group yet. ENOENT = `systemctl start docker` not done (rare on Debian-family; get.docker.com starts it). Snap docker on Ubuntu Desktop is a separate ENOENT (sock under `/var/snap/docker/`).

**AppArmor:** on. `apparmor-agent` from secure-setup is the job-agent profile. `gpu-jail` is a Debian sshd image; host AppArmor `docker-default` applies unless overridden. Do not disable AppArmor.

**SELinux:** off (permissive/disabled). Ignore.

**NVIDIA:** Linux x86_64 only. NVIDIA lists Ubuntu 22.04 amd64. Toolkit package `nvidia-container-toolkit` from `nvidia.github.io/libnvidia-container` **deb** repo, then `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`. Needs a working NVIDIA driver on the host first.

**Copy-paste (doctor, labour):**

```bash
# --- Ubuntu 22.04: Docker CE (preferred) ---
# TRUST: adds Docker's apt repo and installs docker-ce as root.
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
echo "Log out and back in, or run: newgrp docker"
```

Labour-only alternative (warn GPU): `sudo apt-get install -y docker.io && sudo systemctl enable --now docker && sudo usermod -aG docker "$USER"`. On 22.04 amd64 this is Docker 29.

**Node copy-paste:** tarball block in §2.1, or nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
# TRUST: nvm install.sh writes to ~/.nvm and your shell rc.
. "$HOME/.nvm/nvm.sh"
nvm install 22
```

**New session:** `newgrp docker` or new terminal. `id -nG | grep -qw docker` must be true before dockerode works.

**systemd:** yes.

---

### 3.2 Ubuntu 24.04 LTS (Noble)

**Detect:** `ID=ubuntu` `VERSION_ID=24.04` `VERSION_CODENAME=noble`

**Node:** MUST NOT `apt install nodejs`. Universe `nodejs` is **18.19.1** (`packages.ubuntu.com` noble, 2026-09-04). This is the mass-market trap (GPU box used tarball → `~/.local/node`).

**Docker:** same names as 22.04. `docker.io` amd64 **29.1.3-0ubuntu3~24.04.2**. `docker-ce` suite `noble`. Docker docs (2026-08-10) use DEB822 `docker.sources`; both one-line `.list` and `.sources` work. Unit/group/sock identical.

**AppArmor:** on (24.04 default). Same notes.

**SELinux:** off.

**NVIDIA:** listed for Ubuntu 24.04 amd64 **and** arm64; J41 GPU is x86_64 only.

**Copy-paste:** same Docker CE block as 22.04; `UBUNTU_CODENAME` is `noble`. Same nvm/tarball Node block. Same `newgrp docker`. systemd yes.

Doctor should mention Ubuntu 24.04 apt sources may already be DEB822 (`/etc/apt/sources.list.d/ubuntu.sources`); that does not change the docker.list stanza.

---

### 3.3 Ubuntu 26.04 LTS (Resolute) — current LTS

**Detect:** `ID=ubuntu` `VERSION_ID=26.04` `VERSION_CODENAME=resolute`

**Node:** Universe `nodejs` is **22.22.1** (`packages.ubuntu.com` resolute, 2026-09-04). This is the first Ubuntu LTS where distro Node satisfies `engines.node >=20`. Installer may **accept** `/usr/bin/node` if ≥20. Still do not *install* distro nodejs as the bootstrap (nvm/tarball remain the written path so 22.04/24.04 operators are not taught two stories).

**Docker:** `docker.io` **29.1.3-0ubuntu4.1** (resolute). Same overlayfs GPU trap. `docker-ce` from Docker’s Ubuntu repo; Docker Engine docs list Resolute 26.04.

**cgroup:** Ubuntu 26.04 is cgroup v2 only (systemd 259 dropped the v1 fallback). Docker 29 is fine with `Cgroup Driver: systemd` / `Cgroup Version: 2`. Ancient `docker.io` 20.10 would not be — not a 26.04 problem.

**AppArmor:** on. **SELinux:** off. **NVIDIA:** listed for 26.04 amd64.

**Copy-paste:** same Docker CE block; suite `resolute`. systemd yes. `newgrp docker` unchanged.

---

### 3.4 Debian 12 (Bookworm)

**Detect:** `ID=debian` `VERSION_ID=12` `VERSION_CODENAME=bookworm`. No `ID_LIKE`. **Do not** use the Ubuntu Docker repo.

**Node:** MUST NOT `apt install nodejs`. Debian `nodejs` is **18.20.4** (`packages.debian.org` bookworm, 2026-09-04). bookworm-backports does not make 22 the default — do not send operators there. nvm or tarball.

**Docker:**

| Item | Value |
|---|---|
| Distro package | `docker.io` **20.10.24+dfsg1-1+deb12u1** — classic, **not** Docker 29. Labour OK. GPU StorageOpt possible with XFS prjquota. |
| Preferred | `docker-ce` from `https://download.docker.com/linux/debian` suite `bookworm` (will be 29.x → overlayfs on fresh CE). |
| Unit / group / sock | `docker.service` / `docker` / `/var/run/docker.sock` |

Debian 12 `docker.io` on non-amd64 is historically poorly supported in package descriptions; amd64 is the labour default. aarch64: prefer `docker-ce` or verify `docker info` after `docker.io`.

**AppArmor:** installed as Recommends of `docker.io`; enable `apparmor` package. secure-setup apt path matches `debian`.

**SELinux:** not default.

**NVIDIA:** NVIDIA’s current support table lists Debian 11, not Debian 12. Toolkit **deb** repo is “most Debian-derived” and often works on bookworm — mark **UNVERIFIED on Debian 12** for GPU. Labour does not need it.

**Copy-paste:**

```bash
# --- Debian 12: Docker CE ---
# TRUST: Docker apt repo as root. For labour-only, `sudo apt-get install -y docker.io` is enough
# and stays on classic overlay2 (20.10).
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $VERSION_CODENAME stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
echo "New terminal or: newgrp docker"
```

**systemd:** yes. **newgrp:** same.

---

### 3.5 Debian 13 (Trixie)

**Detect:** `ID=debian` `VERSION_ID=13` `VERSION_CODENAME=trixie`

**Node:** Distro `nodejs` is **20.19.2** (`packages.debian.org` trixie). Satisfies `>=20`. Accept if already installed. Installer bootstrap still nvm/tarball (Node 20 is EOL upstream as of 2026-04; Debian will keep it patched, we still want 22).

**Docker:** distro `docker.io` **26.1.5+dfsg1-9+deb13u1** (pre-29, classic driver). CE from `download.docker.com/linux/debian` suite `trixie` — **UNVERIFIED whether Docker CE has a trixie suite on 2026-09-04**; if apt update 404s, doctor should say “use `docker.io` or get.docker.com”. Unit/group/sock same.

**AppArmor:** Recommends. **SELinux:** not default.

**NVIDIA:** not on NVIDIA’s tested table (Debian 11 is). GPU **UNVERIFIED**. Labour OK.

**Copy-paste:** same as Debian 12 with `$VERSION_CODENAME` = `trixie`. Fallback:

```bash
sudo apt-get update
sudo apt-get install -y docker.io
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

**systemd:** yes.

---

### 3.6 Fedora 40–42 (same installer branch; warn EOL)

**Detect:** `ID=fedora` `VERSION_ID=40|41|42` (also 43+ with the same recipes). No `ID_LIKE` required.

**Node:** Do not `dnf install nodejs` as the bootstrap. Current Fedora `nodejs` is a **metapackage** pointing at a rolling stream (Fedora 43: `nodejs` → **22.22.2**; Fedora 42+ also ship `nodejs24`). Older Fedora 40 modular Node could be 18 or 20 depending on stream — **if `node -v` < 20, refuse**. nvm or tarball. `dnf install nodejs` on a current Fedora often *is* ≥20 — accept if already present.

**Docker — two real names, do not mix:**

| Package | Source | Notes |
|---|---|---|
| `moby-engine` | Fedora repos | Distro Docker-compatible daemon. `dnf install docker` is **wrong** (no package `docker`). |
| `docker-ce` | `https://download.docker.com/linux/fedora/docker-ce.repo` | Preferred for dockerode/API parity. Conflicts with `moby-engine`. |
| `podman` + `podman-docker` | Fedora default container story | **Unsupported** (no docker.sock / not dockerd). |

DNF syntax split (live Fedora developer docs):

- Fedora **40**: `sudo dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo`
- Fedora **41+**: `sudo dnf config-manager addrepo --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo`

Unit: `docker.service`. Group: `docker`. Sock: `/var/run/docker.sock`. **RPM family does not auto-start Docker** after CE install — `systemctl enable --now docker` is mandatory.

`get.docker.com` works; still must start the unit.

**Permissions:** EACCES = group. ENOENT = unit not started (very common on Fedora). SELinux `Permission denied` on bind mounts is **not** EACCES on the sock — doctor must not conflate them.

**SELinux:** enforcing. This affects job-agent workspace binds and gpu-jail:

- Host bind-mounts need `:z` (shared) or `:Z` (private) or they fail with EACCES inside the container.
- Mounting `docker.sock` into a container is blocked by `container_t` → `container_runtime_t` unless policy allows it. Dispatcher should not need sock-in-container for labour.
- Do **not** recommend `setenforce 0`.
- `container-selinux` must be present (CE pulls it).

**firewalld:** on by default. Docker 20.10+ uses iptables-nft; CE 29 generally coexists. If published ports are unreachable, doctor hint: `sudo firewall-cmd --permanent --zone=trusted --add-interface=docker0 && sudo firewall-cmd --reload` — **UNVERIFIED as still required on F42+CE29**. Labour job-agent does not publish host ports by default.

**NVIDIA:** NVIDIA lists RHEL/Fedora via the **rpm** toolkit repo, not Fedora as a first-class row. Use:

```bash
curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo \
  | sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo
sudo dnf install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

x86_64 only. SELinux + NVIDIA is a known sharp edge; if `docker info` lacks an `nvidia` runtime after install, doctor prints the nvidia-ctk line again, not `setenforce 0`.

**Copy-paste (Fedora 41–42, Docker CE):**

```bash
# --- Fedora 41+: Docker CE ---
# TRUST: Docker's RPM repo as root. Conflicts with moby-engine / podman-docker.
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager addrepo --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
echo "New session required: log out/in or newgrp docker"
```

Fedora 40: replace the `addrepo` line with `sudo dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo`.

moby-engine labour fallback: `sudo dnf install -y moby-engine && sudo systemctl enable --now docker && sudo usermod -aG docker "$USER"`. Doctor still probes `docker info`, not the package name.

**New session:** `newgrp docker` works the same. GNOME may need a full logout for `id -nG` to update.

**systemd:** yes.

**GPU overlayfs:** CE 29 on Fedora = same snapshotter default as Ubuntu. `moby-engine` driver **UNVERIFIED** — probe.

---

### 3.7 RHEL 9 / Rocky 9 / Alma 9

**Detect:**

| Distro | `ID` | `ID_LIKE` | `VERSION_ID` |
|---|---|---|---|
| RHEL 9 | `rhel` | `fedora` | `9` or `9.x` |
| Rocky 9 | `rocky` | `rhel centos fedora` | `9` / `9.x` |
| Alma 9 | `almalinux` | `rhel centos fedora` | `9` / `9.x` |

Use Docker’s **RHEL** repo for all three (`download.docker.com/linux/rhel`), not Fedora’s.

**Node:** RHEL 9 AppStream **has no default module stream**. `dnf install nodejs` without `dnf module enable nodejs:22` (or 20) is a trap: streams include **18** (still common), 20, 22, and on some rebuilds 24. MUST NOT enable `nodejs:18`. Installer path: nvm/tarball. If operator already has `node` ≥20 from `nodejs:20`/`nodejs:22`, accept.

**Docker:** There is **no** first-class `moby-engine` on RHEL 9 the way Fedora has it. Install `docker-ce`:

```bash
# --- RHEL/Rocky/Alma 9: Docker CE ---
# TRUST: Docker RHEL repo as root.
# If dnf 404s on .../rhel/9.4/... pin baseurl to .../rhel/9/$basearch/stable
# (moby#49169). get.docker.com hits the same layout.
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
echo "New session required: newgrp docker"
```

Unit `docker.service`, group `docker`, sock `/var/run/docker.sock`. **Must** start the unit (RPM family).

**SELinux:** enforcing. Same `:z` / do-not-disable rules as Fedora. `container-selinux` required.

**firewalld:** on. Same optional docker0 hint, **UNVERIFIED**.

**NVIDIA:** NVIDIA lists RHEL 9.x amd64 (and arm64 — we ignore ARM GPU). rpm toolkit repo. x86_64 only.

**AppArmor:** not used.

**systemd:** yes. **newgrp:** same.

**GPU overlayfs:** CE 29.x (`3:29.8.0-1.el9` listed on Docker’s RHEL install page) → snapshotter default on fresh install. Same daemon.json recipe as Ubuntu.

---

### 3.8 WSL2 Ubuntu (Windows 11 host)

**Detect:** Linux `ID=ubuntu` **plus** `WSL_DISTRO_NAME` or `/proc/version` matching Microsoft. `VERSION_ID` 22.04 / 24.04 / 26.04 are first-class. Debian-on-WSL is best-effort.

This is **not** native Windows. `dockerode` must talk to a Linux sock, never `npipe:////./pipe/docker_engine`.

**Two Docker stories — pick one, doctor must say which is live:**

| Mode | Daemon | Sock dockerode sees | Installer |
|---|---|---|---|
| **A. Engine inside WSL** (preferred for J41) | `dockerd` via systemd in the distro | `/var/run/docker.sock` | Ubuntu docker-ce / docker.io block **inside** WSL |
| **B. Docker Desktop WSL integration** | Desktop VM on Windows | Desktop injects CLI + often a different sock/context (`desktop-linux`) | Do **not** also `apt install docker.io`. Doctor: “disable Desktop WSL integration or uninstall in-distro docker” |

Symptoms when both are on: missing `/var/run/docker.sock`, `docker context ls` shows `desktop-linux`, `host.docker.internal` points at Desktop’s VM. Fail closed with that explanation.

**systemd:** required. `/etc/wsl.conf`:

```ini
[boot]
systemd=true
```

then from Windows: `wsl --shutdown` and reopen. Older WSL without systemd is **not** first-class (`service docker start` is a trap; unit will not survive).

**cgroup:** WSL ≥ 2.5.1 defaults to cgroup v2. Docker 29 is fine. Very old WSL hybrid v1/v2: **UNVERIFIED**, doctor should print `stat -fc %T /sys/fs/cgroup` (`cgroup2fs` expected).

**Node:** same Ubuntu trap as the VERSION_ID (12 on 22.04, 18 on 24.04). nvm/tarball **inside WSL**, not Windows Node, not `/mnt/c/.../node.exe`.

**Never** put Docker data-root, job bind-mounts, or `~/.j41` on `/mnt/c`. 9p/drvfs + overlay = corruption and overlay-incompatible uppers.

**Clock:** WSL drifts vs Windows. `timedatectl set-ntp true` often cannot hold. Doctor: if skew > 30s, print `sudo hwclock -s` and “from Windows: `wsl --shutdown`”.

**NVIDIA:** not a WSL first-run GPU path. CUDA-in-WSL exists; J41 Cat-1 assumes a Linux GPU host with `docker.sock` on the card machine. Doctor: GPU unsupported on WSL.

**Copy-paste (Engine inside WSL Ubuntu 24.04):** the Ubuntu 24.04 Docker CE block, run **in the WSL shell**, plus:

```bash
# /etc/wsl.conf must have [boot] systemd=true  (then wsl --shutdown from Windows)
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
# close this terminal; open a new WSL tab. If id -nG still lacks docker:
#   Windows:  wsl --shutdown
newgrp docker
```

If Desktop is installed and integration is on, print:

```
Docker Desktop WSL integration is active (docker context: desktop-linux).
J41 expects Engine inside this distro. Either:
  • Desktop → Settings → Resources → WSL integration → off for this distro
    then install docker-ce inside WSL (block above)
  • or set DOCKER_HOST to the Desktop-forwarded sock and accept Desktop as the engine
    (labour only; GPU unsupported)
```

**newgrp:** same, but WSL often needs a full distro restart.

**Permissions:** ENOENT is the Desktop/engine split, not “apt install docker”. EACCES is still the docker group.

---

## 4. SUPPORTED BEST-EFFORT

Doctor **classifies** these. Installer may print generic Node tarball + `get.docker.com` (with sudo/trust preamble). No CI promise.

### 4.1 Arch / Manjaro

**Detect:** `ID=arch` or `ID=manjaro` `ID_LIKE=arch`.

**Node:** Arch `nodejs` is usually current (rolling). Accept if ≥20. Still do not `pacman -S nodejs` as the written installer path (rolling major bumps). nvm/tarball OK.

**Docker:** package **`docker`** (not `docker.io`, not `docker-ce`). `pacman -S docker`. Unit `docker.service`. Group `docker`. Sock `/var/run/docker.sock`. Enable: `sudo systemctl enable --now docker.service`. Optional `docker-compose` `docker-buildx`. Arch extra currently ships Docker **29.7.2** (`archlinux.org/packages`, 2026-09-04) → overlayfs GPU trap.

```bash
# --- Arch/Manjaro (best-effort) ---
sudo pacman -S docker
sudo systemctl enable --now docker.service
sudo usermod -aG docker "$USER"
newgrp docker
```

**SELinux:** no. **AppArmor:** optional/uncommon. **NVIDIA:** Arch `nvidia-container-toolkit` in extra or nvidia’s rpm-on-arch — **UNVERIFIED**. GPU best-effort only.

### 4.2 openSUSE Leap / Tumbleweed

**Detect:** `ID=opensuse-leap` or `ID=opensuse-tumbleweed` (`ID_LIKE` contains `suse`).

**Node:** zypper `nodejs*` versions vary by Leap; **UNVERIFIED exact Leap 15.6/16 node**. nvm/tarball.

**Docker:** package **`docker`**. `sudo zypper install docker`. Unit `docker.service`. Group `docker`. Sock `/var/run/docker.sock`. Docker Inc **does not** ship an openSUSE CE repo; distro package is the path. Tumbleweed examples show Docker 29.x-ce from OBS.

```bash
sudo zypper install docker
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
newgrp docker
```

Do not install `podman-docker` alongside (file conflict on `/usr/bin/docker`).

**SELinux:** Leap can enable it; Tumbleweed AppArmor is more common — **probe** `getenforce` / `aa-status`. **NVIDIA:** NVIDIA lists OpenSUSE/SLES 15.x amd64.

### 4.3 Amazon Linux 2023

**Detect:** `ID=amzn` `VERSION_ID=2023`.

**Node:** `dnf install nodejs` is **18.x** (nodejs 18 still in AL2023 repos). `nodejs20` / `nodejs22` exist via alternatives (`dnf install nodejs22`). MUST NOT use unversioned `nodejs` if it is 18. Installer: nvm/tarball or `nodejs22` if already chosen. NodeSource on AL2023 has a history of GPG failures — avoid.

**Docker:** package **`docker`** (`sudo dnf install docker`), not `docker-ce` / `moby-engine`. Unit `docker.service`. Group `docker`. Sock `/var/run/docker.sock`. Version ~25.x in 2023.6 notes — pre-29, classic driver likely.

```bash
sudo dnf install -y docker
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
newgrp docker
```

**SELinux:** enforcing (AL2023). **NVIDIA:** listed for AL2023 amd64. **systemd:** yes.

### 4.4 Linux Mint / Pop!_OS (Ubuntu derivatives)

**Detect via `ID` + `ID_LIKE` + `UBUNTU_CODENAME`:**

| Distro | `ID` | `ID_LIKE` | Docker/Node suite |
|---|---|---|---|
| Linux Mint (Ubuntu edition) | `linuxmint` | `ubuntu debian` | use `UBUNTU_CODENAME` (e.g. Mint 22.x → `noble`) |
| LMDE | `linuxmint` | `debian` **only** | Debian bookworm/trixie recipe, **not** Ubuntu |
| Pop!_OS | `pop` | `ubuntu debian` | `UBUNTU_CODENAME` (focal/jammy/noble/…) |

This is why `if apt-get` is wrong: Mint 22 wants Docker’s **Ubuntu noble** repo, not a fictional `linuxmint` suite; LMDE wants **Debian**.

Node: same trap as the parent (Mint 22 / noble → Node 18). nvm/tarball.

Docker: Ubuntu (or Debian for LMDE) first-class block, substituting `UBUNTU_CODENAME`. `get.docker.com` usually does this if os-release is intact.

Pop NVIDIA: System76 images often already have drivers; toolkit still needed for `docker info` nvidia runtime. GPU **UNVERIFIED** on Pop.

---

## 5. EXPLICIT UNSUPPORTED (doctor fail-closed)

Print a one-line reason. Do not print a sudo install block that pretends it will work.

| Target | Reason | Doctor |
|---|---|---|
| Alpine / musl (`ID=alpine`) | Official Node tarball is glibc; nvm on musl is a science project; secure-setup has no apk path | fail: “musl is unsupported” |
| NixOS | Declarative; no apt/dnf; docker is `virtualisation.docker.enable` in configuration.nix. No honest curl\|bash | fail: “use configuration.nix; installer will not mutate NixOS” |
| Gentoo | Portage; no installer branch | fail |
| Clear Linux | `swupd`; not in Docker Engine matrix | fail |
| Immutable ostree (Silverblue, Kinoite, `rpm-ostree`, `/run/ostree-booted`) | Layering `docker`/`moby-engine` is a reboot + overlay story; data-root and StorageOpt are different. Not `dnf install` | fail: “immutable ostree: not supported; use a mutable Fedora/RHEL host” |
| Podman-only (`podman-docker`, no `docker.sock`) | dockerode + gVisor `runsc` registration + nvidia-ctk `--runtime=docker` assume **dockerd**. Default **NO** until someone proves dockerode against `podman.socket` for labour **and** GPU | fail: “need Docker Engine (docker.sock), not Podman” |
| snap Docker | Classic confinement, cgroup warnings, sock often `/var/snap/docker/common/run/docker.sock` not `/var/run/docker.sock`; dockerode default ENOENT | fail or warn: “uninstall snap docker; install docker-ce or docker.io” |
| Rootless Docker | StorageOpt / nvidia / our hardening assume rootful `dockerd`. Sock is `$XDG_RUNTIME_DIR/docker.sock`. fuse-overlayfs is common | fail (GPU) / warn (labour): “rootful Docker Engine required” |
| 32-bit | `uname -m` not x86_64/aarch64 | fail |
| Ubuntu 25.04/25.10 | EOL | warn + treat as unknown Ubuntu, not a branch |
| macOS ≤13, native Windows | §8 | fail with the Darwin/Win32 message, not a Linux block |

---

## 6. Isolation add-on (not install.sh, but doctor should know)

`@junction41/secure-setup` (optionalDependency):

| Tool | Ubuntu/Debian/Mint/Pop | Fedora/RHEL/Rocky/Alma/AMZN | Arch/SUSE |
|---|---|---|---|
| bubblewrap | `apt-get install bubblewrap` | `dnf install bubblewrap` | `pacman -S bubblewrap` / `zypper in bubblewrap` |
| gVisor `runsc` | apt repo + bundled keyring (`install-gvisor.js`) | **`dnf install runsc` is wishful** — no stock package; use pinned binary | pinned binary |

gVisor configure writes `/etc/docker/daemon.json` `default-runtime: runsc` and `systemctl restart docker`. That can **fight** the GPU overlay2 recipe (both edit daemon.json). GPU hosts: do not let secure-setup clobber `storage-driver` / `features.containerd-snapshotter`. Labour-only: gVisor is fine.

AppArmor profiles (`apparmor-agent`) load only on AppArmor distros. SELinux hosts skip them.

---

## 7. NVIDIA (Linux x86_64 only)

Do not design Mac/Windows GPU. Do not design aarch64 GPU for J41.

Shared post-install:

```bash
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
docker info --format '{{json .Runtimes}}'   # must match /nvidia/i
```

Then StorageOpt: `overlay2` + XFS prjquota (or btrfs/zfs), `containerd-snapshotter: false` on Engine 29.

Toolkit repos (official, 2026-02 docs, version pin example 1.18.2-1 — pin at implement time):

- Debian-family: `https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list`
- RPM-family: `https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo`

NVIDIA tested table includes Ubuntu 22.04/24.04/26.04, RHEL 9/10, Rocky 9.7, AL2023, SLES 15. Fedora/Debian 12/13/Arch: try the generic repo, doctor marks GPU **UNVERIFIED** if `Runtimes` lacks nvidia.

---

## 8. Mac / Windows — installer boundaries only

These are **not** distros. `scripts/install.sh` must `case $(uname -s)` **before** any apt/dnf/nvm-tarball Linux copy.

| OS | Installer | Docker | Node | GPU |
|---|---|---|---|---|
| macOS 14+ (Sonoma and later) | Darwin branch or a separate script; **not** Linux `install.sh` | Docker Desktop. Sock is often `~/.docker/run/docker.sock`, not `/var/run/docker.sock`. `brew install docker` is CLI-only — not a daemon. | nvm (no official tarball path). Homebrew `node` OK if ≥20 | **no** (Desktop is a Linux VM without XFS prjquota as a first-run path) |
| macOS 13 Ventura and older | **fail-closed** | — | — | — |
| Windows 11 | `install.ps1` that only bootstraps **WSL2 Ubuntu** | Engine inside WSL (§3.8) or Desktop WSL integration | Node inside WSL, not `node.exe` | **no** |
| Native Win32 (`j41-dispatcher.exe`, named pipes, Hyper-V Docker) | **out** | — | — | — |

Colima/OrbStack: doctor hints, not installer defaults.

Full Darwin/Win32 installer behaviour, sock probe list, and Desktop version gates live in the **platform spec-kit** (companion to this doc). This file does not expand them.

---

## 9. `scripts/install.sh` implementation sketch

Goals: Node 22 on PATH, Docker Engine usable by dockerode, **never** write `runtime=local`, honest failure on `curl | bash`.

```
main:
  require bash, curl, tar, uname
  detect_os                    # §1  — exit 1 on Darwin/Win32/32-bit/unsupported ID
  ensure_path_hooks            # ~/.local/bin + node origin
  ensure_node                  # accept ≥20, else nvm, else tarball; never distro nodejs <20
  ensure_yarn                  # npm install -g yarn@1.22.22
  ensure_docker                # probe; if missing PRINT family sudo block; do not curl|sh unless opted in
  install_dispatcher           # npm i -g @junction41/dispatcher  OR clone the LIVE repo
                               # do not clone into ~/.j41/dispatcher
  print_next_steps             # doctor, build-image, dashboard — not init -n 9
```

### `detect_os()`

Source `/etc/os-release`. Set `J41_OS_FAMILY` to `ubuntu|debian|fedora|rhel9|wsl-ubuntu|arch|suse|amzn|unsupported`. WSL overrides family after ID. Print `ID VERSION_ID arch wsl=yes/no`.

### `ensure_node()`

```
if node >= 20: ok
else if nvm present: nvm install 22
else if linux x86_64|aarch64: tarball → ~/.local/node
else: exit 1 with distro-specific “do not apt install nodejs (this distro ships vX)”
```

Refuse to run NodeSource. If `node` is 12 or 18 from apt, print the exact bad version from §3 and the tarball/nvm block.

### `ensure_docker()`

```
classify:
  sock missing          → ENOENT
  sock EACCES           → print newgrp block, exit 1 (do not install a second docker)
  snap                  → fail-closed
  rootless              → fail/warn per §5
  podman-only           → fail-closed
  docker info ok        → success (do not reinstall)

if missing and interactive:
  print the family sudo block from §3
  print get.docker.com alternative WITH sudo + trust sentence
  do not run it unless user types yes
  after install: enable --now on RPM; usermod; tell them to re-run install.sh in a new grp

if missing and non-interactive (curl|bash, ! -t 0):
  if J41_ALLOW_NO_DOCKER=1:
    print warning
    do NOT write runtime=local
    do NOT write config.json/toml
    exit 0 only after saying “dispatcher will refuse start until Docker works
           (or start --dev-unsafe; see docs)”
    # J41_ALLOW_NO_DOCKER is a skip for CI/image baking, not a runtime=local persistence
  else:
    print the sudo block
    exit 1
```

**Never** `echo runtime=local` into `~/.j41/dispatcher/config.json`.
**Never** default `CHOICE=2`.
`--dev-unsafe` is a `start` flag, documented, not an installer default.

### Repo / package install

Do not use the 404 GitHub URL. Prefer `npm install -g @junction41/dispatcher` once Node≥20 exists (writable prefix). Git clone, if kept, must use the live remote and a directory that is **not** `~/.j41/dispatcher`.

### Image build

If docker info works: `j41-dispatcher build-image` (or `scripts/build-image.sh` from a clone). Failure is non-fatal for install.sh but doctor must show the image missing (start already fail-closes before accepting jobs).

---

## 10. Doctor copy-paste contract

`j41-dispatcher doctor` does not exist yet (jailbox/connect have a doctor). When added, each Docker/Node miss must print **the block for the detected family**, not a generic “install Docker”.

Minimum rows:

| Row | Pass | Fail copy |
|---|---|---|
| os | `ID VERSION_ID arch` | unsupported reason from §5 |
| node | version ≥20 + origin | exact distro trap version + nvm/tarball block |
| yarn | 1.22.x on PATH | `npm install -g yarn@1.22.22` |
| docker sock | `docker info` as user | ENOENT vs EACCES vs snap vs Desktop vs unit-disabled |
| docker group | `id -nG` contains docker | `usermod` + `newgrp docker` |
| docker driver | labour: any working driver. GPU: overlay2+prjquota \| btrfs \| zfs | overlayfs snapshotter → GPU fail text, labour OK |
| clock | skew < 30s | `timedatectl set-ntp true` / WSL hwclock |
| cgroup | cgroup2fs | WSL systemd hint |
| nvidia | GPU only | toolkit block; skip on labour |
| image | `j41-job-agent` present | `build-image` |

TUI (`src/dashboard.js`) must use the same classifiers. Do not suggest `config --runtime local` except as `--dev-unsafe` documentation.

---

## 11. Acceptance table — distro × Node × Docker × doctor

Legend: **T** = tarball `~/.local/node`, **N** = nvm 22, **A** = accept distro node if ≥20. **CE** = docker-ce. **dio** = distro docker.io/docker/moby. **G** = GPU extra.

| Distro | Class | Node install | Distro node (do not bootstrap) | Docker install | Unit | Doctor expected |
|---|---|---|---|---|---|---|
| Ubuntu 22.04 | first | T or N | **12.22.9** | CE preferred; dio 29.x OK labour | `docker.service` | Node trap 12; dio 29 → overlayfs G fail; EACCES → newgrp |
| Ubuntu 24.04 | first | T or N | **18.19.1** | CE preferred; dio 29.x OK labour | `docker.service` | Node trap 18; same Docker 29 G; AppArmor on |
| Ubuntu 26.04 | first | T/N or A | **22.22.1** (OK if present) | CE or dio 29.x | `docker.service` | Accept node 22; still overlayfs G on 29 |
| Ubuntu 25.04/25.10 | no | — | EOL | — | — | fail/warn EOL |
| Debian 12 | first | T or N | **18.20.4** | dio 20.10 labour; CE 29 G trap | `docker.service` | Node trap 18; dio classic overlay2 |
| Debian 13 | first | T/N or A | **20.19.2** (OK, prefer 22) | dio 26.1 labour; CE if suite exists | `docker.service` | Accept node 20; CE suite **UNVERIFIED** |
| Fedora 40 | first* | T or N | may be <20 | CE (dnf4 `--add-repo`) or moby-engine | `docker.service` **start required** | EOL warn; SELinux; ENOENT if unit down |
| Fedora 41–42 | first | T/N or A | metapackage often 22 | CE (`addrepo --from-repofile`) or moby | `docker.service` start required | SELinux `:z`; firewalld hint; CE29 G |
| RHEL/Rocky/Alma 9 | first | T or N | module 18 trap; enable 22 or tarball | CE from **rhel** repo; pin `/9/` if 404 | `docker.service` start required | no default module stream; SELinux; CE29 G |
| WSL2 Ubuntu 22.04/24.04/26.04 | first | T or N (in WSL) | same as parent Ubuntu | Engine **inside** WSL **or** Desktop, not both | systemd in `/etc/wsl.conf` | Desktop vs sock; clock; no `/mnt/c`; no GPU |
| Arch/Manjaro | best | A if ≥20 else T/N | rolling | `pacman -S docker` | `docker.service` | classify; Docker 29 G |
| openSUSE Leap/TW | best | T or N | **UNVERIFIED** | `zypper install docker` | `docker.service` | no get.docker.com suite; conflict w/ podman-docker |
| Amazon Linux 2023 | best | T/N or `nodejs22` | unversioned **nodejs=18** | `dnf install docker` | `docker.service` start required | Node 18 trap; SELinux |
| Mint (Ubuntu) | best | as parent Ubuntu | as `UBUNTU_CODENAME` | Ubuntu CE using **UBUNTU_CODENAME** | `docker.service` | must not use ID=linuxmint as Docker suite |
| LMDE | best | as Debian | Debian node | Debian CE/dio | `docker.service` | ID_LIKE=debian only |
| Pop!_OS | best | as parent Ubuntu | as Ubuntu | Ubuntu CE via `UBUNTU_CODENAME` | `docker.service` | ID=pop |
| Alpine, NixOS, Gentoo, Clear, ostree, podman-only, snap docker, rootless, 32-bit | no | — | — | — | — | fail-closed with §5 reason |
| macOS 14+ / Win11 WSL | boundary | nvm / WSL node | — | Desktop / WSL Engine | — | spec-kit; no Linux copy |

\*Fedora 40 branch exists so the dnf4 flag is coded; doctor warns EOL.

---

## 12. Evidence (2026-09-04) and UNVERIFIED list

**Verified live:**

- Ubuntu jammy `nodejs` 12.22.9 — packages.ubuntu.com
- Ubuntu noble `nodejs` 18.19.1 — packages.ubuntu.com
- Ubuntu resolute `nodejs` 22.22.1 — packages.ubuntu.com
- Ubuntu jammy/noble/resolute `docker.io` 29.1.3.x — packages.ubuntu.com
- Debian bookworm `nodejs` 18.20.4 — packages.debian.org
- Debian trixie `nodejs` 20.19.2 — packages.debian.org
- Debian bookworm `docker.io` 20.10.24 — packages.debian.org
- Debian trixie `docker.io` 26.1.5 — packages.debian.org
- Docker Engine install matrix: Ubuntu 22.04/24.04/26.04, Debian, Fedora, RHEL 8/9/10; CE 29.8.0 listed for noble and el9
- Docker Engine 29 default containerd snapshotter / `overlayfs` — docs.docker.com storage + Ubuntu Server docker storage docs
- Fedora: no package named `docker`; `moby-engine` vs `docker-ce`; DNF4 vs DNF5 repo flags — developer.fedoraproject.org + Fedora discussion
- Arch package `docker` 29.7.2, units `docker.service`/`docker.socket` — archlinux.org
- openSUSE package `docker`, `systemctl enable docker`, group `docker` — en.opensuse.org/Docker
- AL2023: `dnf install docker`, `dnf install nodejs` is 18, `nodejs22` exists — AWS release notes + AL2023 issues
- NVIDIA toolkit deb/rpm generic repos; tested OS table includes Ubuntu 22.04/24.04/26.04, RHEL 9, Rocky 9.7, AL2023 — docs.nvidia.com
- Ubuntu 25.04/25.10 EOL; 26.04 current LTS — ubuntu.com release list
- `node:22-slim` multi-arch amd64/arm64 — nodejs/docker-node
- Mint `ID=linuxmint` `ID_LIKE="ubuntu debian"` `UBUNTU_CODENAME=noble` — os-release examples
- Pop `ID=pop` `ID_LIKE="ubuntu debian"`
- WSL systemd via `/etc/wsl.conf` — Microsoft Learn
- secure-setup distro lists — `install-bwrap.js` / `install-gvisor.js`
- `supportsStorageOpt` overlay2-only — `src/docker-host.js`
- `FROM node:22-slim` — `Dockerfile.job-agent`
- installer silent `runtime=local` — `scripts/install.sh:97–100`

**UNVERIFIED (implementer must probe or re-check):**

- Exact Ubuntu 25.04 `nodejs` version (EOL; not a branch)
- Whether `download.docker.com/linux/debian` has a **trixie** suite
- Fedora `moby-engine` version and default storage driver on F42
- Whether firewalld still needs docker0 trusted zone on F42 + CE 29
- NVIDIA toolkit on Debian 12/13, Fedora, Arch (not on NVIDIA’s tested table)
- openSUSE Leap 15.6/16 exact `nodejs` / `docker` versions
- AL2023 `docker` package current version (was 25.0.x in 2023.6 notes)
- Snap docker sock path on Ubuntu 24.04/26.04 (historically `/var/snap/docker/common/run/docker.sock`)
- dockerode against `podman.socket` (default NO regardless)
- gVisor `dnf install runsc` on any current Fedora/RHEL (almost certainly missing)

---

## 13. Implementation order (suggested, not this PR)

1. `detect_os()` + doctor classifiers (ENOENT/EACCES/snap/overlayfs/Node version) — no sudo.
2. `ensure_node()` tarball/nvm; delete NodeSource and distro-nodejs branches from install.sh.
3. `ensure_docker()` print-blocks per family; delete silent `runtime=local`; `exit 1` on curl|bash without Docker.
4. Fix clone URL / stop installing into `~/.j41/dispatcher`.
5. WSL systemd + Desktop-vs-engine copy.
6. GPU overlay2 docs + existing quota script; still fail-closed in `supportsStorageOpt`.

Do not commit this file as a behaviour change. It is the map for the engineer who will touch `scripts/install.sh` and doctor strings.
