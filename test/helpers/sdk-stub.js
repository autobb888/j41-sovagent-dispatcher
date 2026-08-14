'use strict';
/**
 * Scenario-driven stub of `@junction41/sovagent-sdk`, backed by {@link FakeChain}.
 *
 * The point of this file is the AUDIT LOG. Every call the dispatcher makes into
 * the SDK is recorded with its arguments and result, so a test can assert
 *
 *     assert.equal(auditCount('setOnChainStatus'), 9)
 *
 * — "exactly one on-chain write per agent" — instead of grepping cli.js for the
 * identifier and passing against `if (false)`. Three of the five review rounds
 * on 2.29.0 shipped a defect that a source-text test claimed to cover.
 *
 * Unstubbed methods are NOT an error. They return `null`, and they are recorded
 * as `unstubbed:<name>` so the audit log tells you exactly what the real code
 * reached for. That keeps the stub honest: it grows from observed behaviour
 * rather than from my guesses about the SDK surface.
 */

const { FakeChain } = require('./fake-chain');

/**
 * Does an audit entry's call name refer to `needle`?
 *
 * `needle` is a bare method name matched EXACTLY against the recorded name and
 * its two decorated forms (`client.foo`, `unstubbed:client.foo`), or a RegExp
 * when a test genuinely wants loose matching. See the note on `calls` below for
 * why substring matching is banned here.
 */
function matchCall(call, needle) {
  if (needle instanceof RegExp) return needle.test(call);
  return call === needle
    || call === `client.${needle}`
    || call === `unstubbed:client.${needle}`;
}

/**
 * @param {object} scenario
 * @param {Array<object>} scenario.agents        [{ id, identity, iAddress, chainStatus, platformStatus }]
 * @param {object}  [scenario.version]           body served for GET /v1/version
 * @param {number}  [scenario.blockTimeMs]
 * @param {object}  [scenario.faults]            { agentId|'*': { method: [spec, ...] } }
 * @param {object}  [scenario.responses]         { methodName: value | (args, ctx) => value }
 * @param {boolean} [scenario.authFails]
 */
