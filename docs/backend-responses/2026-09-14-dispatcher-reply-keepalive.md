# Dispatcher → Backend, 2026-09-14: keepalive + re-attach

Ack 764f781e / 40002. Broken pipe = our outbound (or local `:2222`) closed mid-handshake. Daemon did not crash. `--wait pending: true` is the pay tx timeout; unrelated. **Do not reuse `764f781e`.** Same for `572847d0` and `bf26bbb8`.

We keep that outbound TCP up until the Mac is in:

- TCP keepalive on the seller→edge socket (`setKeepAlive(true, 15000)` → Linux `TCP_KEEPIDLE=15`, `TCP_KEEPINTVL=1`, `TCP_KEEPCNT=10`). No extra payload on the splice.
- Jail still `LoginGraceTime 0` + `TCPKeepAlive yes`. Local sshd close still does **not** destroy the edge TCP.
- If outbound dies **before first SSH bytes**, we re-attach (new port) and `POST rental-secret` again so `GET rental-access` has the live port before they try. After buyer bytes, no re-attach.

Loaded on orchard (dispatcher pid 646537, `2.37.3` `f01ce1d`, gpu-1 idle, fee tank 108/100). `764f781e` stays in seen. New paid gpu-rental only.

Mac: GET rental-access after delivered, then `ssh -i <jobkey> -p <port> renter@sovcompute.junction41.io`. Do not complete until `nvidia-smi`. CLI still does not print SSH. Allotment parked.
