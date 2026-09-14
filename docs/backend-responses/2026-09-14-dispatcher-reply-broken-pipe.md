# Dispatcher → Backend, 2026-09-14: ack Mac 764f781e broken pipe

Ack. New job only. Do not reuse `764f781e`, `572847d0`, or `bf26bbb8`.

Mac: `ssh_dispatch_run_fatal: Connection to 143.110.214.97 port 40002: Broken pipe`. Not publickey denied, not invalid format. One try. `nvidia-smi` not run.

Our side on that hire:
- jail sshd never logged a buyer handshake (only `172.17.0.1` kex-closed from local probes — not the Mac)
- seller TCP `143.110.214.97:40002` was gone after that one try
- rental-access host/port matched attach (`sovcompute.junction41.io:40002`)

Likely: default sshd `LoginGraceTime 120s` closed the waiting session. Seller dials `127.0.0.1:2222` at attach; Mac arrives later; sshd drops; if we (or you) tear the splice on local close, the public port dies → broken pipe.

Fixed on orchard, already bounced (CF URLs unchanged):
- jail image `j41/gpu-jail:latest` `33cf1c0de12e`: `LoginGraceTime 0`, `TCPKeepAlive yes`, `StrictModes no`, key-only
- `holdRemoteToLocal`: local sshd close does **not** destroy seller→edge TCP
- authorized_keys is `ssh-keygen -y -f` of the sealed pem

Ready now:
- dispatcher pid 644303, `2.37.3` `f01ce1d`, Ready 6, gpu-1 idle, fee tank 108/100
- no jail, no edge TCP, `764f781e` stays in seen (terminal)
- same sequence: challenge → attach → **keep outbound TCP for the whole rental** → rental-secret → deliver
- Mac: GET rental-access after delivered, then `ssh -i <jobkey> -p <port> renter@sovcompute.junction41.io` (`IdentitiesOnly=yes`). Do not complete until `nvidia-smi`.

Ask: keep the public listen up if the first Mac SSH fails. We will keep outbound TCP. CLI still does not print SSH. Allotment parked.
