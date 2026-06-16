# Node privacy tiers — what a hosted node can and cannot promise a renter

> **Who this doc is for.** The owner (autobb888), thinking through the question
> that surfaces the moment the dispatcher becomes brainbox's hosting muscle for
> *other people's* compute: **if I run a node offering compute, and someone
> rents it to ask medical questions, what stops me — the host with root on my
> own box — from watching the model's input/output inside my own Docker?**
> Companion context: `2026-06-11-dispatcher-v3-headless-hirer-brainbox.md`
> (WP-D3 hirer + matching), `2026-06-11-namespaces-and-skill-licensing.md`
> (`sovcompute@` is the namespace this lands under), and the WP-D4 attestation
> work already shipped (`src/job-agent.js performCleanup`, SDK attestation v2).
> Status: design, owner-raised 2026-06-15, nothing built. No code change is
> required to start — step 1 is a marketing/honesty change.

---

## 1. The thesis (read this even if you skip the rest)

**On a node where the operator has root, software cannot stop the operator from
reading plaintext.** The model decrypts the prompt and runs inference in normal
RAM/VRAM on the operator's machine; the operator can `docker attach`, `ptrace`,
read `/proc/<pid>/mem`, dump VRAM, or sniff the loopback. The dispatcher itself
runs on that same machine, so a malicious operator can patch the dispatcher too.
No amount of dispatcher logic, container hardening, or obfuscation fixes this,
because every one of those defenses is enforced *by the box the attacker owns*.

So j41 is not selling one privacy product. It is selling **two**, and a node
must declare which one it offers:

1. **Accountability privacy** (what we have today). The operator *can* see, but
   is deterred and held accountable: tamper-evident attestations, staking +
   slashing, ToS. Works on **any** GPU. Real value, honestly limited — it is
   *deterrence*, never a guarantee against a malicious host.
2. **Technical privacy** (the zero-trust answer). The operator *cannot* see,
   even with root, because inference runs inside a hardware **Trusted Execution
   Environment** the operator can't peer into, and the renter gets a
   vendor-signed **attestation** proving it before sending a single token.
   Requires confidential-compute silicon (datacenter GPUs) — so **not every
   node can offer it.**

The whole design below is: make that distinction a **node capability**, be
honest about it in the marketplace from day one, and gate privacy-sensitive
jobs to nodes that can actually keep the promise.

```
                 a renter posts a privacy-sensitive job
                                 │
                                 ▼
                   dispatcher matching (WP-D3 hirer)
                                 │
          ┌──────────────────────┴───────────────────────┐
          │ job.privacy == "confidential" ?               │
          └──────────────────────┬───────────────────────┘
                  yes             │              no
          ┌────────────────┐     │      ┌────────────────────┐
          │ require node    │    │      │ any node; sold as   │
          │ confidential:true│   │      │ "accountability:    │
          │ + verify TEE quote│  │      │  operator CAN see,  │
          │ BEFORE payload   │   │      │  deterred + logged" │
          └───────┬─────────┘    │      └─────────┬──────────┘
                  ▼              │                ▼
   ┌──────────────────────────┐ │   ┌──────────────────────────┐
   │ Model 2 — technical      │ │   │ Model 1 — accountability  │
   │ TEE enclave, host sees   │ │   │ deletion attestation v2,  │
   │ only ciphertext          │ │   │ stake/slash, ToS          │
   └──────────────────────────┘ │   └──────────────────────────┘
```

---

## 2. The two models, in full

### Model 1 — Accountability privacy (shipped, on every node)

This is the layer WP-D4 already built. The operator has access to the plaintext
but is bound not to use it:

- **Tamper-evident attestations.** The deletion-attestation v2 payload signs
  what ran and that data was destroyed; a renter can verify the format and the
  signature. (`SDK attestation.ts`, `performCleanup` in `job-agent.js`.)
- **Stake + slashing.** Operator bonds VRSC against the node; provable snooping
  burns the bond. (Not built — economic layer, platform-side.)
- **Contract / ToS.** The "privacy act": the operator agrees, in a signed
  acceptance, not to inspect renter I/O. Legal, not technical.

**Honest marketing copy** for a Model-1 node: *"This operator agrees not to
inspect your data and is economically and contractually bound, with
tamper-evident records of what ran. The operator is technically capable of
seeing your data and you are trusting them not to."*

What Model 1 is **not**: protection against a determined malicious operator.
Passive snooping (a script tailing container logs) is essentially
**undetectable** — so this model rests *entirely* on deterrence, not
prevention. We must never let the UI imply otherwise. That overclaim is the one
thing that turns a reasonable product into a liability the first time someone's
medical prompt leaks.

### Model 2 — Technical privacy (zero-trust host)

The operator **cannot** read the plaintext, even with root. This is
**confidential computing**, and it is the only actual answer to the question
that prompted this doc.

- **CPU TEEs — AMD SEV-SNP / Intel TDX.** Encrypt VM memory with a key the CPU
  holds and the host OS/hypervisor never sees. The host can dump RAM all day and
  get ciphertext.
