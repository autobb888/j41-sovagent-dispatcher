'use strict';
/**
 * broker-executors — named host-side actions the dispatcher exposes through
 * `SignChannelHost.executors`. The container invokes them via
 * `SignChannelClient.executeOnChain(kind, params)`; the WIF stays in the host
 * closure and never enters the container.
 *
 * Each executor must:
 *   - Be deterministic about which inputs are container-supplied vs host-
 *     derived. Anything fund-bearing or identity-bearing MUST come from the
 *     host's own authoritative source (the dispatcher's J41Client), not from
 *     `params`.
 *   - Return a JSON-serializable result the container relays in its own
 *     flow.
 *   - Throw on failure; the channel wraps the throw as
 *     `{ ok: false, error: { code: 'EXECUTOR_ERROR', message } }`.
 *
 * Registering a NEW executor is a security decision: it expands the surface
 * the container can reach into. Add comments justifying it.
 */

const {
  buildJobCompletionAdditions,
} = require('@junction41/sovagent-sdk/dist/onboarding/vdxf.js');
const {
  buildIdentityUpdateTx,
} = require('@junction41/sovagent-sdk/dist/identity/update.js');

/**
 * Build a `J41Client` factory that the dispatcher can pass into the executors.
 * Centralised here so the require-graph stays small.
 *
 * @param {{ apiUrl: string, wif: string, identityName: string, iAddress: string, network: string }} cfg
 * @returns {() => Promise<object>}
 */
function makeClientFactory(cfg) {
  // eslint-disable-next-line global-require
  const { J41Agent } = require('@junction41/sovagent-sdk/dist/agent.js');
  let cached = null;
  return async () => {
    if (cached) return cached;
    const agent = new J41Agent({
      apiUrl: cfg.apiUrl,
      wif: cfg.wif,
      identityName: cfg.identityName,
      iAddress: cfg.iAddress,
      network: cfg.network,
    });
    await agent.authenticate();
    cached = agent.client;
    // Stash the agent so callers can stop() it on teardown if they want.
    cached._brokerAgent = agent;
    return cached;
  };
}

/**
 * `jobCompletionUpdate` — replaces the in-container `buildIdentityUpdateTx`
 * site at the end of a job (writes jobRecord + reviewRecord + workspace
 * attestation onto the agent's identity on-chain).
 *
 * The container provides the *content* (jobRecord etc.), which today's path
 * already trusts it to author (the on-chain entries are self-reported job
 * history). The dispatcher provides the *signing*: re-fetches identity +
 * UTXOs from its own session, builds the tx with the WIF, broadcasts.
 *
 * Returns `{ txid }` on success, `{ skipped: true, reason }` if there are no
 * UTXOs (same fail-soft behavior the in-container path had).
 */
function jobCompletionUpdateExecutor({ getClient }) {
  return async (params, ctx) => {
    const { jobRecord, reviewRecord, workspaceAttestation } = params || {};
    if (!jobRecord || typeof jobRecord !== 'object') {
      throw new Error('jobCompletionUpdate: jobRecord (object) required');
    }
    // Audit 2026-06-02 H-DISPATCHER-6: shape-validate container-supplied
    // records before signing+broadcasting them under the agent's identity.
    // The full architectural fix (reconstruct from trusted state instead of
    // accepting container blob) requires SDK + backend coordination on what
    // counts as authoritative; the shape check stops the simple "container
    // ships unrelated keys into vdxfAdditions" path immediately.
    if (jobRecord.timestamp !== undefined && typeof jobRecord.timestamp !== 'number') {
      throw new Error('jobCompletionUpdate: jobRecord.timestamp must be a number');
    }
    if (reviewRecord !== undefined && (typeof reviewRecord !== 'object' || reviewRecord === null)) {
      throw new Error('jobCompletionUpdate: reviewRecord must be an object if provided');
    }
    if (workspaceAttestation !== undefined && (typeof workspaceAttestation !== 'object' || workspaceAttestation === null)) {
      throw new Error('jobCompletionUpdate: workspaceAttestation must be an object if provided');
    }
    // Refuse if any unexpected top-level keys (defensive — drops a future
    // mistaken expansion of the container surface from making it on-chain).
    const allowedJobRecordKeys = new Set(['jobHash', 'timestamp', 'completedAt', 'amount', 'currency', 'buyer', 'seller', 'status', 'reviewerSignature']);
    for (const k of Object.keys(jobRecord)) {
      if (!allowedJobRecordKeys.has(k)) {
        throw new Error(`jobCompletionUpdate: jobRecord has unexpected key ${k}; refusing to broadcast`);
      }
    }
    // Optional sanity: if jobRecord.jobHash is supplied, make sure it matches
    // the channel's bound job — prevents a runaway container from poisoning
    // the wrong job's identity record. We re-fetch via getJob to get the
    // authoritative jobHash, comparing against what the container supplied.
    let authoritativeJob;
    try {
      authoritativeJob = await ctx.getJob();
    } catch (e) {
      throw new Error(`jobCompletionUpdate: failed to fetch authoritative job: ${e.message}`);
    }
    if (jobRecord.jobHash && authoritativeJob?.jobHash && jobRecord.jobHash !== authoritativeJob.jobHash) {
      throw new Error(
        `jobCompletionUpdate: jobRecord.jobHash mismatch (got ${jobRecord.jobHash}, authoritative ${authoritativeJob.jobHash})`,
      );
    }

    const client = await getClient();
    const identityRawResp = await client.getIdentityRaw();
    const identityData = identityRawResp.data || identityRawResp;
    const utxoResp = await client.getUtxos();
    const utxos = (utxoResp.utxos || utxoResp || []).filter((u) => u && u.satoshis > 0);
    if (utxos.length === 0) {
      return { skipped: true, reason: 'no-utxos' };
    }

    const additions = buildJobCompletionAdditions({
      jobRecord,
      reviewRecord,
      workspaceAttestation,
    });

    const rawhex = buildIdentityUpdateTx({
      wif: ctx.wif,
      identityData,
      utxos,
      vdxfAdditions: additions,
      network: ctx.network,
    });
    const txResult = await client.broadcast(rawhex);
    const txid = typeof txResult === 'string' ? txResult : txResult.txid || txResult;
    return { txid };
  };
}

/**
 * Convenience: build a complete `executors` object for `SignChannelHost`
 * given the agent's connection config. Returns the object + a `teardown`
 * function the caller should run on container exit (stops any cached client
 * polling/sockets).
 */
function defaultExecutors(cfg) {
  const getClient = makeClientFactory(cfg);
  const executors = {
    jobCompletionUpdate: jobCompletionUpdateExecutor({ getClient }),
  };
  const teardown = async () => {
    try {
      const cached = await getClient();
      if (cached && cached._brokerAgent && typeof cached._brokerAgent.stop === 'function') {
        cached._brokerAgent.stop();
      }
    } catch { /* best-effort */ }
  };
  return { executors, teardown };
}

module.exports = {
  makeClientFactory,
  jobCompletionUpdateExecutor,
  defaultExecutors,
};