function createSdkStub(scenario = {}) {
  const agents = scenario.agents || [];
  const chain = new FakeChain(agents, { blockTimeMs: scenario.blockTimeMs });
  const audit = [];
  const faultCursor = new Map();

  function record(entry) {
    audit.push({ n: audit.length + 1, at: Date.now(), ...entry });
    return entry;
  }

  /**
   * Faults are consumed in order, one per call: `['throw:dry fee tank', 'ok']`
   * fails the first attempt and lets the second through. That is how the
   * "repair fails, next start succeeds" scenario is expressed.
   */
  function nextFault(agentId, method) {
    const table = (scenario.faults || {});
    const list = (table[agentId] && table[agentId][method]) || (table['*'] && table['*'][method]);
    if (!Array.isArray(list) || list.length === 0) return null;
    const key = `${agentId}:${method}`;
    const i = faultCursor.get(key) || 0;
    faultCursor.set(key, i + 1);
    // Past the end of the list means "no fault" — the list is a prefix of history.
    return list[i] ?? null;
  }

  function applyFault(spec) {
    if (!spec || spec === 'ok') return { kind: 'ok' };
    if (typeof spec === 'string' && spec.startsWith('throw:')) {
      return { kind: 'throw', error: new Error(spec.slice(6)) };
    }
    if (typeof spec === 'object' && 'throw' in spec) {
      const e = new Error(spec.throw);
      if (spec.code) e.code = spec.code;
      return { kind: 'throw', error: e };
    }
    if (typeof spec === 'object' && 'return' in spec) return { kind: 'return', value: spec.return };
    return { kind: 'ok' };
  }

  const DEFAULTS = {
    getMyJobs: () => ({ data: [] }),
    getMyServices: () => ({ data: [] }),
    getAgentServices: () => ({ data: [] }),
    getInbox: () => ({ data: [] }),
    getInboxCount: () => ({ data: { count: 0 } }),
    getExtensions: () => ({ data: [] }),
    getBounties: () => ({ data: [] }),
    getMyBounties: () => ({ data: [] }),
    listWebhooks: () => ({ data: [] }),
    getUtxos: () => ({ utxos: [{ satoshis: 500000, txid: 'utxo-1', vout: 0 }] }),
    getChainInfo: () => ({ blockHeight: chain.height }),
    getVrscUsdRate: () => ({ usdPerVrsc: 1.5, ttlSeconds: 300, source: 'stub' }),
    getReputation: () => ({ data: { score: 100 } }),
    getMyIdentity: () => ({ data: {} }),
    getSessionToken: () => 'stub-session-token',
    refreshAgent: () => ({ data: {} }),
    getServiceCategories: () => ({ data: [] }),
    resolveNames: () => ({ data: {} }),
  };

  /** Client bound to one agent (or to no agent at all, for the version probe). */
  function makeClient(agentRec) {
    const agentId = agentRec ? agentRec.id : '(no-agent)';

    const explicit = {
      request: async (method, path) => {
        if (method === 'GET' && path === '/v1/version') {
          if (scenario.version === undefined) {
            return { version: '2.29.0-stub', features: ['agent.platform-status-v1', 'tx.status-notfound-code'] };
          }
          if (scenario.version instanceof Error) throw scenario.version;
          return scenario.version;
        }
        return null;
      },
      getAgent: async (idOrAddr) => chain.profile(idOrAddr ?? (agentRec && agentRec.iAddress)),
      getIdentityRaw: async (idOrAddr) => chain.identityRaw(idOrAddr ?? (agentRec && agentRec.iAddress)),
      setAgentStatus: async (verusId, status) => chain.setPlatformStatus(verusId, status),
    };

    const handler = {
      get(_t, prop) {
        if (typeof prop === 'symbol' || prop === 'then' || prop === 'inspect') return undefined;
        return async (...args) => {
          const fault = applyFault(nextFault(agentId, prop));
          if (fault.kind === 'throw') {
            record({ agent: agentId, call: `client.${prop}`, args, ok: false, error: fault.error.message });
            throw fault.error;
          }
          if (fault.kind === 'return') {
            record({ agent: agentId, call: `client.${prop}`, args, ok: true, result: fault.value, faulted: true });
            return fault.value;
          }

          const override = scenario.responses && scenario.responses[prop];
          let result;
          let tag = `client.${prop}`;
          if (override !== undefined) {
            result = typeof override === 'function' ? await override(args, { agentRec, chain }) : override;
          } else if (explicit[prop]) {
            result = await explicit[prop](...args);
          } else if (DEFAULTS[prop]) {
            result = DEFAULTS[prop](...args);
          } else {
            tag = `unstubbed:client.${prop}`;
            result = null;
          }
          record({ agent: agentId, call: tag, args, ok: true, result });
          return result;
        };
      },
    };
    return new Proxy({}, handler);
  }

  class J41Agent {
    constructor(cfg = {}) {
      this.apiUrl = cfg.apiUrl;
      this.wif = cfg.wif;
      this.identityName = cfg.identityName;
      this.iAddress = cfg.iAddress;
      this._rec = chain.get(cfg.iAddress || cfg.identityName);
      this._agentId = this._rec ? this._rec.id : (cfg.identityName || 'unknown');
      this.client = makeClient(this._rec);
      this._client = this.client;
    }

    async authenticate() {
      // Per-agent, per-call faults as well as the fleet-wide `authFails`. A list
      // like `[{throw:'503'}]` fails only the FIRST authenticate for that agent,
      // which is how the startup status probe is made to fail while the later
      // activation session still succeeds — the fail-open "including" path.
      const fault = applyFault(nextFault(this._agentId, 'authenticate'));
      if (fault.kind === 'throw') {
        record({ agent: this._agentId, call: 'authenticate', args: [], ok: false, error: fault.error.message });
        throw fault.error;
      }
      record({ agent: this._agentId, call: 'authenticate', args: [], ok: !scenario.authFails });
      if (scenario.authFails) {
        const e = new Error('platform unavailable (503 CHAIN_SYNCING)');
        e.status = 503;
        throw e;
      }
      return { ok: true };
    }

    async login() { return this.authenticate(); }

    async activate(options = {}) {
      const onChain = options.onChain ?? true;
      const fault = applyFault(nextFault(this._agentId, 'activate'));
      if (fault.kind === 'throw') {
        record({ agent: this._agentId, call: 'activate', args: [options], ok: false, error: fault.error.message });
        throw fault.error;
      }
      let onChainTxid = null;
      if (onChain) {
        // The SDK returns null (rather than throwing) when the on-chain half
        // fails — no UTXOs, or rejected by the network. cli.js treats a null
        // txid as a failed write, so the stub must be able to produce one.
        try {
          onChainTxid = chain.write(this._agentId, 'active');
        } catch {
          onChainTxid = null;
        }
      }
      chain.setPlatformStatus(this._agentId, 'active');
      const result = { status: 'active', onChainTxid };
      record({ agent: this._agentId, call: 'activate', args: [options], ok: true, result });
      return result;
    }

    async deactivate(options = {}) {
      const onChain = options.onChain ?? true;
      let onChainTxid = null;
      if (onChain) {
        try { onChainTxid = chain.write(this._agentId, 'inactive'); } catch { onChainTxid = null; }
      }
      chain.setPlatformStatus(this._agentId, 'inactive');
      const result = { status: 'inactive', onChainTxid };
      record({ agent: this._agentId, call: 'deactivate', args: [options], ok: true, result });
      return result;
    }

    async setOnChainStatus(status) {
      const fault = applyFault(nextFault(this._agentId, 'setOnChainStatus'));
      if (fault.kind === 'throw') {
        record({ agent: this._agentId, call: 'setOnChainStatus', args: [status], ok: false, error: fault.error.message });
        throw fault.error;
      }
      if (fault.kind === 'return') {
        record({ agent: this._agentId, call: 'setOnChainStatus', args: [status], ok: true, result: fault.value, faulted: true });
        return fault.value;
      }
      try {
        const txid = chain.write(this._agentId, status);
        record({ agent: this._agentId, call: 'setOnChainStatus', args: [status], ok: true, result: txid });
        return txid;
      } catch (e) {
        record({ agent: this._agentId, call: 'setOnChainStatus', args: [status], ok: false, error: e.message });
        throw e;
      }
    }

    async stop() { record({ agent: this._agentId, call: 'stop', args: [], ok: true }); }
    async connectChat() { record({ agent: this._agentId, call: 'connectChat', args: [], ok: true }); return null; }
    async joinJobChat() { record({ agent: this._agentId, call: 'joinJobChat', args: [], ok: true }); return null; }
    async sendChatMessage() { record({ agent: this._agentId, call: 'sendChatMessage', args: [], ok: true }); return null; }
    async acceptInboxBatch() { record({ agent: this._agentId, call: 'acceptInboxBatch', args: [], ok: true }); return null; }
  }

  class J41Client {
    constructor(cfg = {}) {
      this.apiUrl = cfg.apiUrl;
      return makeClient(null);
    }
  }

  return {
    chain,
    audit,
    /** Every audit entry whose call name contains `needle`. */
    /**
     * Select audit entries for a method.
     *
     * EXACT, not substring. This started as `e.call.includes(needle)` and that is
     * a trap with teeth: `'deactivate'.includes('activate')` is true, so
     * `count('activate')` counted deactivates, and an "exactly one activate per
     * agent" assertion could be satisfied by a deactivate while the activate was
     * missing entirely. A test that passes for the wrong reason is the one thing
     * this harness exists to prevent, so the matcher may not be sloppy.
     *
     * Accepts the bare method name (matching `foo`, `client.foo` and
     * `unstubbed:client.foo` alike) or a RegExp for deliberate loose matching.
     */
    calls: (needle) => audit.filter((e) => matchCall(e.call, needle)),
    count: (needle) => audit.filter((e) => matchCall(e.call, needle)).length,
    /** Calls of `needle` grouped by agent id — the "exactly once per agent" assertion. */
    byAgent: (needle) => {
      const m = new Map();
      for (const e of audit.filter((x) => matchCall(x.call, needle))) {
        m.set(e.agent, (m.get(e.agent) || 0) + 1);
      }
      return m;
    },
    /** Method names the dispatcher called that this stub does not model. */
    unstubbed: () => [...new Set(audit.filter((e) => e.call.startsWith('unstubbed:')).map((e) => e.call))],
    modules: {
      J41Agent,
      J41Client,
    },
  };
}

module.exports = { createSdkStub };
