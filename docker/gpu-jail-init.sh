#!/bin/sh
# Pid 1. SYS_ADMIN is granted only so we can lift Docker's hosts/hostname/resolv
# binds onto the overlay (those binds sit on the host docker-xfs image). Drop
# SYS_ADMIN before sshd so the renter never has it. Fail closed if capsh is missing.
set -e
for f in /etc/resolv.conf /etc/hosts /etc/hostname; do
  [ -e "$f" ] || continue
  cp "$f" "/run/$(basename "$f")"
  umount "$f" 2>/dev/null || umount -l "$f" 2>/dev/null || true
  cp "/run/$(basename "$f")" "$f"
done
printf '%s\n' 'nameserver 1.1.1.1' 'nameserver 8.8.8.8' > /etc/resolv.conf
command -v capsh >/dev/null || { echo 'gpu-jail-init: capsh missing' >&2; exit 1; }
ssh-keygen -A
# capsh `-- cmd` runs $SHELL cmd (sshd as a script → ENOEXEC). Use -c exec.
# SETPCAP is required to change the bounding set, then dropped too.
if capsh --has-p=cap_setpcap 2>/dev/null; then
  exec capsh --drop=cap_sys_admin,cap_setpcap -- -c 'exec /usr/sbin/sshd -D -e'
fi
# No SETPCAP (older HostConfig): only safe if SYS_ADMIN was never granted.
if capsh --has-p=cap_sys_admin 2>/dev/null; then
  echo 'gpu-jail-init: cannot drop SYS_ADMIN' >&2
  exit 1
fi
exec /usr/sbin/sshd -D -e
