#!/usr/bin/env bash
#
# J41 Dispatcher mass-use installer
#   curl -fsSL https://raw.githubusercontent.com/autobb888/j41-sovagent-dispatcher/main/scripts/install.sh | bash
#
# Installs Node 22 (never distro nodejs), then @junction41/dispatcher into a
# user prefix. Does not clone git. Does not write a process-mode runtime.
# Missing Docker prints a copy-paste block and exits 1.
#
set -euo pipefail

NODE_PIN="22.19.0"
NODE_SHA_X64="c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2"
NODE_SHA_ARM64="0b2d9f564b6594222a62c82e1df2efe119dd4a4aff29644f4dd325bf360b6bcc"
PKG="@junction41/dispatcher"
PKG_VER="${J41_DISPATCHER_VERSION:-}"

echo "╔══════════════════════════════════════════╗"
echo "║     J41 Dispatcher Installer             ║"
echo "╚══════════════════════════════════════════╝"
echo ""

die() { echo "  ❌ $*" >&2; exit 1; }

os_family() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Linux) echo linux ;;
    Darwin) echo darwin ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) echo windows ;;
    *) echo unknown ;;
  esac
}

append_path_line() {
  local line='export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"'
  local rc
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -f "$rc" ] && grep -qF '.local/node/bin' "$rc" 2>/dev/null; then
      return 0
    fi
  done
  rc="$HOME/.bashrc"
  [ -f "$HOME/.zshrc" ] && [ ! -f "$HOME/.bashrc" ] && rc="$HOME/.zshrc"
  mkdir -p "$HOME"
  touch "$rc"
  if ! grep -qF '.local/node/bin' "$rc" 2>/dev/null; then
    printf '\n# j41-dispatcher\n%s\n' "$line" >> "$rc"
    echo "  ✓ Added ~/.local/node/bin and ~/.local/bin to $rc"
  fi
}

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -p "parseInt(process.versions.node.split('.')[0],10)" 2>/dev/null || echo 0
}

ensure_node() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh" || true
  fi
  if [ -x "$HOME/.local/node/bin/node" ]; then
    export PATH="$HOME/.local/node/bin:$PATH"
  fi

  local major
  major="$(node_major)"
  if [ "$major" -ge 20 ]; then
    echo "  ✓ Node.js $(node --version)  ($(command -v node))"
    return 0
  fi

  local fam
  fam="$(os_family)"
  if [ "$fam" = darwin ]; then
    if command -v brew >/dev/null 2>&1; then
      echo "  → Installing Node 22 via Homebrew (node@22)…"
      brew install node@22
      brew link --overwrite --force node@22 2>/dev/null || true
      export PATH="$(brew --prefix node@22)/bin:$PATH"
      major="$(node_major)"
      [ "$major" -ge 20 ] && echo "  ✓ Node.js $(node --version)" && return 0
    fi
    die "Need Node 20+ (22 recommended). On macOS 14+: https://nodejs.org/  or  brew install node@22
  Do not use a distro/system Node older than 20."
  fi

  if [ "$fam" != linux ]; then
    die "Need Node 20+. Install from https://nodejs.org/ then re-run."
  fi

  command -v curl >/dev/null 2>&1 || die "curl is required to install Node 22"
  command -v tar >/dev/null 2>&1 || die "tar is required to install Node 22"
  local arch narch sha
  arch="$(uname -m)"
  case "$arch" in
    x86_64) narch=x64; sha="$NODE_SHA_X64" ;;
    aarch64|arm64) narch=arm64; sha="$NODE_SHA_ARM64" ;;
    *) die "unsupported Linux arch $arch (need x86_64 or aarch64)" ;;
  esac

  echo "  → Installing Node ${NODE_PIN} tarball → ~/.local/node (checksum pinned)"
  local tmp tarball
  tmp="$(mktemp -d)"
  tarball="$tmp/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v${NODE_PIN}/node-v${NODE_PIN}-linux-${narch}.tar.xz" -o "$tarball"
  echo "${sha}  ${tarball}" | sha256sum -c -
  mkdir -p "$HOME/.local"
  tar -xJ -C "$tmp" -f "$tarball"
  rm -rf "$HOME/.local/node"
  mv "$tmp/node-v${NODE_PIN}-linux-${narch}" "$HOME/.local/node"
  rm -rf "$tmp"
  export PATH="$HOME/.local/node/bin:$PATH"
  append_path_line
  major="$(node_major)"
  [ "$major" -ge 20 ] || die "Node install did not produce Node 20+"
  echo "  ✓ Node.js $(node --version)  (~/.local/node)"
}

print_docker_block() {
  local fam id like
  fam="$(os_family)"
  echo ""
  echo "  Docker is required. Jobs run in containers — there is no mass-use"
  echo "  path without a Docker engine. Do not switch the dispatcher to"
  echo "  process mode for public jobs."
  echo ""
  if [ "$fam" = darwin ]; then
    cat <<'EOF'
  macOS 14+: install Docker Desktop, start it, wait until `docker info` works.
    https://docs.docker.com/desktop/setup/install/mac-install/
  Then re-run this installer (or: npm install -g @junction41/dispatcher && j41-dispatcher doctor)
EOF
    return
  fi
  if [ "$fam" = windows ]; then
    cat <<'EOF'
  Windows: install Docker Desktop with the WSL2 backend, open Ubuntu in WSL,
  then run this installer inside WSL. Native PowerShell is not a first-class path.
EOF
    return
  fi
  id=""; like=""
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    id="$(. /etc/os-release; echo "${ID:-}")"
    like="$(. /etc/os-release; echo "${ID_LIKE:-}")"
  fi
  echo "  Copy-paste (needs sudo). Then open a NEW terminal (group docker):"
  echo ""
  case "$id" in
    ubuntu|debian|linuxmint|pop)
      cat <<'EOF'
    sudo apt-get update
    sudo apt-get install -y docker.io
    sudo systemctl enable --now docker
    sudo usermod -aG docker "$USER"
    # then: newgrp docker   OR close this terminal and open a new one
