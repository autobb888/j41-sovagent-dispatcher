# Joint plan — vanilla SSH (`compute.outbound-ssh-v1`) — 2026-09-13

**From:** orchard dispatcher (`execute-plan/ca3106a1-integrate`, package **2.37.3**, not npm `latest`)  
**To:** J41 backend  
**Re:** your 2026-09-13 compute-edge confirm (`gpu.junction41.io` + job-scoped high port)  
**Walk origin:** `https://api.junction41.io` (live `6b0df205b4ff`). Do not wait on another token rebuild for the §0 list.  
**Not this pass:** Sov\* standing credit / allotment clock. Circle back after this edge is dialable.

Both sides **can start now**. Dispatcher will not guess a private splice protocol; the **control/dial bytes below are a proposal** so you can implement the edge without waiting on our client. If you change the bytes, send the final challenge string + attach response once. We gate all dials on `.features` **`compute.outbound-ssh-v1`**.

---

## Product (locked)

| Who | Gets |
|---|---|
| Buyer, any network | `ssh -i <jobkey> -p <port> renter@gpu.junction41.io` — no Cloudflare, no LAN |
| Seller GPU box | Outbound only. Jail SSH **`127.0.0.1:2222`**. Never `0.0.0.0` as product. |
| API | RFC1918 / loopback / `.local` on `rental-secret` stay **400**. `rental-access` buyer-only. Host/key **never** on `GET /v1/jobs/:id`. |

`testgpu01` stays **off** the fleet until a dispatcher can actually dial. Labour / data / model stay the live kinds.

---

## Split

### Dispatcher builds (we start now)

1. **Per-job SSH key** in `j41/gpu-jail`  
   - Generate ed25519 at acquire. Public key in `renter` `authorized_keys`.  
   - `PasswordAuthentication no`. No `J41_RENTER_PASSWORD` as the product path.  
   - Seal `ssh.user=renter`, `ssh.privateKey`, **no password**. Existing `assertSshDeliverable` already accepts a key.

2. **Loopback-only publish**  
   - `HostIp: 127.0.0.1`, `HostPort: ssh_tunnel_port` (default 2222). Already the code after the hack revert. Tests keep “never `0.0.0.0`.”

3. **Refuse LAN before accept / before advertise**  
   - Already: `RENTAL_LAN_HOST`, doctor `rental.ssh_public`, start skips `gpu-1` when `ssh_hostname` is RFC1918.  
   - **No** `J41_ALLOW_LAN_RENTAL` on orchard. No secret fallback if the token is absent.

4. **Outbound attach client** (gated on `compute.outbound-ssh-v1`)  
   After paid accept, before `rental-secret`:  
   - Sign your challenge (accepted `gpu-rental` job id).  
   - Dial the edge. Forward local `127.0.0.1:2222` on that socket.  
   - Use the allocated `{host, port}` as `ssh.host` / `ssh.port` in `POST /v1/jobs/:id/rental-secret`.  
   - Then `deliverJob` notice with **no** host/key.  
   - If the token is missing: do not advertise, do not accept, do not dial.

5. **Drop local jail** on complete / expire / cancel / yank (existing compute-supply reconcile). Your listener drop must match.

6. **Tests** for key-only jail, loopback bind, no-advertise without token, attach-then-seal uses edge host:port not `192.168.x.x`.

We will **not** put bore, sslip, pinggy, or `0.0.0.0` in this repo.

### Backend builds (you start now)

1. **L4 edge** on **`gpu.junction41.io`**. You do not terminate SSH. You do not see the shell.

2. **Allocate a high port per accepted `gpu-rental` job id.** First pass is `gpu.junction41.io:<port>`, not `\<job\>.gpu.junction41.io:22`.

3. **Seller attach** = signed challenge bound to that **accepted** job id. Not the 5-webhook bucket. Not a long-lived VDXF secret.

4. **Splice** only that seller session to buyer TCP on the allocated port.

5. **Drop the public listener** on complete / expire / cancel / dispute yank, in the same window the jail dies.

6. Keep **`POST rental-secret`** public-host check. `gpu.junction41.io` is a public hostname.

7. Put **`compute.outbound-ssh-v1`** on `GET /v1/version` **only when a seller process can dial it** (staging first). Absent = we stay dark on GPU.

