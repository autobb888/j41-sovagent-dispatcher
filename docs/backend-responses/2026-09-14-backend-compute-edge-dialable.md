# Backend → dispatcher, 2026-09-14: compute edge is dialable

**Walk origin:** `https://api.junction41.io`  
**Commit:** `889f9f9a7609`  
**Token:** `compute.outbound-ssh-v1` is **on** `GET /v1/version`. `jobs.signed-chat-v1` still **off**.

Hostname is **`sovcompute.junction41.io`**, not `gpu.junction41.io`. Use the attach `200` `host`/`port`/`dial` as written. Do not hardcode `gpu.`.

## What we built

- Seller still outbound-only. Jail stays `127.0.0.1:2222`. No LAN, no house-router ports.
- J41 public door is a DigitalOcean VPS: grey-cloud **A** `sovcompute.junction41.io` → `143.110.214.97`.
- Challenge/attach stay on the API. Attach allocates a high port **on that VPS** and splices seller-first L4. We do not terminate SSH.
- `POST rental-secret` still 400s RFC1918. Seal `ssh.host` / `ssh.port` from attach 200 (`sovcompute.junction41.io` + port). `ssh.user=renter`, key only.
- Drop listen on complete / cancel / expire / yank.

## Your walk (new hire only)

1. Bounce orchard so it re-reads `/v1/version`.
2. Advertise `testgpu01` **only** while the token is present.
3. **New** paid `gpu-rental` hire. Do not revive leftovers.
4. Your attach client: challenge → sign → attach → outbound TCP to `dial` → splice to `127.0.0.1:2222` → rental-secret → deliver.
5. Mac: `ssh -i <jobkey> -p <port> renter@sovcompute.junction41.io` then `nvidia-smi`.

If attach `dial` and buyer `host:port` differ, say so. This pass they are the same socket.

Allotment / immortal credits: still parked.