- **GPU TEEs — NVIDIA Confidential Computing** (Hopper H100/H200, Blackwell).
  The one that matters for LLM inference: the GPU encrypts data over the PCIe
  bus and inside VRAM, and refuses to operate in CC mode unless the chain is
  intact. Paired with SEV-SNP/TDX on the CPU you get an **end-to-end
  confidential VM** — prompt and weights are only ever in cleartext *inside* the
  enclave.
- **Remote attestation — the keystone.** Before the renter sends anything, the
  node produces a **quote signed by Intel / AMD / NVIDIA** proving: genuine TEE,
  CC mode on, and a measurement of the exact image/code loaded. The renter
  verifies that quote against the vendor's roots of trust, and only *then*
  releases the key that decrypts the prompt. **The renter trusts the silicon
  vendor, not the operator.** This is what makes it zero-trust: the host can be
  actively malicious and still learn nothing.

**Honest marketing copy** for a Model-2 node: *"Hardware-attested confidential
compute. Your prompt and the model are decrypted only inside a sealed enclave
the operator cannot inspect, even with physical access. Verified by an
Intel/AMD/NVIDIA-signed attestation before your data leaves your machine."*

---

## 3. The catch j41 specifically has to swallow

Confidential GPU compute needs **H100 / H200 / Blackwell-class** silicon. A
hobbyist hosting on a 3090 or 4090 **physically cannot** offer Model 2 — there
is no CC mode on consumer cards. This is in direct tension with j41's
"anyone can host, earn on the hardware you already own" thesis.

The resolution is not to pick one — it's to **tier honestly**:

| Tier | Hardware | Model | Sold as |
|---|---|---|---|
| **Commodity** | any GPU (4090, 3090, CPU) | Model 1 | "deterrence + accountability; operator *can* technically see" |
| **Confidential** | CC datacenter GPU (H100/H200/Blackwell) + SEV-SNP/TDX host | Model 2 | "zero-trust; operator *cannot* see; hardware-attested" |

A renter chooses the guarantee they need and pays accordingly — confidential
nodes command a premium, which is the incentive that pulls datacenter-grade
hosts onto the network. Commodity nodes still serve the large majority of
workloads where the data isn't sensitive.

**Dead ends, so nobody re-proposes them:** FHE (fully homomorphic encryption)
and MPC (secure multiparty computation) for LLM inference are real but **orders
of magnitude too slow** to be viable today — do not build toward them.
Obfuscating the model, "trusted" Docker images, or encrypting weights at rest
do **nothing** against a root host and must not be marketed as privacy.

---

## 4. How it lands in the dispatcher

The good news: this composes cleanly with WP-D3 (hirer) and the attestation work
already done. It is a **capability + a matching constraint + a verify step**, not
a new subsystem.

1. **Node capability declaration.** A node advertises its tier in its capability
   set: `privacy: "accountability" | "confidential"`, and for confidential, an
   `attestation_endpoint` plus the TEE type and an image measurement. Surfaces
   through the control API (`/v1/status`, `/v1/agents`) and up to the platform's
   node registry.

2. **Job privacy requirement.** A posted job carries
   `privacy: "standard" | "confidential"`. The WP-D3 matcher treats
   `confidential` as a **hard constraint**: only nodes with
   `privacy == "confidential"` are eligible, and the buyer-side flow refuses to
   release the payload to a node whose attestation doesn't verify.

3. **Attestation-gated payload release (Model 2 path).** Before sending the
   prompt, the renter/SDK: (a) fetches the node's TEE quote, (b) verifies it
   against vendor roots + the expected image measurement, (c) only then releases
   the decryption key / encrypted prompt. This is the inverse of the deletion
   attestation: deletion proves *after*, the TEE quote proves *before*. Together
   they bracket the job — **prevention** at the front, **accountability** at the
   back.

4. **Honesty in the UI (do this FIRST, no hardware required).** Every node, even
   today's all-Model-1 fleet, should display its true guarantee. The single
   highest-value, zero-cost step in this whole doc is: **stop any copy that
   implies a commodity node's data is private *from the operator*.** Label it
   "accountability privacy: operator can technically see, deterred + logged."
   That one change is shippable now and removes the liability.

---

## 5. Build order

- **P0 (now, no hardware).** Add the `privacy` tier label to the node-capability
  model + control API, and correct all marketing/UI copy to the honest Model-1
  framing. Tamper-evident accountability (deletion attestation v2) is already
  live — make sure it's *surfaced* to renters, not buried.
- **P1 (with WP-D3).** Job-level `privacy` field + matcher hard-constraint, so a
  `confidential` job can only ever route to a confidential node (even if zero
  exist yet — the constraint is correct from day one).
- **P2 (when CC hardware appears).** Implement the attestation-fetch + verify
  step in the SDK/hirer (NVIDIA NRAS / vendor attestation services), and the
  enclave-side launcher on the host. Light up the confidential tier.
- **Economic layer (platform, parallel).** Staking + slashing for Model-1 nodes;
  premium pricing for confidential nodes. Not dispatcher-side.

---

## 6. The one-sentence version

j41 can't make a root host blind with software, so it ships **two honest
products** — *accountability* privacy on any GPU (deter + log + slash, operator
*can* see) and *technical* privacy on confidential-compute silicon (TEE +
hardware-signed attestation, operator *cannot* see) — exposed as a node tier the
WP-D3 matcher gates jobs against, with the deletion attestation already proving
the back half and a TEE quote proving the front.
