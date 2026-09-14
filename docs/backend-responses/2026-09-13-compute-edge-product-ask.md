# Dispatcher → Backend, 2026-09-13: compute product (after orchard walk)

**From:** orchard seller (`execute-plan/ca3106a1-integrate`, dispatcher **2.37.3**, not npm `latest`)  
**To:** Junction41 backend  
**Re:** four kinds on live `api.junction41.io`; what you must build for **compute**  
**Buyer:** Mac stranger `j41macbuyer.agentplatform@` / `i4S5nnFJEfuPxq8gZBFn8Xnm4aeseDmLXB`  
**Do not treat this as “allow RFC1918.”** That is not the ask.

Five-answer lock is unchanged. API stays a **blind job/money relay**. You do not decrypt model envelopes, you do not build deposit CLI, you do not auto-start labour, you do not auto-cancel in-flight model jobs.

---

## 1. What we proved on live (this week)

| Kind | Live result | Notes |
|---|---|---|
| **agent (labour)** | PASS | Hire → job-chat → deliver → complete → review 5. Job `c9f468aa-…`. |
| **data** | PASS | Mac `browse` 200 on listing URL. Not a hire. |
| **model** | PASS on duskseek | Grant `endpointUrl` is dispatcher `/j41/proxy/v1`. Chat meters. moonkimi blocked on NVIDIA kimi-k3 hang (seller upstream, not you). |
| **compute** | **not hireable, correctly** | Live `POST /v1/jobs/:id/rental-secret` rejects RFC1918 (`Rental SSH host must be a public hostname or public unicast IPv4`). Dispatcher now refuses LAN **before accept**. `testgpu01` is **not advertised**. |

Compute failing closed on `192.168.1.69` is the right product. A stranger Mac cannot `nc` a house LAN. Opening the seller’s router, `bore.pub`, sslip.io, or binding jail SSH on `0.0.0.0` is **not** going into dispatcher. We will not ask you to seal LAN secrets.

---

## 2. Product we are locking (compute)

**Buyer** (any network) gets a normal SSH command to a **public** hostname. No Cloudflare client. No LAN IP.

**Seller** (home GPU, CGNAT, no router skill) opens **no inbound ports**. Jail SSH stays on **loopback** (`127.0.0.1:2222`). Dispatcher dials **out**.

**Auth:** per-job SSH **key** in `GET /v1/jobs/:id/rental-access` (private key to buyer only). Password login off. Jail + key die at expiry/complete. (Dispatcher work. Not your decrypt job.)

**You** already refuse RFC1918 on rental-secret (`rental.public-host-v1` on local `dca3e8f`). Keep that. Live must ship it. The missing piece is: **who publishes the public host:port the seller is allowed to seal?**

Today the only answers are “seller has a public IP + port forward” or “seller runs a named TCP tunnel.” That is not onboarding. Most new GPU sellers cannot do it. Cloudflare Access TCP is the wrong UX (buyer would need `cloudflared`).

---

## 3. What you need to build: compute edge (outbound SSH pipe)

Not a change to job money. Not envelope decryption. A **TCP edge** Junction41 operates.

### Done when

1. Seller dispatcher, behind NAT, with **no** port-forward and **no** Cloudflare TCP, can take a paid `gpu-rental` hire.
2. Buyer on another network runs `ssh -i <jobkey> -p <port> renter@<j41-host>` (or the host:port from `getRentalAccess`) and gets the jail. `nvidia-smi` works.
3. `GET /v1/jobs/:id/rental-access` is **buyer-only** (already 403 for seller — keep).
4. Sealed `ssh.host` is a **public hostname or public unicast IPv4** you issued (or the seller proved). RFC1918 / loopback / `.local` still 400.
5. When the job expires, completes, cancels, or disputes to yank, the pipe dies with the jail. No leftover public SSH.

### Shape (you own the names; this is the contract)

| Piece | Owner | Behavior |
|---|---|---|
| Jail + loopback `:2222` + per-job key | Dispatcher | Never host `:22`. Never `0.0.0.0` as product. |
| Outbound connect from seller → your edge | Dispatcher | Seller is a client, not a server. |
| Allocate `{host, port}` for that **job id** | **You (compute edge)** | Hostname you control, e.g. `gpu.junction41.io` or `\<job\>.gpu.junction41.io`. L4 passthrough. You do not terminate SSH. You do not see the shell. |
| `POST /v1/jobs/:id/rental-secret` | **You (API)** | Already exists. Keep RFC1918 400. Accept the host:port the edge issued. |
| `GET /v1/jobs/:id/rental-access` | **You (API)** | Already exists. Buyer-only. Return `ssh.host` / `ssh.port` / credential (`privateKey` once we mint keys; `password` until then). |
| Refuse LAN before `acceptJob` | Dispatcher | Job stays `requested`. No auto-refund this pass. |

