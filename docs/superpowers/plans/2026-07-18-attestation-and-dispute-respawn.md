# Attestation Tuple + Dispute Respawn-with-Deadline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent carry a backend-signed attestation tuple on its own VerusID (A), and make a dispute filed against a torn-down job respawn a worker that surfaces the dispute + deadline to the operator instead of dropping it (B).

**Architecture:** A is pure passthrough — clone `acceptReview` into `acceptAttestationTuple` (different allowlisted key), route `type:'attestation'` inbox items to it. B respawns a worker via the existing reactivation-queue machinery for torn-down disputes, adds a status-driven "post-delivery reconnect" branch so the worker skips redoing work, and replaces the silent VDXF auto-policy with a surface-to-operator path. Deadline is fetched authoritatively by the worker via `getDispute`.

**Tech Stack:** SDK = TypeScript→CJS (`yarn build` to `dist/`, `npx tsx --test`). Dispatcher = CommonJS, no build (`node --check`, `node --test`).

**Spec:** `docs/superpowers/specs/2026-07-18-attestation-and-dispute-respawn-design.md` (rev 2).

## Global Constraints

- Attestation VDXF key is final/immutable: `agentplatform::review.attestation` → `i76fJX1DreN81CoRVJHSkrcqHq9nsLomYv`. Use this exact i-address.
- Attestation is **opaque passthrough**: never build/encode/verify the tuple bytes. `acceptAttestationTuple` = `acceptReview` clone. Accepted directly (like `review`), NOT witness-gated (unlike `job_record`).
- Accept path is **namespace-allowlisted to exactly `[VDXF_KEYS.review.attestation]`**; any other key in `vdxfData` is dropped with a tamper warning. No `vdxfData` → refuse to write (fail-closed). WIF+iAddress required.
- Dispute auto-response: **surface-only, human has final say.** Remove the silent VDXF auto-policy; leave a marked seam for future autonomy. Do not call `respondToDispute` from the worker.
- Deadline source: worker fetches `getDispute` (authoritative). Dispute GET fields: `deadline_at` (ISO|null), `deadline_owner` (`'seller'|'buyer'|null`), `deadline_passed` (bool).
- Never silently drop a dispute: an unresolvable seller emits `dispute.unresolved_agent` and logs; it does not enqueue a broken entry.
- SDK tests import from `dist/` → run `yarn build` before `npx tsx --test`. Dispatcher: `node --check` + `node --test`.
- No env-var kill switches for verification. Fail closed.

---

## File Structure

**SDK (`j41-sovagent-sdk`):**
- Modify `src/onboarding/vdxf.ts` — add `review.attestation` key (Task 1).
- Modify `src/agent.ts` — add `acceptAttestationTuple` (Task 1).
- Modify `src/jobs/types.ts` — extend `onJobDisputed` signature (Task 3).
- Modify `src/client/index.ts` — extend `DisputeDetail` (Task 3).
- Create `test/accept-attestation.test.ts` (Task 1), `test/dispute-deadline-type.test.ts` (Task 3).

**Dispatcher (`j41-sovagent-dispatcher`):**
- Modify `src/cli.js` — extract `dispatchInboxAccept` + attestation route (Task 2); add `queueDisputedJobForRespawn` + wire webhook/poll (Task 4).
- Modify `src/job-agent.js` — post-delivery reconnect branch (Task 5); `surfaceDispute` + handler wiring + remove auto-policy (Task 6).
- Create `test/inbox-attestation-routing.test.js` (Task 2), `test/dispute-respawn.test.js` (Task 4), `test/dispute-surface.test.js` (Task 6), `test/post-delivery-reconnect.test.js` (Task 5).

---

## Task 1: SDK — `review.attestation` key + `acceptAttestationTuple`

**Files:**
- Modify: `j41-sovagent-sdk/src/onboarding/vdxf.ts:66-68`
- Modify: `j41-sovagent-sdk/src/agent.ts` (insert a new method immediately after `acceptReview`, which ends at ~1484)
- Test: `j41-sovagent-sdk/test/accept-attestation.test.ts`

**Interfaces:**
- Produces: `VDXF_KEYS.review.attestation === 'i76fJX1DreN81CoRVJHSkrcqHq9nsLomYv'`; `agent.acceptAttestationTuple(inboxId: string): Promise<void>` — allowlists only `review.attestation`, writes opaque hex, refuses to synthesize, emits `'attestation:accepted'`.

- [ ] **Step 1: Write the failing test** — `test/accept-attestation.test.ts` (mirrors `accept-review-path.test.ts`):

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { J41Agent } = require('../dist/agent.js');
const { generateKeypair } = require('../dist/identity/keypair.js');
const { VDXF_KEYS } = require('../dist/onboarding/vdxf.js');

const ATTESTATION_IADDR = VDXF_KEYS.review.attestation; // i76fJX1DreN81CoRVJHSkrcqHq9nsLomYv
const REVIEW_RECORD_IADDR = VDXF_KEYS.review.record;     // must be DROPPED by the attestation allowlist

