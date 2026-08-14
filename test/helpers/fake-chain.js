'use strict';
/**
 * A small, honest model of the two status axes and the mempool rule that keeps
 * biting us.
 *
 * The one invariant worth encoding above all others:
 *
 *   An identity may have at most ONE unconfirmed write in flight. A second write
 *   before the first confirms is rejected with a bare `-25`, because the platform
 *   builds the next transaction from the LAST CONFIRMED prevOutput — so both
 *   spend the same output.
 *
 * That is the production failure this release exists to remove (9 rejected
 * writes, then 5, then 3 across three restarts). Modelling it means a harnessed
 * scenario reproduces the bug rather than describing it: any code path that
 * writes twice fails here the same way it fails on testnet.
 *
 * The two axes are modelled separately and deliberately do not track each other:
 *   chainStatus     changes only when a write CONFIRMS (the indexer reads chain)
 *   platformStatus  changes the instant a signed POST lands (indexer never writes it)
 *
 * Confirmation is lazy and clock-driven: a pending write matures once `blockTimeMs`
 * of (virtual) time has passed. Nothing here schedules a timer, so the model works
 * identically under the virtual clock and under real time.
 */

class RejectedByNetwork extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'RejectedByNetwork';
    this.code = -25;
  }
}

class FakeChain {
  /**
   * @param {Array<object>} agents  [{ id, iAddress, identity, chainStatus, platformStatus }]
   * @param {object} [opts]
   * @param {number} [opts.blockTimeMs=60000]  how long a write takes to confirm
   * @param {number} [opts.startHeight=1000]
   */
  constructor(agents, opts = {}) {
    this.blockTimeMs = opts.blockTimeMs ?? 60000;
    this.height = opts.startHeight ?? 1000;
    this.rejections = [];
    this.confirmed = [];
    this.byId = new Map();
    for (const a of agents) {
      this.byId.set(a.id, {
        id: a.id,
        iAddress: a.iAddress,
        identity: a.identity,
        chainStatus: a.chainStatus ?? 'active',
        platformStatus: a.platformStatus ?? 'active',
        prevOutput: a.prevOutput ?? `tx-genesis-${a.id}`,
        // { txid, status, at }. A seeded pending write (the upgrade scenario:
        // last shutdown's deactivate is still in the mempool) gets `at: null`,
        // resolved to the clock's first observed `now` — the stub is built before
        // any test code runs, so it must not bake in a construction-time stamp.
        pending: a.pending ? { txid: a.pending.txid, status: a.pending.status, at: null } : null,
        writes: 0,
      });
    }
  }

  get(agentIdOrAddress) {
    if (this.byId.has(agentIdOrAddress)) return this.byId.get(agentIdOrAddress);
    for (const rec of this.byId.values()) {
      if (rec.iAddress === agentIdOrAddress || rec.identity === agentIdOrAddress) return rec;
    }
    return null;
  }

  /** Promote any pending write whose block has arrived. Called on every read. */
  _tick(now = Date.now()) {
    for (const rec of this.byId.values()) {
      if (rec.pending && rec.pending.at == null) rec.pending.at = now;
      if (rec.pending && now - rec.pending.at >= this.blockTimeMs) {
        rec.chainStatus = rec.pending.status;
        rec.prevOutput = rec.pending.txid;
        this.height++;
        this.confirmed.push({ agentId: rec.id, txid: rec.pending.txid, status: rec.pending.status, at: now });
        rec.pending = null;
      }
    }
  }

  /**
   * Broadcast an identity write. Throws `-25` if one is already unconfirmed —
   * the double-spend.
   * @returns {string} txid
   */
  write(agentIdOrAddress, status, now = Date.now()) {
    this._tick(now);
    const rec = this.get(agentIdOrAddress);
    if (!rec) throw new Error(`unknown identity: ${agentIdOrAddress}`);
    if (rec.pending) {
      this.rejections.push({ agentId: rec.id, status, at: now, collidedWith: rec.pending.txid });
      throw new RejectedByNetwork(
        'Transaction rejected by the network: -25 bad-txns-inputs-missingorspent',
      );
    }
    rec.writes++;
    const txid = `tx-${rec.id}-${status}-${rec.writes}`;
    rec.pending = { txid, status, at: now };
    return txid;
  }

  /** Force-confirm everything in flight (a test shortcut for "a block arrived"). */
  mineBlock(now = Date.now()) {
    for (const rec of this.byId.values()) {
      if (rec.pending) {
        rec.chainStatus = rec.pending.status;
        rec.prevOutput = rec.pending.txid;
        this.confirmed.push({ agentId: rec.id, txid: rec.pending.txid, status: rec.pending.status, at: now });
        rec.pending = null;
      }
    }
    this.height++;
  }

  /** What `GET /v1/agents/:id` would report: chain axis + platform axis. */
  profile(agentIdOrAddress, now = Date.now()) {
    this._tick(now);
    const rec = this.get(agentIdOrAddress);
    if (!rec) return null;
    return {
      id: rec.iAddress,
      name: rec.identity,
      status: rec.chainStatus,
      platformStatus: rec.platformStatus,
    };
  }

  /** What `getIdentityRaw` would report — LAST CONFIRMED prevOutput, never the pending one. */
  identityRaw(agentIdOrAddress, now = Date.now()) {
    this._tick(now);
    const rec = this.get(agentIdOrAddress);
    if (!rec) return { data: {} };
    return {
      data: {
        identity: {
          name: rec.identity,
          identityaddress: rec.iAddress,
          contentmultimap: {},
        },
        prevOutput: { txid: rec.prevOutput },
        blockHeight: this.height,
      },
    };
  }

  setPlatformStatus(agentIdOrAddress, status) {
    const rec = this.get(agentIdOrAddress);
    if (!rec) throw new Error(`unknown identity: ${agentIdOrAddress}`);
    rec.platformStatus = status;
    return { status };
  }

  /** Every agent whose two axes are both `active` — i.e. actually hireable. */
  hireable(now = Date.now()) {
    this._tick(now);
    return [...this.byId.values()]
      .filter((r) => r.chainStatus === 'active' && r.platformStatus === 'active')
      .map((r) => r.id);
  }

  snapshot(now = Date.now()) {
    this._tick(now);
    const out = {};
    for (const [id, r] of this.byId) {
      out[id] = {
        chain: r.chainStatus,
        platform: r.platformStatus,
        prevOutput: r.prevOutput,
        pending: r.pending ? r.pending.txid : null,
        writes: r.writes,
      };
    }
    return out;
  }
}

module.exports = { FakeChain, RejectedByNetwork };
