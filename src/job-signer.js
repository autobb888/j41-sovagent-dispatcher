'use strict';
/**
 * JobSigner — unified signing surface used by `job-agent.js` inside the job
 * container. Two backends:
 *
 *   - **local** (legacy, default): the WIF is mounted at `/app/keys.json`;
 *     every sign call runs `signMessage(keys.wif, …)` in-process.
 *   - **broker** (gated by `J41_SIGNING_BROKER=1`): the WIF is NOT in the
 *     container; the helper proxies every sign call to the dispatcher
 *     through `SignChannelClient`. The dispatcher's broker policy
 *     reconstructs fund-bearing messages from its authoritative job record.
 *
 * The two backends are interchangeable at the call site — `job-agent.js`
 * doesn't need to know which one is active. The single point of switching
 * is `createJobSigner()` at startup.
 *
 * API:
 *   signer.mode                       // 'local' | 'broker'
 *   signer.signMessage(message)       // → Promise<string>  (auth, attestation, status)
 *   signer.signAccept({jobId, ...})   // → Promise<{signature, timestamp, message}>
 *   signer.signDeliver({jobId, jobHash, deliveryHash})
 *                                     // → Promise<{signature, timestamp, message}>
 *   signer.signDisputeRespond({jobId, jobHash, action})
 *                                     // → Promise<{signature, timestamp, message}>
 *   signer.executeOnChain(kind, params)
 *                                     // → Promise<object> (host-side executor result)
 */

const {
  buildAcceptMessage,
  buildDeliverMessage,
  buildDisputeRespondMessage,
} = require('@junction41/sovagent-sdk/dist/signing/messages.js');
const { signMessage: localSignMessage } = require('@junction41/sovagent-sdk/dist/identity/signer.js');

/**
 * Local-WIF signer. Builds messages inline and signs with the WIF in-process.
 * This is the legacy path; behavior is byte-identical to what `job-agent.js`
 * did before this refactor (so the broker can be rolled out gated and rolled
 * back cleanly).
 */
function createLocalSigner({ wif, network }) {
  if (!wif) throw new Error('createLocalSigner: wif required');
  return {
    mode: 'local',
    async signMessage(message) {
      return localSignMessage(wif, message, network);
    },
    async signAccept({ jobHash, buyerVerusId, amount, currency }) {
      const timestamp = Math.floor(Date.now() / 1000);
      const message = buildAcceptMessage({ jobHash, buyerVerusId, amount, currency, timestamp });
      const signature = localSignMessage(wif, message, network);
      return { signature, timestamp, message };
    },
    async signDeliver({ jobHash, deliveryHash }) {
      const timestamp = Math.floor(Date.now() / 1000);
      const message = buildDeliverMessage({ jobHash, deliveryHash, timestamp });
      const signature = localSignMessage(wif, message, network);
      return { signature, timestamp, message };
    },
    async signDisputeRespond({ jobHash, action }) {
      const timestamp = Math.floor(Date.now() / 1000);
      const message = buildDisputeRespondMessage({ jobHash, action, timestamp });
      const signature = localSignMessage(wif, message, network);
      return { signature, timestamp, message };
    },
    async executeOnChain(_kind, _params) {
      throw new Error(
        'executeOnChain is only available in broker mode (J41_SIGNING_BROKER=1) — the local-WIF path builds + broadcasts the tx inline at the call site',
      );
    },
  };
}

/**
 * Broker-mode signer. Wraps a `SignChannelClient` so the container talks to
 * the dispatcher's host-side broker. Brokered ops only carry the type +
 * jobId + container-influenceable fields; everything fund-bearing (amount,
 * buyer, jobHash, currency) is rebuilt from the dispatcher's authoritative
 * job record on the host side.
 */
function createBrokerSigner({ channelClient }) {
  if (!channelClient) throw new Error('createBrokerSigner: channelClient required');
  return {
    mode: 'broker',
    async signMessage(message) {
      return channelClient.signMessage(message);
    },
    async signAccept({ jobId }) {
      // amount/buyer/currency/jobHash are IGNORED by the broker — it pulls
      // those from the authoritative job record. We pass only jobId.
      return channelClient.signBrokered({ type: 'accept', jobId });
    },
    async signDeliver({ jobId, deliveryHash }) {
      return channelClient.signBrokered({ type: 'deliver', jobId, deliveryHash });
    },
    async signDisputeRespond({ jobId, action }) {
      return channelClient.signBrokered({ type: 'dispute_respond', jobId, action });
    },
    async executeOnChain(kind, params) {
      return channelClient.executeOnChain(kind, params);
    },
  };
}

/**
 * Pick the signer backend based on env: `J41_SIGNING_BROKER=1` switches to
 * the file-channel broker; anything else falls back to the local-WIF path.
 * The caller supplies the WIF for the local fallback (a no-op when broker
 * mode is active and `keys.json` isn't even mounted).
 */
function createJobSigner({ wif, network, channelClient, brokerEnabled } = {}) {
  const enabled = brokerEnabled ?? process.env.J41_SIGNING_BROKER === '1';
  if (enabled) {
    if (!channelClient) {
      throw new Error(
        'J41_SIGNING_BROKER=1 but no channelClient supplied — dispatcher must construct SignChannelClient before starting the container runtime',
      );
    }
    return createBrokerSigner({ channelClient });
  }
  return createLocalSigner({ wif, network });
}

module.exports = { createJobSigner, createLocalSigner, createBrokerSigner };