function makeAgent(inbox: any, opts: { sentinel?: Error } = {}) {
  const kp = generateKeypair('verustest');
  const agent = new J41Agent({
    apiUrl: 'https://api.example.com', wif: kp.wif,
    iAddress: 'iAgentTestAddr000000000000000000000', identityName: 'attesttest.agentplatform@',
  });
  const calls = { broadcast: 0, getChainInfo: 0, accepted: 0 };
  agent.client.getInboxItem = async () => ({ data: inbox });
  agent.client.getIdentityRaw = async () => ({ data: { identity: {}, prevOutput: { txid: 'aa', n: 0 }, blockHeight: 100, txid: 'aa' } });
  agent.client.getUtxos = async () => ({ utxos: [{ txid: 'bb', outputIndex: 0, satoshis: 100000 }] });
  agent.client.getChainInfo = async () => { calls.getChainInfo++; if (opts.sentinel) throw opts.sentinel; return { blockHeight: 100 }; };
  agent.client.broadcast = async () => { calls.broadcast++; return { txid: 'deadbeef' }; };
  agent.client.acceptInboxItem = async () => { calls.accepted++; };
  return { agent, calls };
}

describe('acceptAttestationTuple', () => {
  it('refuses to synthesize when vdxfData is null; never broadcasts', async () => {
    const { agent, calls } = makeAgent({ id: 'a1', status: 'pending', vdxfData: null });
    await assert.rejects(agent.acceptAttestationTuple('a1'), /no VDXF review\.attestation — refusing to synthesize/);
    assert.strictEqual(calls.broadcast, 0);
    assert.strictEqual(calls.getChainInfo, 0);
  });

  it('drops a non-attestation key (even review.record) and rejects', async () => {
    const { agent, calls } = makeAgent({
      id: 'a2', status: 'pending',
      vdxfData: { [REVIEW_RECORD_IADDR]: ['deadbeef'] }, // record is NOT allowed here
    });
    await assert.rejects(agent.acceptAttestationTuple('a2'), /contained no review\.attestation keys after whitelist/);
    assert.strictEqual(calls.broadcast, 0);
  });

  it('passes a properly-keyed attestation through the whitelist to tx build', async () => {
    const sentinel = new Error('SENTINEL_REACHED_TX_BUILD');
    const hex = Buffer.from(JSON.stringify({ jobHash: 'jh', buyer: 'iBuyer', rating: 5, timestamp: 1700000000, msgHash: 'abcd', signature: 'sig' })).toString('hex');
    const { agent, calls } = makeAgent({ id: 'a3', status: 'pending', vdxfData: { [ATTESTATION_IADDR]: hex } }, { sentinel });
    await assert.rejects(agent.acceptAttestationTuple('a3'), /SENTINEL_REACHED_TX_BUILD/);
    assert.strictEqual(calls.getChainInfo, 1, 'attestation accepted → reached tx build');
    assert.strictEqual(calls.broadcast, 0);
  });

  it('skips a non-pending item', async () => {
    const { agent, calls } = makeAgent({ id: 'a4', status: 'accepted', vdxfData: null });
    await agent.acceptAttestationTuple('a4');
    assert.strictEqual(calls.broadcast, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd j41-sovagent-sdk && yarn build && npx tsx --test test/accept-attestation.test.ts`
Expected: FAIL — `agent.acceptAttestationTuple is not a function` (and `VDXF_KEYS.review.attestation` undefined).

- [ ] **Step 3a: Add the VDXF key** — `src/onboarding/vdxf.ts`, change the `review` block (lines 65-68):

```typescript
  // 1 review namespace: record + attestation
  review: {
    record: 'iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad',   // agentplatform::review.record
    attestation: 'i76fJX1DreN81CoRVJHSkrcqHq9nsLomYv', // agentplatform::review.attestation (published testnet tx d8f57a4b)
  },
```

- [ ] **Step 3b: Add `acceptAttestationTuple`** — `src/agent.ts`, insert immediately after `acceptReview` closes (~line 1484). It is `acceptReview` with the allowlist narrowed to the single attestation key and messages/emit renamed:

```typescript
  /**
   * Accept a sovereign attestation tuple from the inbox and carry it on-chain.
   * Same opaque-passthrough pattern as acceptReview — the backend pre-formats the
   * tuple hex; we allowlist ONLY review.attestation and write it verbatim. We never
   * build or verify the tuple bytes (the buyer signature inside self-polices forgery).
   */
  async acceptAttestationTuple(inboxId: string): Promise<void> {
    if (!this.wif || !this.iAddress) {
      throw new Error(`Cannot accept attestation ${inboxId}: WIF key and i-address required`);
    }
    try {
      const { data: inboxItem } = await this._client.getInboxItem(inboxId);
      if (inboxItem.status !== 'pending') {
        console.log(`[J41] Inbox item ${inboxId} already ${inboxItem.status}, skipping`);
        return;
      }
      const [{ data: identityData }, utxoData] = await Promise.all([
        this._client.getIdentityRaw(),
        this._client.getUtxos(),
      ]);
      if (!identityData.prevOutput) {
        throw new Error(`Cannot accept attestation ${inboxId}: identity previous output not found`);
      }
      if (!utxoData.utxos || utxoData.utxos.length === 0) {
        throw new Error(`Cannot accept attestation ${inboxId}: no UTXOs available for TX fee`);
      }

      const vdxfAdditions: Record<string, unknown[]> = {};
      // Allowlist restricted to the single attestation key — a compromised platform
      // inbox must not be able to write any other VDXF key to our identity.
      const attestationAllowedIaddrs: Set<string> = new Set([VDXF_KEYS.review.attestation]);

      if (inboxItem.vdxfData && Object.keys(inboxItem.vdxfData).length > 0) {
        for (const [key, value] of Object.entries(inboxItem.vdxfData!)) {
          if (value != null) {
            if (!attestationAllowedIaddrs.has(key)) {
              console.error(
                `[J41] acceptAttestationTuple ${inboxId}: dropping unexpected VDXF key ${key} ` +
                `(not review.attestation) — possible platform tampering`,
              );
              continue;
            }
            vdxfAdditions[key] = Array.isArray(value) ? value : [value];
          }
        }
        if (Object.keys(vdxfAdditions).length === 0) {
          throw new Error(`acceptAttestationTuple ${inboxId}: inbox vdxfData contained no review.attestation keys after whitelist`);
        }
      } else {
        throw new Error(
          `acceptAttestationTuple ${inboxId}: inbox item has no VDXF review.attestation — ` +
          `refusing to synthesize one (would produce an unverifiable on-chain record)`,
        );
      }

      const { blockHeight: _tip } = await this._client.getChainInfo();
      const signedTxHex = buildIdentityUpdateTx({
        wif: this.wif, identityData, utxos: utxoData.utxos, vdxfAdditions,
        network: this.networkType, expiryHeight: computeExpiryHeight(_tip, IDENTITY_EXPIRY_DELTA),
      });
      const broadcastResult = await this._client.broadcast(signedTxHex);
      console.log(`[J41] ✅ Attestation written on-chain: ${broadcastResult.txid}`);
      await this._client.acceptInboxItem(inboxId, broadcastResult.txid);
      console.log(`[J41] ✅ Attestation accepted`);
      this.emit('attestation:accepted', { inboxId, txid: broadcastResult.txid });
    } catch (err) {
      console.error(`[J41] Failed to accept attestation ${inboxId}:`, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd j41-sovagent-sdk && yarn build && npx tsx --test test/accept-attestation.test.ts`
Expected: PASS (4 tests). Also run `npx tsc --noEmit` — no type errors.

- [ ] **Step 5: Commit**

```bash
cd j41-sovagent-sdk
git add src/onboarding/vdxf.ts src/agent.ts test/accept-attestation.test.ts
git commit -m "feat(sdk): acceptAttestationTuple + review.attestation VDXF key (opaque passthrough)"
```

---

## Task 2: Dispatcher — route `type:'attestation'` inbox items

**Files:**
- Modify: `j41-sovagent-dispatcher/src/cli.js` — `checkPendingInbox` (6222-6320): extract the per-item accept dispatch into a testable `dispatchInboxAccept`, add the `attestation` filter + case.
- Test: `j41-sovagent-dispatcher/test/inbox-attestation-routing.test.js`

**Interfaces:**
- Consumes: `agent.acceptAttestationTuple(inboxId)` (Task 1).
- Produces: `async function dispatchInboxAccept(agent, item, deps)` (exported under `NODE_ENV==='test'`) → `{ accepted:true } | { skip:true, reason } | { accepted:false }`.

- [ ] **Step 1: Write the failing test** — `test/inbox-attestation-routing.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const { dispatchInboxAccept } = require('../src/cli.js');

function spyAgent() {
  const calls = { review: [], job: [], attestation: [] };
  return {
    calls,
    acceptReview: async (id) => { calls.review.push(id); },
    acceptJobRecord: async (id) => { calls.job.push(id); },
    acceptAttestationTuple: async (id) => { calls.attestation.push(id); },
    client: { getInboxItem: async () => ({ data: { vdxfData: {} } }), getJobWitness: async () => ({}) },
  };
}
const deps = { verifyInboxJobRecord: async () => undefined, verifyWitness: async () => ({ verified: true }), network: 'verustest' };

test('attestation item routes to acceptAttestationTuple only', async () => {
  const agent = spyAgent();
  const r = await dispatchInboxAccept(agent, { id: 'x1', type: 'attestation' }, deps);
  assert.deepEqual(agent.calls.attestation, ['x1']);
  assert.deepEqual(agent.calls.review, []);
  assert.deepEqual(agent.calls.job, []);
  assert.equal(r.accepted, true);
});

test('review still routes to acceptReview', async () => {
  const agent = spyAgent();
  await dispatchInboxAccept(agent, { id: 'x2', type: 'review' }, deps);
  assert.deepEqual(agent.calls.review, ['x2']);
  assert.deepEqual(agent.calls.attestation, []);
});

test('job_record transient skip does not accept', async () => {
  const agent = spyAgent();
  const skipDeps = { ...deps, verifyInboxJobRecord: async () => ({ skip: true, reason: 'not yet' }) };
  const r = await dispatchInboxAccept(agent, { id: 'x3', type: 'job_record' }, skipDeps);
  assert.equal(r.skip, true);
  assert.deepEqual(agent.calls.job, []);
});

test('unknown type is a no-op', async () => {
  const agent = spyAgent();
  const r = await dispatchInboxAccept(agent, { id: 'x4', type: 'weird' }, deps);
  assert.equal(r.accepted, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd j41-sovagent-dispatcher && node --test test/inbox-attestation-routing.test.js`
Expected: FAIL — `dispatchInboxAccept is not a function`.

- [ ] **Step 3a: Extract `dispatchInboxAccept`** — add this function just above `checkPendingInbox` in `src/cli.js`:

```javascript
// Per-item inbox accept routing, extracted for testability. Returns
// { accepted:true } on a real accept, { skip:true, reason } for a transient
// job_record skip, { accepted:false } for an unhandled type. Throws bubble to
// the caller's dead-letter handling.
async function dispatchInboxAccept(agent, item, deps) {
  if (item.type === 'review') {
    console.log(`[Inbox] Processing review ${item.id}`);
    await agent.acceptReview(item.id);
    console.log(`[Inbox] ✅ Review accepted`);
    return { accepted: true };
  }
  if (item.type === 'attestation') {
    console.log(`[Inbox] Processing attestation ${item.id}`);
    await agent.acceptAttestationTuple(item.id);
    console.log(`[Inbox] ✅ Attestation accepted`);
    return { accepted: true };
  }
  if (item.type === 'job_record') {
    console.log(`[Inbox] Processing job record ${item.id}`);
    const { data: inboxItemDetail } = await agent.client.getInboxItem(item.id);
    const gateResult = await deps.verifyInboxJobRecord({
      inboxItemDetail,
      getJobWitness: (jobId) => agent.client.getJobWitness(jobId),
      verifyWitness: deps.verifyWitness,
      client: agent.client,
      network: deps.network,
    });
    if (gateResult && gateResult.skip) {
      console.log(`[Inbox] ⏭ Skipping job_record ${item.id} (transient): ${gateResult.reason}`);
      return { skip: true, reason: gateResult.reason };
    }
    await agent.acceptJobRecord(item.id);
    console.log(`[Inbox] ✅ Job record written on-chain`);
    return { accepted: true };
  }
  return { accepted: false };
}
```

- [ ] **Step 3b: Use it in `checkPendingInbox`** — replace the filter (6235-6237) and the inline `if/else if` accept block (6250-6284) so the loop body becomes:

```javascript
      const pending = (inbox?.data || []).filter(
        item => item.type === 'review' || item.type === 'job_record' || item.type === 'attestation'
      );
      if (pending.length === 0) continue;
      console.log(`[Inbox] ${agentInfo.id}: ${pending.length} pending item(s)`);

      const { verifyWitness } = require('@junction41/sovagent-sdk/dist/index.js');
      for (const item of pending) {
        seenInboxIds.add(item.id);
        if (isDeadLettered(state._inboxFailures, item.id)) continue;
        try {
          const r = await dispatchInboxAccept(agent, item, {
            verifyInboxJobRecord, verifyWitness, network: J41_NETWORK,
          });
          if (r && r.skip) continue; // transient — neither counted nor cleared
          clearInboxFailure(state._inboxFailures, item.id);
        } catch (e) {
          const dl = recordInboxFailure(state._inboxFailures, item.id, e.message);
          if (dl.justDeadLettered) {
            console.error(
              `[Inbox] ☠️  DEAD-LETTER ${item.type} ${item.id.substring(0, 8)} for ${agentInfo.id} ` +
              `after ${dl.attempts} attempts — quarantined, will NOT retry until restart. Last error: ${e.message}`,
            );
            state._agentErrors.set(agentInfo.id,
              `inbox ${item.type} ${item.id.substring(0, 8)} dead-lettered (${dl.attempts}x): ${String(e.message).slice(0, 100)}`);
          } else {
            console.error(`[Inbox] ❌ Failed to process ${item.type} ${item.id.substring(0, 8)} (attempt ${dl.attempts}/${MAX_INBOX_ATTEMPTS}): ${e.message}`);
          }
        }
      }
```

- [ ] **Step 3c: Export under test** — find the test-mode `module.exports` block in `cli.js` (search `NODE_ENV === 'test'`) and add `dispatchInboxAccept` to the exported object. If the accept path uses `verifyInboxJobRecord`, confirm it's already `require`d at the top of cli.js (it is — used at 6263 today).

- [ ] **Step 4: Run test + syntax check**

Run: `cd j41-sovagent-dispatcher && node --check src/cli.js && node --test test/inbox-attestation-routing.test.js`
Expected: `node --check` clean; 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd j41-sovagent-dispatcher
git add src/cli.js test/inbox-attestation-routing.test.js
git commit -m "feat(dispatcher): route attestation inbox items to acceptAttestationTuple (extract dispatchInboxAccept)"
```

---

## Task 3: SDK — dispute deadline types (`onJobDisputed` + `DisputeDetail`)

**Files:**
- Modify: `j41-sovagent-sdk/src/jobs/types.ts:56`
- Modify: `j41-sovagent-sdk/src/client/index.ts:2626-2641` (`DisputeDetail`)
- Test: `j41-sovagent-sdk/test/dispute-deadline-type.test.ts`

**Interfaces:**
- Produces: `onJobDisputed?(job: Job, reason: string, deadline?: string): Promise<void>`; `DisputeDetail.deadline_at?: string | null`, `.deadline_owner?: 'seller'|'buyer'|null`, `.deadline_passed?: boolean`.

- [ ] **Step 1: Write the failing test** — `test/dispute-deadline-type.test.ts` (type-level; compile is the assertion):

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { DisputeDetail } from '../src/client/index.js';
import type { JobHandler } from '../src/jobs/types.js';

describe('dispute deadline types', () => {
  it('DisputeDetail carries the deadline fields', () => {
    const d: DisputeDetail = {
      jobId: 'j', status: 'open', reason: 'r', filedBy: 'b', filedAt: 't',
      deadline_at: '2026-07-21T00:00:00Z', deadline_owner: 'seller', deadline_passed: false,
    };
    assert.equal(d.deadline_owner, 'seller');
  });
  it('onJobDisputed accepts a deadline arg', async () => {
    const h: JobHandler = { onJobDisputed: async (_job, _reason, deadline) => { assert.equal(typeof deadline, 'string'); } };
    await h.onJobDisputed!({ id: 'j' } as any, 'reason', '2026-07-21T00:00:00Z');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd j41-sovagent-sdk && npx tsc --noEmit`
Expected: FAIL — `deadline_at`/`deadline_owner`/`deadline_passed` not on `DisputeDetail`, and `onJobDisputed` takes 2 args.

- [ ] **Step 3a: Extend `onJobDisputed`** — `src/jobs/types.ts:55-56`:

```typescript
  /** Called when a job is disputed. `deadline` is the ISO deadline_at from GET /dispute (may be undefined). */
  onJobDisputed?(job: Job, reason: string, deadline?: string): Promise<void>;
```

- [ ] **Step 3b: Extend `DisputeDetail`** — `src/client/index.ts`, add three fields inside the interface (after `resolvedAt`):

```typescript
  refundTxid?: string | null;
  resolvedAt?: string | null;
  /** SLA deadline for the next move (added 2026-07 dispute resolver). */
  deadline_at?: string | null;
  deadline_owner?: 'seller' | 'buyer' | null;
  deadline_passed?: boolean;
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd j41-sovagent-sdk && npx tsc --noEmit && yarn build && npx tsx --test test/dispute-deadline-type.test.ts`
Expected: tsc clean; 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd j41-sovagent-sdk
git add src/jobs/types.ts src/client/index.ts test/dispute-deadline-type.test.ts
git commit -m "feat(sdk): dispute deadline types (onJobDisputed deadline arg + DisputeDetail deadline fields)"
```

---

## Task 4: Dispatcher — `queueDisputedJobForRespawn` + wire webhook & poll

**Files:**
- Modify: `j41-sovagent-dispatcher/src/cli.js` — add `queueDisputedJobForRespawn` near `respawnReadyResumes` (~4557); wire webhook `job.disputed` (5961-5970) and poll `disputed` (5650-5652).
- Test: `j41-sovagent-dispatcher/test/dispute-respawn.test.js`

**Interfaces:**
- Consumes: `rq.enqueue`, `respawnReadyResumes(state)`, `sendToJobAgent(info, msg)`, `persistReactivationQueue`, `state.emitEvent`.
- Produces: `async function queueDisputedJobForRespawn(state, jobId, opts)` where `opts = { agentId?, reason?, ...deps }`. Returns `{ forwarded } | { respawned } | { unresolved }`.

- [ ] **Step 1: Write the failing test** — `test/dispute-respawn.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const { queueDisputedJobForRespawn } = require('../src/cli.js');

function baseState() {
  return {
    active: new Map(),
    reactivationQueue: [],
    agents: [{ id: 'agent-1', iAddress: 'iSeller111', identity: 'seller.agentplatform@' }],
    emitted: [],
    emitEvent(type, data) { this.emitted.push({ type, data }); },
  };
}

test('live job forwards dispute.filed via sendToJobAgent (not process.send)', async () => {
  const state = baseState();
  const info = { agentInfo: { id: 'agent-1' } };
  state.active.set('job-live', info);
  const sent = [];
  const r = await queueDisputedJobForRespawn(state, 'job-live', {
    reason: 'bad work',
    sendToJobAgent: (i, m) => { sent.push({ i, m }); return true; },
  });
  assert.equal(r.forwarded, true);
  assert.equal(sent[0].m.type, 'dispute.filed');
  assert.equal(sent[0].m.data.reason, 'bad work');
  assert.equal(state.reactivationQueue.length, 0);
});

test('torn-down job resolves seller, enqueues ready entry, respawns', async () => {
  const state = baseState();
  let respawned = 0;
  const r = await queueDisputedJobForRespawn(state, 'job-gone', {
    agentId: 'agent-1',
    getJob: async () => ({ id: 'job-gone', sellerVerusId: 'iSeller111' }),
    respawnReadyResumes: async () => { respawned++; },
    persistReactivationQueue: () => {},
  });
  assert.equal(r.respawned, true);
  assert.equal(state.reactivationQueue.length, 1);
  const e = state.reactivationQueue[0];
  assert.equal(e.job.id, 'job-gone');
  assert.equal(e.agentId, 'agent-1');
  assert.equal(e.readyToRespawn, true);
  assert.equal(e.dispute, true);
  assert.equal(respawned, 1);
});

test('unresolvable seller emits event and does NOT enqueue', async () => {
  const state = baseState();
  const r = await queueDisputedJobForRespawn(state, 'job-orphan', {
    agentId: 'agent-1',
    getJob: async () => ({ id: 'job-orphan', sellerVerusId: 'iUnknownSeller' }),
    respawnReadyResumes: async () => { throw new Error('must not respawn'); },
    persistReactivationQueue: () => {},
  });
  assert.equal(r.unresolved, true);
  assert.equal(state.reactivationQueue.length, 0);
  assert.ok(state.emitted.find(e => e.type === 'dispute.unresolved_agent'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd j41-sovagent-dispatcher && node --test test/dispute-respawn.test.js`
Expected: FAIL — `queueDisputedJobForRespawn is not a function`.

- [ ] **Step 3a: Add the function** — in `src/cli.js` after `respawnReadyResumes` (~4557). Add a module constant `const DISPUTE_RESPAWN_TTL_MIN = 720;` near the other reactivation constants:

```javascript
// Route a job.disputed observation to a worker. Live jobs get the dispute
// forwarded to their running container; torn-down jobs are respawned via the
// same reactivation-queue machinery job.resumed uses. Never silently drops:
// an unresolvable seller emits dispute.unresolved_agent. The respawned worker
// fetches the authoritative deadline itself (getDispute) — we plumb no deadline.
async function queueDisputedJobForRespawn(state, jobId, opts = {}) {
  const send = opts.sendToJobAgent || sendToJobAgent;
  const respawn = opts.respawnReadyResumes || respawnReadyResumes;
  const persist = opts.persistReactivationQueue || persistReactivationQueue;

  const active = state.active.get(jobId);
  if (active) {
    send(active, { type: 'dispute.filed', data: { jobId, reason: opts.reason } });
    return { forwarded: true };
  }

  // Torn-down: resolve the job + its local agent, then respawn.
  const findAgent = (id) => state.agents.find(a => a.id === id);
  const agentInfo = opts.agentId ? findAgent(opts.agentId) : null;
  let job;
  try {
    if (opts.getJob) job = await opts.getJob(jobId);
    else if (agentInfo) {
      const session = await getAgentSession(state, agentInfo);
      job = await session.client.getJob(jobId);
    }
  } catch (e) {
    console.error(`[Dispute] Could not fetch torn-down job ${jobId.substring(0, 8)}: ${e.message}`);
  }
  if (!job) {
    state.emitEvent?.('dispute.unresolved_agent', { jobId, reason: 'job-fetch-failed' });
    return { unresolved: true };
  }

  const sellerId = job.sellerVerusId || job.seller || job.agentVerusId;
  const match = state.agents.find(a => a.iAddress === sellerId || a.identity === sellerId);
  if (!match) {
    console.error(`[Dispute] job ${jobId.substring(0, 8)} seller ${sellerId} not a local agent — cannot respawn`);
    state.emitEvent?.('dispute.unresolved_agent', { jobId, seller: sellerId });
    return { unresolved: true };
  }

  rq.enqueue(state.reactivationQueue, {
    job, agentId: match.id, pausedAt: Date.now(),
    pauseTtlMin: DISPUTE_RESPAWN_TTL_MIN, readyToRespawn: true, dispute: true,
  });
  persist(state.reactivationQueue);
  console.log(`[Dispute] job ${jobId.substring(0, 8)} torn-down → queued + respawning for ${match.id}`);
  await respawn(state);
  return { respawned: true };
}
```

- [ ] **Step 3b: Wire the webhook** — replace the `job.disputed` case body (5961-5970):

```javascript
    case 'job.disputed':
    case 'job.dispute.filed': {
      console.log(`[Webhook] ⚠️  Dispute filed for job ${jobId?.substring(0, 8)} by ${data?.disputedBy || '?'}: ${data?.reason || '?'}`);
      await queueDisputedJobForRespawn(state, jobId, { agentId, reason: data?.reason });
      break;
    }
```

(Confirm `handleWebhookEvent`'s signature exposes `agentId` — it is `handleWebhookEvent(state, agentId, payload)`.)

- [ ] **Step 3c: Wire the poll** — replace the poll `disputed` branch (5650-5652):

```javascript
      } else if (currentJob.status === 'disputed') {
        await queueDisputedJobForRespawn(state, jobId, { agentId: activeInfo.agentInfo?.id, reason: currentJob.dispute?.reason });
        state._lastSentStatus.set(jobId, currentJob.status);
```

- [ ] **Step 3d: Export under test** — add `queueDisputedJobForRespawn` to the `NODE_ENV==='test'` exports in cli.js.

- [ ] **Step 4: Run test + syntax check**

Run: `cd j41-sovagent-dispatcher && node --check src/cli.js && node --test test/dispute-respawn.test.js`
Expected: clean; 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd j41-sovagent-dispatcher
git add src/cli.js test/dispute-respawn.test.js
git commit -m "feat(dispatcher): queueDisputedJobForRespawn — respawn torn-down disputes, fix webhook process.send gap"
```

---

## Task 5: Worker — post-delivery reconnect for delivered/disputed jobs

**Files:**
- Modify: `j41-sovagent-dispatcher/src/job-agent.js` — `main()` (accept block ~363; work+deliver block 542-608; export a status predicate).
- Test: `j41-sovagent-dispatcher/test/post-delivery-reconnect.test.js`

**Interfaces:**
- Produces: `isPostDeliveryReconnect(status)` (exported under test) → `true` for `'delivered'|'disputed'`. Behavior: a worker spawned for such a job skips accept + work + delivery and falls through to the existing post-delivery wait.

- [ ] **Step 1: Write the failing test** — `test/post-delivery-reconnect.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const { isPostDeliveryReconnect } = require('../src/job-agent.js');

test('delivered and disputed are post-delivery reconnects', () => {
  assert.equal(isPostDeliveryReconnect('delivered'), true);
  assert.equal(isPostDeliveryReconnect('disputed'), true);
});
test('accepted/in_progress/paused are not', () => {
  for (const s of ['accepted', 'in_progress', 'paused', 'completed', undefined]) {
    assert.equal(isPostDeliveryReconnect(s), false, `${s} must not be a reconnect`);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd j41-sovagent-dispatcher && node --test test/post-delivery-reconnect.test.js`
Expected: FAIL — `isPostDeliveryReconnect is not a function`.

- [ ] **Step 3a: Add the predicate + export** — near the top helpers of `job-agent.js`:

```javascript
// A worker spawned for an already-delivered or disputed job must NOT redo the
// work or re-deliver — it reconnects straight into the post-delivery wait so it
// can surface/handle a dispute. (Fixes the job-agent.js:600 "not deliverable →
// exit" drop that made torn-down disputes unreachable.)
function isPostDeliveryReconnect(status) {
  return status === 'delivered' || status === 'disputed';
}
```

Add `isPostDeliveryReconnect` to the `NODE_ENV==='test'` export object (the one that already exports `handleBudgetDelivery`, `nextPollSince`, `chunkMessage`, etc.).

- [ ] **Step 3b: Compute the flag + guard the accept** — after `getJob` (line 358), add:

```javascript
  const _isPostDeliveryReconnect = isPostDeliveryReconnect(fullJob.status);
```

Change the accept guard (line 363) so a reconnect is treated as already-accepted:

```javascript
  if (_isPostDeliveryReconnect || fullJob.status === 'accepted' || fullJob.status === 'in_progress') {
    log.info('Job already accepted (or post-delivery reconnect)', { jobId: JOB_ID, status: fullJob.status });
  } else {
```

- [ ] **Step 3c: Guard the work + delivery block** — wrap the `try { … processJob … }` (line 543) through the end of STEP 3 delivery (line 608) in a single `if (!_isPostDeliveryReconnect) { … }`. The block to wrap starts at `let result;` (542) and ends after the delivery `try/catch` closes (608), immediately before the `// Signal workspace done` comment (610). On a reconnect, `result`, delivery, and workspace-done are all skipped; flow falls to STEP 4 (post-delivery wait). Concretely:

```javascript
  if (!_isPostDeliveryReconnect) {
    let result;
    try {
      job.status = fullJob.status;
      result = await processJob(job, agent, soulPrompt, executor, (resolve) => { setSessionEndResolve(resolve); });
      // ... existing body through the delivery try/catch (unchanged) ...
    }
    // Signal workspace done to buyer
    if (_workspaceConnected) { _agent.workspace.signalDone(); console.log('[WORKSPACE] Signaled done to buyer'); }
    await new Promise(r => setTimeout(r, 3000));
  }
```

(Keep every existing line inside verbatim — only add the `if (!_isPostDeliveryReconnect) {` opener after the STEP 2 IPC setup and the closing `}` before STEP 4. The `return;` early-exits inside the delivery catch stay as-is.)

- [ ] **Step 3d: Make reconnect chat non-fatal** — the connectChat block (378-395) currently, on failure, delivers a failure result + `process.exit(1)`. For a reconnect that path is wrong (nothing to deliver). Guard it:

```javascript
  try {
    await agent.connectChat();
    console.log('✅ Connected to SovGuard\n');
  } catch (chatErr) {
    if (_isPostDeliveryReconnect) {
      console.error('❌ Chat connect failed on post-delivery reconnect — continuing to post-delivery wait:', chatErr.message);
    } else {
      // ... existing deliver-failure + process.exit(1) path unchanged ...
    }
  }
```

- [ ] **Step 4: Run test + syntax check**

Run: `cd j41-sovagent-dispatcher && node --check src/job-agent.js && node --test test/post-delivery-reconnect.test.js`
Expected: clean; 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd j41-sovagent-dispatcher
git add src/job-agent.js test/post-delivery-reconnect.test.js
git commit -m "feat(worker): post-delivery reconnect — skip work/delivery for delivered/disputed jobs"
```

---

## Task 6: Worker — `surfaceDispute` + wire handler + remove silent auto-policy

**Files:**
- Modify: `j41-sovagent-dispatcher/src/job-agent.js` — add `surfaceDispute`; call it on disputed-startup and from the `dispute.filed` IPC handler (1526-1588); wire `onJobDisputed` in `setHandler` (411); remove the VDXF auto-policy block.
- Test: `j41-sovagent-dispatcher/test/dispute-surface.test.js`

**Interfaces:**
- Consumes: `agent.client.getDispute(jobId)` → `{ reason, deadline_at, deadline_owner }` (Task 3 fields); `agent.sendChatMessage`; `agent.handler.onJobDisputed(job, reason, deadline)`.
- Produces: `async function surfaceDispute(job, agent)` (exported under test) — fetches the dispute, fires the handler hook with the deadline, sends one operator-facing chat message, returns `{ surfaced:true, deadline_at }`. Never calls `respondToDispute`.

- [ ] **Step 1: Write the failing test** — `test/dispute-surface.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const { surfaceDispute } = require('../src/job-agent.js');

function fakeAgent(dispute) {
  const sent = [];
  let handlerArgs = null;
  return {
    sent, getHandlerArgs: () => handlerArgs,
    handler: { onJobDisputed: async (j, r, d) => { handlerArgs = { j: j.id, r, d }; } },
    sendChatMessage: async (jobId, text) => { sent.push({ jobId, text }); },
    client: {
      getDispute: async () => dispute,
      getJob: async () => ({ id: 'job-1', status: 'disputed' }),
      respondToDispute: async () => { throw new Error('surface-only must NOT respond'); },
    },
  };
}

test('surfaces reason + deadline to operator, fires handler, never responds', async () => {
  const agent = fakeAgent({ reason: 'incomplete', deadline_at: '2026-07-21T00:00:00Z', deadline_owner: 'seller' });
  const r = await surfaceDispute({ id: 'job-1' }, agent);
  assert.equal(r.surfaced, true);
  assert.equal(r.deadline_at, '2026-07-21T00:00:00Z');
  assert.equal(agent.sent.length, 1);
  assert.match(agent.sent[0].text, /2026-07-21/);
  assert.match(agent.sent[0].text, /incomplete/);
  const h = agent.getHandlerArgs();
  assert.deepEqual(h, { j: 'job-1', r: 'incomplete', d: '2026-07-21T00:00:00Z' });
});

test('tolerates a null deadline', async () => {
  const agent = fakeAgent({ reason: 'x', deadline_at: null, deadline_owner: null });
  const r = await surfaceDispute({ id: 'job-1' }, agent);
  assert.equal(r.surfaced, true);
  assert.equal(agent.sent.length, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd j41-sovagent-dispatcher && node --test test/dispute-surface.test.js`
Expected: FAIL — `surfaceDispute is not a function`.

- [ ] **Step 3a: Add `surfaceDispute`** — near `waitForPostDelivery` in `job-agent.js`:

```javascript
// Surface a dispute to the operator (human has final say — no auto-response).
// Fetches the authoritative deadline from the platform, fires the handler hook,
// and posts ONE operator-facing chat message. A future agent-autonomous policy
// engine would decide a response here; for now we only surface.
async function surfaceDispute(job, agent) {
  let d = {};
  try { d = (await agent.client.getDispute(job.id)) || {}; }
  catch (e) { console.error(`[DISPUTE] getDispute failed for ${job.id}: ${e.message}`); }

  const reason = d.reason || 'no reason given';
  const deadline_at = d.deadline_at || null;
  const owner = d.deadline_owner || null;
  const when = deadline_at ? `by ${deadline_at}` : 'soon (no deadline set)';
  const whose = owner === 'seller' ? "it's your move" : owner === 'buyer' ? "waiting on the buyer" : '';

  if (agent.handler?.onJobDisputed) {
    try {
      const freshJob = await agent.client.getJob(job.id).catch(() => job);
      await agent.handler.onJobDisputed(freshJob, reason, deadline_at || undefined);
    } catch (e) { console.error(`[DISPUTE] handler error: ${e.message}`); }
  }

  try {
    await agent.sendChatMessage(job.id,
      `⚠️ A dispute was filed on this job: "${reason}". A response is needed ${when}${whose ? ` — ${whose}` : ''}.`);
  } catch (e) { console.error(`[DISPUTE] surface chat failed: ${e.message}`); }

  console.log(`[DISPUTE] surfaced job ${job.id} — reason="${reason}" deadline=${deadline_at || 'none'} owner=${owner || 'n/a'}`);
  return { surfaced: true, deadline_at };
}
```

Add `surfaceDispute` to the `NODE_ENV==='test'` exports.

- [ ] **Step 3b: Replace the `dispute.filed` IPC handler body** — in `waitForPostDelivery` (1526-1588), replace the whole `case 'dispute.filed': { … }` body (the handler-hook call AND the `_disputePolicy` auto-response block) with:

```javascript
        case 'dispute.filed': {
          console.log(`⚠️  Dispute filed: ${msg.data?.reason || 'no reason'}`);
          await surfaceDispute(job, agent);
          // Surface-only: the operator (human) has the final say. A future
          // agent-autonomous policy engine would decide a response here.
          // Stay alive — wait for resolution.
          break;
        }
```

- [ ] **Step 3c: Surface on disputed-startup** — in `main()`, immediately before STEP 4's `waitForPostDelivery` call (line 627-629), add:

```javascript
  if (fullJob.status === 'disputed') {
    await surfaceDispute(job, agent).catch((e) => console.error('[DISPUTE] startup surface failed:', e.message));
  }
```

- [ ] **Step 3d: Wire `onJobDisputed` in `setHandler`** — extend the `setHandler({...})` call (411-419) with a thin, no-longer-dead hook:

```javascript
  agent.setHandler({
    onSessionEnding: async (sessionJob, reason, requestedBy) => {
      console.log(`[SESSION] Session ending for job ${sessionJob.id} — reason: ${reason}, requestedBy: ${requestedBy}`);
      if (sessionJob.id === job.id && sessionEndResolve) {
        agent.sendChatMessage(job.id, 'Session ended — wrapping up and delivering results. Thank you!');
        sessionEndResolve('session-ended');
      }
    },
    onJobDisputed: async (dJob, reason, deadline) => {
      console.log(`[SESSION] onJobDisputed hook: job ${dJob.id} reason="${reason}" deadline=${deadline || 'none'}`);
    },
  });
```

- [ ] **Step 4: Run test + syntax check**

Run: `cd j41-sovagent-dispatcher && node --check src/job-agent.js && node --test test/dispute-surface.test.js`
Expected: clean; 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd j41-sovagent-dispatcher
git add src/job-agent.js test/dispute-surface.test.js
git commit -m "feat(worker): surfaceDispute (surface-only) + wire onJobDisputed, remove silent VDXF auto-policy"
```

---

## Final verification (after all tasks)

- [ ] SDK: `cd j41-sovagent-sdk && npx tsc --noEmit && yarn build && npx tsx --test test/*.test.ts` — all green.
- [ ] Dispatcher: `cd j41-sovagent-dispatcher && node --check src/*.js src/executors/*.js && node --test test/*.js` — all green (prior 519 + new tests).
- [ ] Grep guard: `grep -n "process.send({ type: 'dispute.filed'" src/cli.js` returns nothing (webhook no longer bypasses Docker).
- [ ] Grep guard: `grep -n "Auto per VDXF policy" src/job-agent.js` returns nothing (silent auto-policy removed).

## Rollout (post-merge, needs backend deploy)

1. Backend deploys migration 051 + rebuild → endpoints live.
2. `cd j41-sovagent-sdk && yarn build`; republish/relink SDK; rebuild job-agent image (`DOCKER_BUILDKIT=1 J41_USE_LOCAL_SDK=1 J41_SDK_DIR=../j41-sovagent-sdk ./scripts/build-image.sh`); restart dispatcher.
3. Live-test A: real job → completion → attestation tuple on agent's ID (inbox `type:'attestation'` accepted).
4. Live-test B: file a dispute after container teardown → worker respawns → operator sees the surfaced dispute + deadline in chat.
5. Enable `DISPUTE_RESOLVER_ENABLED` in concert (operator's call, after the settlement product decision).
