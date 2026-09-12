# Four-kind live walk (build here, test on GPU box)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (this session) or subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Prove labour / model / data on live `dca3e8f` with integrate CLI; skip compute until public SSH; then reply to backend with evidence — not a promise.

**Architecture:** This computer **builds** (`execute-plan/ca3106a1-integrate`) and pushes GitHub. The **other computer** (GPU) runs the buyer+seller walk against `https://api.junction41.io`. Do not copy `~/.j41` between machines. Do not npm-claim reviews.

**Tech Stack:** Node 20+, `@junction41/dispatcher` integrate tree, live API `dca3e8f8c5da`, SDK 2.16.1, VRSCTEST.

**Spec:** `docs/backend-responses/2026-09-12-backend-walk-origin.md` + `docs/superpowers/specs/2026-09-06-buyer-lifecycle-2.37.4-design.md`

## Global Constraints

- Walk origin is **live** `https://api.junction41.io` (`commit dca3e8f8c5da`). No second API.
- `J41_API_URL` / `[platform] api_url` = that URL. `J41_PLATFORM_SIGNER` = `GET /v1/config` `platformSigner` (`RBgxQwD7mMLCfciTN68RjBQHsH68vcnUKb`), never fee `RAWwNeTLRg9urgnDPQtPyZ6NRycsmSY2J2`.
- Go/no-go: `GET /v1/version` must include `reviews.j41-review-v2`, `platform.config-v1`, `buyer.inbox-attestation-v1`, `rental.public-host-v1`, `listings.data-service-v1`, `discovery.dispatcher-url-v1`. `jobs.signed-chat-v1` must be **absent**.
- Run **integrate CLI**, not yarn-global `2.37.3`: `node /path/to/integrate/src/cli.js …`
- Never print WIFs, npm tokens, minted apiKeys, NVIDIA keys.
- Do not copy `~/.j41` from this box to the GPU box.
- Do not hire models or data. Do not homemade `J41-REVIEW|Session:`.
- Compute **skipped** until `tunnel-setup` + doctor `rental.ssh_public` (no RFC1918).
- Do not npm publish. Do not merge `main`. Changelog must not claim reviews.
- Evidence goes in `~/j41-testkit/runs/2026-09-12-four-kind-walk/` on the **GPU box** (redact secrets). Then we file the backend reply from that log.

## Split of labour

| Where | Who | Does |
|---|---|---|
| This box (`dispatchertest3`) | Grok | Keep integrate green, GH branch current, plan + reply docs. No live hire/pay here. |
| GPU computer | You | Mint orchard sellers, run buyer verbs, capture evidence. |
| After evidence exists | Grok | Write backend reply from the run log. Push that reply to GH. Still no npm. |

---

### Task 1: GPU box — go/no-go against live

**Files:** evidence `00-version.json`, `00-config.json` (public fields only)

- [ ] **Step 1:** Confirm API

```bash
curl -sS https://api.junction41.io/v1/version | tee 00-version.json
curl -sS https://api.junction41.io/v1/config | tee 00-config.json
```

Expect `commit` `dca3e8f8c5da`. Features listed above present. `jobs.signed-chat-v1` absent. `platformSigner` starts `RBgxQwD7`. Stop if not.

- [ ] **Step 2:** Confirm integrate CLI, not npm 2.37.3

```bash
git clone git@github.com:autobb888/j41-sovagent-dispatcher.git
cd j41-sovagent-dispatcher
git checkout execute-plan/ca3106a1-integrate
git log -1 --oneline   # expect b3fe46b or later; 8de8061 must be ancestor
node src/cli.js --version
```

If this prints a global 2.37.3 from yarn, use `node src/cli.js` always.

---

### Task 2: GPU box — mint three sellers (not duskseek, not LAN GPU)

**Files:** orchard `~/.j41` **fresh on that machine**. Do not copy this tester `~/.j41`.

- [ ] **Step 1: Labour** — `setup` kind=agent, `start` with LLM preflight green, listing hireable. Unpaid accept is intended.

- [ ] **Step 2: Model** — `publicUrl` / `--webhook-url` is the **dispatcher** origin. Mint must write `{origin}/j41/proxy/v1`, never NVIDIA. Doctor `model.public_url` + `model.webhook`. `curl -sS https://<public>/j41/health` JSON `service=dispatcher`.

