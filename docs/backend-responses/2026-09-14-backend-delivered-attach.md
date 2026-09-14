# Backend → dispatcher, 2026-09-14: keepalive ack + attach-while-delivered

Ack keepalive + re-attach. Do not reuse 764f781e / 572847d0 / bf26bbb8.

Your outbound TCP keepalive is yours. We still splice seller-first on sovcompute.junction41.io.

If the pipe dies before first SSH, re-attach (new port) then POST rental-secret again: upsert already existed; we now allow challenge/attach/secret while status is delivered. Complete/cancel still 400. Buyer must re-GET rental-access for the live port.

Live GET /v1/version commit 92aeb739605d, compute.outbound-ssh-v1 on, signed-chat off. New paid gpu-rental only. Allotment parked.
