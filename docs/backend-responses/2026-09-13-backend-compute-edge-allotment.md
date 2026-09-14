# Backend → dispatcher, 2026-09-13: compute edge + allotment (not standing credit)

**From:** J41 backend (`api.junction41.io`)  
**To:** orchard / integrate dispatcher  
**Re:** your 2026-09-13 compute letter + a product lock on **Sov\* prepaid**  
**Live:** `GET /v1/version` commit **`6b0df205b4ff`**, `builtAt 2026-09-12T17:47:34Z`. Do not treat this image as `baf8af8`.

Five-answer lock unchanged. Blind relay: no envelope decrypt, no deposit CLI, no auto-start labour, no auto-cancel in-flight model jobs, `jobs.signed-chat-v1` **off**.

---

## 0. Your §4 token list is already live

`GET https://api.junction41.io/v1/version` `.features` **has**:

`reviews.j41-review-v2`, `platform.config-v1`, `buyer.inbox-attestation-v1`, `rental.public-host-v1`, `listings.data-service-v1`, `discovery.dispatcher-url-v1`.

`jobs.signed-chat-v1` is **absent**. RFC1918 on `POST /v1/jobs/:id/rental-secret` is the live 400 you hit. **Do not wait on another live rebuild for those tokens.** Walk origin stays `https://api.junction41.io`.

---

## 1. Compute product — we confirm

Buyer: vanilla `ssh -i <jobkey> -p <port> renter@<public-host>`. No Cloudflare client. No LAN.

Seller: outbound only. Jail SSH stays `127.0.0.1:2222`. Never `0.0.0.0` as product. No bore / sslip / “open the router.”

API: RFC1918 / loopback / `.local` stay **400**. Buyer-only `GET /v1/jobs/:id/rental-access`. Host/password never on `GET /v1/jobs/:id`.

Until a dispatcher can **actually dial** an edge, orchard **must not** advertise `testgpu01`. Labour / data / model stay the live kinds. We will not allow LAN to fake compute.

### Edge we will build (new drop, not remaining-work)

J41 operates an **L4 passthrough**. We do not terminate SSH. We do not see the shell.

| Piece | Owner |
|---|---|
| Jail + loopback `:2222` + per-job key | You |
| Outbound connect seller → edge | You |
| Allocate `{host, port}` for **that job id**; splice TCP only to that seller session | Us |
| Seal host:port via existing `rental-secret`; public-host check stays | Us |
| Drop the listener on complete / expire / cancel / dispute yank | Us (must match jail death) |
| Refuse RFC1918 before accept; no LAN advertise | You |

**Hostname this pass:** `gpu.junction41.io` + **job-scoped high port**. Wildcard `\<job\>.gpu.junction41.io:22` is a later mux, not the first dial.

**Seller attach auth:** signed challenge bound to an **accepted** `gpu-rental` job id. Not the 5-webhook bucket. Not a long-lived VDXF secret.

**Token:** `compute.outbound-ssh-v1` on `GET /v1/version` **only when a seller process can dial it** (staging first). Absent token → your current rule: no public host → do not advertise, do not accept. No secret LAN fallback.

---

Orchard check 2026-09-13: live `GET /v1/version` matches commit `6b0df205b4ff` / `builtAt 2026-09-12T17:47:34Z`. All six §0 tokens present. `compute.outbound-ssh-v1` and `jobs.signed-chat-v1` absent. Fleet: gpu-1 not advertised.

---

## Dispatcher note (orchard, same day) — allotment deferred

Prepaid Sov\* **standing credit with no clock** is not the product we will ship as-is. A buyer who parks 5 VRSC on a seller and never spends it leaves meters, grants, and leftover jobs on the dispatcher forever. At hundreds/thousands of buyers that is unbounded host state, not a marketplace.

Lock we will bring back **after** `compute.outbound-ssh-v1` is dialable:

- Allotment is **time-bounded** (and/or job-bounded), not an immortal balance.
- Leftover hires are not revived to “use up” credit.
- Exact API shape (expiry on the meter, on the grant, or on a prepaid allotment object) is **not** designed in this pass.

**This pass:** J41 hosts vanilla buyer SSH (`gpu.junction41.io` + job-scoped high port). No LAN fake. Circle back to allotment once that edge exists.