- [ ] **Step 3: Data** — `website` or `networkEndpoints[0]` is a real GET. Description may say “10 apples”; must **not** contain trycloudflare / RFC1918. `browse` uses website/endpoints only.

- [ ] **Step 4: Compute — skip** unless `tunnel-setup --http-host <dns> --ssh-host <dns>` + doctor `rental.ssh_public` is green. Do not accept `192.168.*`.

Record seller VerusIDs + service IDs in `01-sellers.txt` (no WIFs).

---

### Task 3: GPU box — buyer verbs (integrate CLI)

Buyer: `j41grokbuyer.agentplatform@` or a fresh j41General on this chain. `--json` where it exists. `--yes` only with a TTY or `J41_HEADLESS_MAINNET_PAY=1` (testnet still confirm unless `--yes`).

```bash
export J41_API_URL=https://api.junction41.io
BIN="node src/cli.js"
BUYER=<buyer-agent-id>
```

- [ ] **Labour**

```bash
$BIN listings --kind agent
$BIN hire "$BUYER" <labour-seller> --service <id> --amount <n> --pay --wait --yes --json | tee 10-labour-hire.json
$BIN job-chat "$BUYER" <job-id> --message ping --wait --json | tee 11-labour-chat.json
# POST body must be { content, signature, timestamp }; timestamp == Ts:
$BIN complete "$BUYER" <job-id> --yes --json | tee 12-labour-complete.json
$BIN review "$BUYER" <job-id> --rating 5 --yes --json | tee 13-labour-review.json
```

Expect: no `REVIEW_NOT_CANONICAL`. Then `GET /v1/me/inbox?type=job_record,review,attestation` non-empty → `14-labour-inbox.json`.

- [ ] **Model**

```bash
$BIN listings --kind model    # hireable:false next:access
$BIN access "$BUYER" <model-seller> --yes --json | tee 20-model-access.json
$BIN deposit "$BUYER" <model-seller> --amount <n> --wait --yes --json | tee 21-model-deposit.json
$BIN chat "$BUYER" <model-seller> --message ping --json | tee 22-model-chat.json
$BIN review-session "$BUYER" <model-seller> --rating 5 --yes --json | tee 23-model-review-session.json
```

Expect: not NVIDIA 404, not doubled `/v1`. Unpaid 402 → `CHAT_NEEDS_DEPOSIT`, then deposit `--wait` then chat works. `review-session` signs GET `J41-REVIEW-SESSION|` or fails `REVIEW_SESSION_UNSUPPORTED` (optional for npm reviews bar).

- [ ] **Data**

```bash
$BIN listings --kind data     # hireable:false next:browse
$BIN browse <data-seller> --json | tee 30-data-browse.json
$BIN hire "$BUYER" <data-seller> --amount 1 --json | tee 31-data-hire.json
```

Expect: browse HTTP 200 body. Hire `DATA_NOT_HIREABLE`.

- [ ] **Compute** — skip. Write `40-compute-skipped.txt`: doctor `rental.ssh_public` fail or no public host. Do not `acceptJob` on RFC1918.

- [ ] **Wallet stamp** — after `--pay --wait`, `wallet show` must not keep a confirmed leftover. `getTxStatus.confirmations > 0` before unlink.

---

### Task 4: This box — after you drop the run log

**Files:** `docs/backend-responses/2026-09-12-dispatcher-walk-results.md` (created only from evidence)

- [ ] **Step 1:** Copy redacted `~/j41-testkit/runs/2026-09-12-four-kind-walk/` here (no WIFs, no apiKeys).
- [ ] **Step 2:** Write the backend reply: pass/fail per kind, job ids, inbox non-empty yes/no, compute skipped why. No “we will”.
- [ ] **Step 3:** Push that reply to `execute-plan/ca3106a1-integrate`. Still no npm. Still no `main`.

---

## Done-when (staging/live walk)

1. Labour `submitReview` does not throw `REVIEW_NOT_CANONICAL`.
2. Buyer inbox `job_record,review,attestation` non-empty after complete+review.
3. Model chat not NVIDIA 404 / not `/v1/v1`. 402 → deposit → chat.
4. Data browse 200. Data hire `DATA_NOT_HIREABLE`.
5. Compute skipped with a public-SSH reason, or public host if tunnel is actually up.
6. `wallet-pending.json` unlinks only when confirmations > 0.

Then 2.37.4 npm **without** claiming reviews.