Suggested feature token (staging + live `.features`): **`compute.outbound-ssh-v1`**.

If the token is **absent**, dispatcher keeps today’s rule: no public `ssh_hostname` → do not advertise, do not accept. We will not secretly fall back to LAN.

### What this is not

- Not “allow `192.168.x.x` on rental-secret.”
- Not Cloudflare Access / WARP on the buyer.
- Not Spectrum as the only path (paid CF per seller does not scale onboarding).
- Not you rewriting NVIDIA envelopes or proxying model chat.

---

## 4. API already on your local tree — still needed **on live**

These are not new ideas. They are not live on `baf8af8` / `api.junction41.io` as of the 2026-09-12 letter. Staging go/no-go (signed-chat **absent**):

| Token | Why compute/four-kind care |
|---|---|
| `rental.public-host-v1` | Live rental-secret RFC1918 400. We hit that string on live this week; token still the gate. |
| `reviews.j41-review-v2` | Labour review already walked on orchard; live GET still old bytes until this ships. |
| `buyer.inbox-attestation-v1` | Buyer inbox after complete+review. |
| `platform.config-v1` | Unsigned pin / `GET /v1/config`. |
| `listings.data-service-v1` | Data listings. |
| `discovery.dispatcher-url-v1` | Buyer finds dispatcher URL. |

`jobs.signed-chat-v1` must stay **off** on the first live rebuild.

---

## 5. Small API honesty items (not blockers for the edge)

1. **`GET /v1/jobs/:id` should carry `serviceType` (or `kind`).** GPU leftovers often only have `serviceId`. We already probe `getRentalAccess` for complete honesty. Other integrators will print a success checkmark on a LAN host if they trust `GET job` alone. Cheap.
2. **`job.delivered` (and rental-access ready) should be visible on the next buyer GET without a long poll lag.** Mac hired, paid, saw `accepted` + `delivery: null` + `Rental secret not found` from a GET that was taken **before** deliver. After deliver, seller `GET job` was `delivered` and seller `getRentalAccess` was 403 (correct). Buyer must re-GET. A webhook or a documented “poll until `timestamps.delivered`” is enough. Do not put host/password on `GET /v1/jobs/:id`.
3. **Webhook cap “Maximum 5 webhooks per agent”** — `gpu-1` could not register; poll is source of truth. Fine if you keep saying webhooks are best-effort. If compute edge needs a seller callback, do not use the 5-webhook bucket.
4. **`serviceType` on `GET /v1/jobs/:id` after accept** — hire JSON from Mac still showed `status: "requested"` because that was the **hire** return, not a later GET. Document hire vs getJob. Optional: hire `--wait` contract includes `delivered` + “secret is on rental-access, not this payload.”

---

## 6. Split of work

| We (dispatcher) | You (API + compute edge) |
|---|---|
| Contained GPU jail, loopback SSH, destroy on expiry | Public host:port allocation + L4 pipe |
| Per-job SSH key; seal via existing `rental-secret` | Keep rental-secret public-host check; buyer-only `rental-access` |
| Refuse RFC1918 before accept; do not advertise LAN | Ship `rental.public-host-v1` to live; add `compute.outbound-ssh-v1` |
| Model proxy, deposits (seller HTTP), labour, data | Five-answer reviews/inbox/config as already locked |
| No bore/sslip/LAN bind in this repo | No “just port-forward 2222” as the new-user path |

---

## 7. Ask

1. Confirm the compute-edge product (outbound seller, public buyer SSH, L4 passthrough, job-scoped).
2. Name the hostname pattern and the seller auth to attach a tunnel to a job (token, mTLS, or signed challenge — your call).
3. Put `compute.outbound-ssh-v1` on staging `GET /v1/version` `.features` when a dispatcher can actually dial it.
4. Rebuild live with the 2026-09-12 token set, signed-chat still false, **including** `rental.public-host-v1`.

Until (1)–(3) exist, orchard will **not** advertise `testgpu01`. Labour / data / model stay the live kinds. We will not hack a public TCP path into dispatcher to fake compute.

When you have a staging origin + the compute-edge dial contract, we will point integrate at staging and walk compute from a **new** hire, not by restarting leftover jobs.
