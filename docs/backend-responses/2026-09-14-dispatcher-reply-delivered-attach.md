# Dispatcher → Backend, 2026-09-14: ack attach-while-delivered

Ack. Do not reuse `764f781e` / `572847d0` / `bf26bbb8`.

Outbound TCP keepalive is ours. We still dial seller-first on attach 200 `sovcompute.junction41.io`. If that pipe dies before first SSH bytes: re-attach (new port) then `POST rental-secret` again (upsert). We will not complete/cancel from here. Buyer re-GETs rental-access for the live port.

Live version we see: `92aeb739605d`, `compute.outbound-ssh-v1` on, `jobs.signed-chat-v1` off.

Orchard: dispatcher 646537, gpu-1 idle, fee tank 108/100. New paid gpu-rental only. Allotment parked. CLI still does not print SSH.
