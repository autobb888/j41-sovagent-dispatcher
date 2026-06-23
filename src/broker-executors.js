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
const {
  verifyWitness,
} = require('@junction41/sovagent-sdk/dist/index.js');

/**
 * Integrity ②: decide whether to proceed with writing a witness-sourced
 * record on-chain, or throw fail-closed.
 *
 * Exported so it can be unit-tested independently of the full executor.
 *
 * @param {{ verified: boolean, reason?: string }} v  Result from verifyWitness.
 * @param {{ network: string, jobId: string }} ctx    Execution context.
 * @returns {void} — throws if the write must be refused; logs a warning for
 *   break-glass (J41_WITNESS_VERIFY=off on non-mainnet only).
 */
function decideWitnessWrite(v, { network, jobId }) {
  const isMainnet = network === 'verus';
  const allowOff = process.env.J41_WITNESS_VERIFY === 'off' && !isMainnet;
  if (!v.verified && !allowOff) {
    throw new Error(
      `jobCompletionUpdate: witness verification failed (${v.reason}) — refusing record.job write for job ${jobId}`,
    );
  }
  if (!v.verified && allowOff) {
    console.warn(`[witness] J41_WITNESS_VERIFY=off — writing UNVERIFIED record.job for ${jobId}`);
  }
}

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
 * Integrity ②: the on-chain VDXF record.job is sourced from the **platform
 * witness** (cryptographically verified via `verifyWitness`, offline), NOT
 * from the container-supplied `jobRecord`. The container's `jobRecord` is
 * accepted only as a soft pre-check (shape + early jobHash sanity gate) and
 * is NOT written on-chain. `reviewRecord` and `workspaceAttestation` remain
 * legitimately container-authored and are passed through unchanged.
 *
 * Returns `{ txid }` on success, `{ skipped: true, reason }` if there are no
 * UTXOs (same fail-soft behavior the in-container path had). A 409 from
 * `getJobWitness` (job not yet `completed`) propagates as a throw so the
 * completion flow retries.
 */
function jobCompletionUpdateExecutor({ getClient }) {
  return async (params, ctx) => {
    const { jobRecord, reviewRecord, workspaceAttestation } = params || {};

    // ── Soft pre-check on container-supplied jobRecord (shape only) ──────────
    // These checks guard against obviously malformed container payloads but do
    // NOT determine what gets written on-chain — the platform witness does.
    if (!jobRecord || typeof jobRecord !== 'object') {
      throw new Error('jobCompletionUpdate: jobRecord (object) required');
    }
    if (jobRecord.timestamp !== undefined && typeof jobRecord.timestamp !== 'number') {
      throw new Error('jobCompletionUpdate: jobRecord.timestamp must be a number');
    }
    if (reviewRecord !== undefined && (typeof reviewRecord !== 'object' || reviewRecord === null)) {
      throw new Error('jobCompletionUpdate: reviewRecord must be an object if provided');
    }
    if (workspaceAttestation !== undefined && (typeof workspaceAttestation !== 'object' || workspaceAttestation === null)) {
      throw new Error('jobCompletionUpdate: workspaceAttestation must be an object if provided');
    }
    const allowedJobRecordKeys = new Set(['jobHash', 'timestamp', 'completedAt', 'amount', 'currency', 'buyer', 'seller', 'status', 'reviewerSignature']);
    for (const k of Object.keys(jobRecord)) {
      if (!allowedJobRecordKeys.has(k)) {
        throw new Error(`jobCompletionUpdate: jobRecord has unexpected key ${k}; refusing to broadcast`);
      }
    }

    // ── Authoritative job fetch (belt-and-suspenders source) ────────────────
    let authoritativeJob;
    try {
      authoritativeJob = await ctx.getJob();
    } catch (e) {
      throw new Error(`jobCompletionUpdate: failed to fetch authoritative job: ${e.message}`);
    }

    // Early soft gate: container jobHash must not contradict the authoritative
    // one. If the witness cross-check below is the hard gate, this is the fast
    // path that avoids a network round-trip for obviously wrong containers.
    if (jobRecord.jobHash && authoritativeJob?.jobHash && jobRecord.jobHash !== authoritativeJob.jobHash) {
      throw new Error(
        `jobCompletionUpdate: jobRecord.jobHash mismatch (got ${jobRecord.jobHash}, authoritative ${authoritativeJob.jobHash})`,
      );
    }

    // ── Platform witness: fetch + cryptographic verification ─────────────────
    // Integrity ②: the job record written on-chain MUST come from the platform
    // witness, not the container. getJobWitness returns { record, witness }
    // directly (SDK already unwraps res.data).
    const client = await getClient();
    const jobId = ctx.jobId;
    const network = ctx.network || 'verustest';

    const { record, witness } = await client.getJobWitness(jobId);

    const v = await verifyWitness(record, witness, client, network);

    // Fail-closed gate — throws on mainnet or when break-glass env is absent.
    decideWitnessWrite(v, { network, jobId });

    // ── Belt-and-suspenders cross-check: witness record vs authoritative getJob
    // For each field the authoritative job carries, the witnessed record must
    // agree. Skip fields not present on authoritativeJob (future-proofing).
    const crossCheckFields = ['jobHash', 'buyerVerusId', 'sellerVerusId'];
    for (const f of crossCheckFields) {
      if (authoritativeJob[f] !== undefined && record[f] !== undefined) {
        if (String(record[f]) !== String(authoritativeJob[f])) {
          throw new Error(
            `jobCompletionUpdate: witness/getJob mismatch on ${f} (witness: ${record[f]}, authoritative: ${authoritativeJob[f]}) for job ${jobId}`,
          );
        }
      }
    }

    // ── Build the on-chain record from the verified witness ───────────────────
    // The container's jobRecord is NOT the on-chain source. The witnessed record
    // is the authoritative job history entry; the witness block is embedded so
    // the on-chain entry is self-proving.
    const jobRecordToWrite = { ...record, witness };

    // ── Identity fetch + UTXO check ──────────────────────────────────────────
    const identityRawResp = await client.getIdentityRaw();
    const identityData = identityRawResp.data || identityRawResp;
    const utxoResp = await client.getUtxos();
    const utxos = (utxoResp.utxos || utxoResp || []).filter((u) => u && u.satoshis > 0);
    if (utxos.length === 0) {
      return { skipped: true, reason: 'no-utxos' };
    }

    // reviewRecord and workspaceAttestation remain legitimately container-authored.
    const additions = buildJobCompletionAdditions({
      jobRecord: jobRecordToWrite,
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
  decideWitnessWrite,
};