EOF
      ;;
    fedora)
      cat <<'EOF'
    sudo dnf install -y docker
    sudo systemctl enable --now docker
    sudo usermod -aG docker "$USER"
    # then: newgrp docker   OR a new terminal
EOF
      ;;
    rhel|rocky|almalinux|centos)
      cat <<'EOF'
    # RHEL-family: enable Docker CE, then:
    sudo dnf install -y docker-ce docker-ce-cli containerd.io
    sudo systemctl enable --now docker
    sudo usermod -aG docker "$USER"
EOF
      ;;
    *)
      cat <<EOF
    Distro id=${id:-?} like=${like:-?}
    Install a Docker Engine (not snap docker), enable the unit, add your user
    to group docker, then open a new terminal.
    Official convenience script (trust decision, needs root — we do not run it):
      https://get.docker.com
EOF
      ;;
  esac
  echo ""
  echo "  After Docker works:  j41-dispatcher doctor"
  echo "  EACCES on /var/run/docker.sock means open a new terminal, not reinstall."
}

ensure_os() {
  local fam
  fam="$(os_family)"
  if [ "$fam" = windows ]; then
    print_docker_block
    die "Use Ubuntu on WSL2 + this installer. Native Windows is not first-class."
  fi
  if [ "$fam" = darwin ]; then
    local k
    k="$(uname -r | cut -d. -f1)"
    if [ "${k:-0}" -lt 23 ]; then
      die "macOS 14+ (Darwin 23+) is required. Current Docker Desktop does not support this macOS.
  Upgrade, or use a Linux host."
    fi
  fi
  if [ "$fam" != linux ] && [ "$fam" != darwin ]; then
    die "unsupported OS $(uname -s 2>/dev/null)"
  fi
}

npm_user_install() {
  local spec="$PKG"
  [ -n "$PKG_VER" ] && spec="${PKG}@${PKG_VER}"
  mkdir -p "$HOME/.local"
  export PATH="$HOME/.local/bin:$PATH"
  echo "  → npm install -g --prefix ~/.local ${spec}"
  npm uninstall -g --prefix "$HOME/.local" j41-dispatcher >/dev/null 2>&1 || true
  npm install -g --prefix "$HOME/.local" "$spec"
  append_path_line
  export PATH="$HOME/.local/bin:$PATH"
  command -v j41-dispatcher >/dev/null 2>&1 || die "j41-dispatcher not on PATH after npm install (check ~/.local/bin)"
  echo "  ✓ $(j41-dispatcher --version 2>/dev/null || echo installed)"
}

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "  ✗ docker CLI not found"
    print_docker_block
    return 1
  fi
  if docker info >/dev/null 2>&1; then
    echo "  ✓ Docker daemon reachable"
    return 0
  fi
  local err
  err="$(docker info 2>&1 | tail -n 5 || true)"
  if echo "$err" | grep -qiE 'permission denied|EACCES'; then
    echo "  ✗ Docker is installed but this session cannot use the socket (not in group docker)."
    echo "    Next:  newgrp docker    OR open a new terminal"
    echo "    Then:  j41-dispatcher doctor"
    return 1
  fi
  echo "  ✗ Docker CLI found but the daemon is not running"
  print_docker_block
  return 1
}

# ── main ──────────────────────────────────────────────────────────────────
ensure_os
echo "→ Node.js"
ensure_node

if [ "${J41_SKIP_NPM:-}" != "1" ]; then
  echo ""
  echo "→ Dispatcher package"
  npm_user_install
else
  echo "  (J41_SKIP_NPM=1 — skipping npm)"
fi

echo ""
echo "→ Docker"
if ! check_docker; then
  echo ""
  echo "  Installer stopped: Docker is required. The dispatcher was"
  echo "  $( [ "${J41_SKIP_NPM:-}" = 1 ] && echo 'not installed (dry run)' || echo 'installed' )."
  echo "  After Docker works, run:  j41-dispatcher doctor"
  exit 1
fi

if [ "${J41_SKIP_NPM:-}" != "1" ] && command -v j41-dispatcher >/dev/null 2>&1; then
  if j41-dispatcher build-image; then
    echo "  ✓ job images built"
  else
    echo "  ⚠️  build-image failed — run: j41-dispatcher build-image"
  fi
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     Installation Complete                ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Next:"
echo "  j41-dispatcher doctor"
echo "  j41-dispatcher dashboard"
echo "  j41-dispatcher setup agent-1 <name> --template code-review"
echo ""
echo "If this is a new shell, reload PATH:"
echo "  export PATH=\"\$HOME/.local/node/bin:\$HOME/.local/bin:\$PATH\""
echo ""