---

## Attach contract — proposal so you can code the edge

You own the final strings. This is one shape that matches “signed challenge + job-scoped high port.” Replace it; don’t leave it unspecified.

### A. Challenge (HTTPS, seller session, job must be `accepted` and paid)

`GET /v1/jobs/:jobId/compute-edge/challenge`

```json
{
  "message": "J41-COMPUTE-ATTACH|Job:<jobId>|Ts:<unix>",
  "timestamp": 1700000000
}
```

- `timestamp` **equals** `Ts:`. Unix seconds.  
- Sign `message` with the seller agent WIF (same `signMessage` as accept).  
- Job not `gpu-rental` / not accepted / not this seller → 403/404.  
- Not a webhook.

### B. Attach (HTTPS, then data)

`POST /v1/jobs/:jobId/compute-edge/attach`

```json
{
  "timestamp": 1700000000,
  "signature": "<base64 of message>"
}
```

**200:**

```json
{
  "host": "gpu.junction41.io",
  "port": 40123,
  "dial": "tcp://gpu.junction41.io:40123"
}
```

`host`+`port` are what we put in `rental-secret` `ssh.host` / `ssh.port` (buyer SSH).  
`dial` is what the **seller** connects **out** to. If control and buyer-listen are the same socket, they are equal. If you want a separate splice port, return both explicitly (`buyerPort` vs `sellerDial`).

### C. Data plane

- Seller: outbound **raw TCP** to `dial` (SSH already encrypts the inner stream).  
- First bytes: optional one-line `J41-COMPUTE-SPLICE|Job:<jobId>\n` if you need to bind the socket to the job without TLS. Prefer: **the allocated port is already job-scoped**, so the TCP connect *is* the splice.  
- Seller side of that socket is proxied to `127.0.0.1:2222` in dispatcher.  
- Buyer: `ssh -i key -p <port> renter@gpu.junction41.io` → your listen on that high port → splice to the seller socket.  
- Idle/expiry: you close; we close the jail.

If you would rather mux on one port (`gpu.junction41.io:443` + first-frame job id), say so in the first drop. **This plan’s default is job-scoped high port, no mux.**

### D. Token

Staging (or live) `.features` includes `compute.outbound-ssh-v1` **after** A–C work for one paid job. We will not advertise GPU on a token that 404s.

---

## Sequence (one paid hire)

1. Buyer `hire --pay` `gpu-rental`.  
2. Dispatcher: public-host gate (token present + edge, not LAN) → `acceptJob`.  
3. Dispatcher: start jail on `127.0.0.1:2222` with this job’s key.  
4. Dispatcher: challenge → sign → attach → outbound TCP splice.  
5. Dispatcher: `POST rental-secret` `{ ssh: { host, port, user, privateKey } }`.  
6. Dispatcher: `deliverJob` notice only.  
7. Buyer: `GET rental-access` → SSH.  
8. Complete / expire / cancel / yank: you drop listen; we `releaseLease` (container gone).

Do **not** revive leftover jobs to prove this. New hire only.

---

## Done when (joint)

- Mac stranger, not on the seller LAN, `GET rental-access` then `ssh -i … -p <port> renter@gpu.junction41.io` and `nvidia-smi`.  
- `GET /v1/jobs/:id` has **no** host/key.  
- Seller box has **no** inbound 2222 on the WAN.  
- After complete, public port is dead and jail is gone.  
- `compute.outbound-ssh-v1` present on the origin we dialed.

---

## Explicitly later

- `\<job\>.gpu.junction41.io:22` mux  
- Sov\* prepaid **allotment with a clock** (not immortal credit)  
- Password SSH  
- Named Cloudflare TCP / Spectrum as the buyer path  
- `J41_ALLOW_LAN_RENTAL` as product  

---

## Start order

| Now | You | Us |
|---|---|---|
| Today | Edge listen + allocate port + challenge/attach stubs | Jail key + loopback + token gate (no advertise) |
| When A–C exist on staging | Flip `compute.outbound-ssh-v1` on that origin | Dial client + seal edge host:port |
| Walk | One **new** VRSCTEST hire | Orchard `testgpu01` advertised **only** with the token |

If A–C as written is wrong, send the replacement bytes; do not wait for a second product debate. Allotment stays parked until this SSH path is green.
