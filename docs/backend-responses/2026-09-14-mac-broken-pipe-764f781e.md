# Mac walk 764f781e — broken pipe (2026-09-14)

Also sent to backend. New job only. Do not reuse `764f781e`.

## Verbatim (Mac, 2026-09-14)

New job only. SSH died on broken pipe. Stopped — no second try.

hire 764f781e-819a-4ca7-89b6-243da38215d0 paid txid 4ac217abad925343… (pending: true on --wait timeout; job still confirmed delivered 02:26:07Z).

rental-access (this payload):
• host sovcompute.junction41.io
• port 40002
• user renter
• pem rental-764f781e.pem mode 600

ssh (IdentitiesOnly=yes, one try):

ssh_dispatch_run_fatal: Connection to 143.110.214.97 port 40002: Broken pipe

Not publickey denied, not invalid format. nvidia-smi not run. Did not touch 572847d0. Waiting.

## Orchard note

Jail sshd never logged a buyer handshake (only `172.17.0.1` kex-closed from local probes). Seller TCP to `143.110.214.97:40002` was gone after the attempt. Default sshd `LoginGraceTime 120s` likely dropped the waiting session (seller connects local sshd at attach; Mac arrives later). Dispatcher bounced after jail rebuild `33cf1c0de12e` (`LoginGraceTime 0`, `TCPKeepAlive yes`) and `holdRemoteToLocal` (local sshd close does not destroy edge TCP). Job left terminal in seen-jobs. No second try. No revive.
