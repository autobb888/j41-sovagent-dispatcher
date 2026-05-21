'use strict';
/**
 * Host-side signing broker — CONSTRAINED SIGNER (not an oracle).
 *
 * The dispatcher holds the Verus WIF; the job container never does. When the
 * container needs a signature for a job action it sends a sign-request; the
 * broker RECONSTRUCTS the exact message from the dispatcher's OWN authoritative
 * job record (fetched from the platform) and signs that — it never trusts
 * container-supplied amounts, identities, or raw message bytes.
 *
 * Consequence: a fully-compromised / prompt-injected container can only ever
 * obtain a signature for the legitimate action of ITS OWN job at the REAL
 * amount. It cannot:
 *   - inflate the amount (the Amt comes from the authoritative job, not the request),
 *   - sign for a different job (jobId must match the container's assigned job),
 *   - sign an arbitrary string (only known protocol message types are built),
 *   - request a rogue identity update / payment (those are not broker types).
 */

const {
  buildAcceptMessage,
  buildDeliverMessage,
  buildDisputeRespondMessage,
} = require('@junction41/sovagent-sdk/dist/signing/messages.js');
const { signMessage } = require('@junction41/sovagent-sdk/dist/identity/signer.js');

const MAX_TS_SKEW_S = 300;
const HEX64 = /^[0-9a-f]{64}$/i;

/** Error with a machine-readable code for the broker's policy rejections. */
class BrokerPolicyError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'BrokerPolicyError'; }
}

/**
 * Build the exact message the broker is willing to sign for a request, using
 * ONLY the authoritative job record for any security-bearing field.
 *
 * @param {object} job - Authoritative job record (from the platform). Requires
 *                       { id, jobHash, buyerVerusId, amount, currency }.
 * @param {object} request - Container request: { type, jobId, ...typeFields }.
 * @param {number} now - Unix seconds (timestamp bound into the signature).
 * @returns {{ message: string, timestamp: number }}
 * @throws {BrokerPolicyError} on any policy violation.
 */
function buildBrokeredMessage(job, request, now = Math.floor(Date.now() / 1000)) {
  if (!job || !job.id) throw new BrokerPolicyError('NO_JOB', 'No authoritative job record');
  if (!request || typeof request.type !== 'string') {
    throw new BrokerPolicyError('BAD_REQUEST', 'Malformed sign request');
  }
  // The container may only ever sign for the exact job it was dispatched for.
  if (request.jobId !== job.id) {
    throw new BrokerPolicyError('JOB_MISMATCH', `Request jobId ${request.jobId} != assigned job ${job.id}`);
  }
  if (!job.jobHash) throw new BrokerPolicyError('NO_JOBHASH', 'Authoritative job has no jobHash');

  const timestamp = now;

  switch (request.type) {
    case 'accept': {
      // Amount/buyer/hash ALL come from the authoritative job — never the request.
      const message = buildAcceptMessage({
        jobHash: job.jobHash,
        buyerVerusId: job.buyerVerusId,
        amount: job.amount,
        currency: job.currency,
        timestamp,
      });
      return { message, timestamp };
    }
    case 'deliver': {
      // deliveryHash is a SHA-256 commitment to the delivered content — not a
      // fund-bearing field, but it must be a well-formed hash; the job binding
      // (jobHash) is authoritative.
      const deliveryHash = request.deliveryHash;
      if (typeof deliveryHash !== 'string' || !HEX64.test(deliveryHash)) {
        throw new BrokerPolicyError('BAD_DELIVERY_HASH', 'deliveryHash must be a 64-char hex SHA-256');
      }
      const message = buildDeliverMessage({ jobHash: job.jobHash, deliveryHash, timestamp });
      return { message, timestamp };
    }
    case 'dispute_respond': {
      const action = request.action;
      if (!['refund', 'rework', 'rejected'].includes(action)) {
        throw new BrokerPolicyError('BAD_ACTION', `Invalid dispute action: ${action}`);
      }
      const message = buildDisputeRespondMessage({ jobHash: job.jobHash, action, timestamp });
      return { message, timestamp };
    }
    default:
      // Default-deny: identity updates, payments, and arbitrary strings are NOT
      // brokered here. (Identity-update txs are built+signed by the dispatcher
      // itself from its own data; payments stay dispatcher-initiated and gated.)
      throw new BrokerPolicyError('UNSUPPORTED_TYPE', `Broker will not sign type: ${request.type}`);
  }
}

/**
 * Validate + sign a container sign-request. Returns the signature plus the
 * timestamp the broker used (the container must pass that exact timestamp to
 * the platform API alongside the signature).
 *
 * @returns {{ ok: true, signature: string, timestamp: number, message: string }
 *          | { ok: false, code: string, reason: string }}
 */
function signBrokeredRequest({ job, request, wif, network = 'verustest', now }) {
  let built;
  try {
    built = buildBrokeredMessage(job, request, now);
  } catch (e) {
    if (e instanceof BrokerPolicyError) return { ok: false, code: e.code, reason: e.message };
    return { ok: false, code: 'ERROR', reason: e.message };
  }
  const signature = signMessage(wif, built.message, network);
  return { ok: true, signature, timestamp: built.timestamp, message: built.message };
}

module.exports = { buildBrokeredMessage, signBrokeredRequest, BrokerPolicyError, MAX_TS_SKEW_S };
