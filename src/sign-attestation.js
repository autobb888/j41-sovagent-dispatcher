/**
 * Lightweight Privacy Attestation Signer
 *
 * Signs creation or deletion attestations inside the ephemeral container.
 * Much simpler than the full job-agent.js — just attestation signing.
 *
 * Usage:
 *   node sign-attestation.js creation
 *   node sign-attestation.js deletion
 *
 * Broker mode (J41_SIGNING_BROKER !== '0', the default):
 *   The WIF is NOT present in the container. Signing is routed through the
 *   file-channel client (SignChannelClient) which writes a sign request to
 *   /app/sign/req/ and polls /app/sign/resp/ for the dispatcher's response.
 *   The container never sees the agent WIF in this mode.
 *
 * Legacy mode (J41_SIGNING_BROKER=0):
 *   Reads the WIF from /app/keys.json and signs locally via signChallenge.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEYS_FILE = '/app/keys.json';
const JOB_DIR = '/app/job';

/** True when broker mode is active (default). Flip to '0' for legacy local signing. */
const SIGNING_BROKER_ENABLED = process.env.J41_SIGNING_BROKER !== '0';
const SIGNING_BROKER_CHANNEL_DIR = process.env.J41_SIGNING_CHANNEL_DIR || '/app/sign';

const JOB_ID = process.env.J41_JOB_ID || 'unknown';
const AGENT_ID = process.env.J41_AGENT_ID || 'unknown';
const IDENTITY = process.env.J41_IDENTITY || 'unknown';
const CONTAINER_ID = process.env.HOSTNAME || 'unknown';

const mode = process.argv[2]; // 'creation' or 'deletion'

if (!mode || (mode !== 'creation' && mode !== 'deletion')) {
  console.error('Usage: node sign-attestation.js <creation|deletion>');
  process.exit(1);
}

/**
 * Unified sign helper. In broker mode uses SignChannelClient so the WIF never
 * enters the container. In legacy mode calls signChallenge with the local WIF.
 *
 * @param {string} message  The message string to sign.
 * @param {object} [keys]   Parsed keys.json (only required in legacy mode).
 * @returns {Promise<string>} The signature string.
 */
async function signMessage(message, keys) {
  if (SIGNING_BROKER_ENABLED) {
    // Broker mode: route through the dispatcher's file-channel signing broker.
    // The channel directory is bind-mounted by the dispatcher when it launches
    // this container with broker mode enabled.
    const { SignChannelClient } = require('./sign-channel-client.js');
    const client = new SignChannelClient({ channelDir: SIGNING_BROKER_CHANNEL_DIR });
    return client.signMessage(message);
  }
  // Legacy mode: sign locally with the WIF from /app/keys.json.
  const { signChallenge } = require('@junction41/sovagent-sdk/dist/identity/signer.js');
  return signChallenge(keys.wif, message, keys.iAddress, process.env.J41_NETWORK || 'verustest');
}

(async () => {
try {
  // In broker mode the WIF is never in the container; skip reading keys.json.
  // In legacy mode read it now so errors surface before we build the attestation.
  let keys = null;
  if (!SIGNING_BROKER_ENABLED) {
    keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  }

  if (mode === 'creation') {
    const creationTime = new Date().toISOString();

    // Build job hash from available data
    let jobHash = 'unknown';
    try {
      const description = fs.readFileSync(path.join(JOB_DIR, 'description.txt'), 'utf8').trim();
      const buyer = fs.readFileSync(path.join(JOB_DIR, 'buyer.txt'), 'utf8').trim();
      const amount = fs.readFileSync(path.join(JOB_DIR, 'amount.txt'), 'utf8').trim();
      const currency = fs.readFileSync(path.join(JOB_DIR, 'currency.txt'), 'utf8').trim();

      jobHash = crypto.createHash('sha256')
        .update(JSON.stringify({
          jobId: JOB_ID,
          description,
          buyer,
          amount,
          currency,
          timestamp: creationTime,
        }))
        .digest('hex');
    } catch (e) {
      console.error('⚠️ Could not compute job hash:', e.message);
    }

    const attestation = {
      type: 'container:created',
      jobId: JOB_ID,
      containerId: CONTAINER_ID,
      agentId: AGENT_ID,
      identity: IDENTITY,
      createdAt: creationTime,
      jobHash,
      ephemeral: true,
      memoryLimit: '2GB',
      cpuLimit: '1 core',
      privacyTier: 'ephemeral-container',
    };

    const message = JSON.stringify(attestation);
    attestation.signature = await signMessage(message, keys);

    fs.writeFileSync(
      path.join(JOB_DIR, 'creation-attestation.json'),
      JSON.stringify(attestation, null, 2)
    );

    console.log('✅ Creation attestation signed');
    console.log(`   Container: ${CONTAINER_ID.substring(0, 12)}`);
    console.log(`   Job hash: ${jobHash.substring(0, 16)}...`);
  }

  if (mode === 'deletion') {
    const deletionTime = new Date().toISOString();

    // Load creation attestation for timestamps
    let creationTime = 'unknown';
    let jobHash = 'unknown';
    try {
      const creation = JSON.parse(fs.readFileSync(path.join(JOB_DIR, 'creation-attestation.json'), 'utf8'));
      creationTime = creation.createdAt || creationTime;
      jobHash = creation.jobHash || jobHash;
    } catch (e) {
      console.error('⚠️ Could not load creation attestation:', e.message);
    }

    const attestation = {
      type: 'container:destroyed',
      jobId: JOB_ID,
      containerId: CONTAINER_ID,
      agentId: AGENT_ID,
      identity: IDENTITY,
      createdAt: creationTime,
      destroyedAt: deletionTime,
      jobHash,
      dataVolumes: ['/app/job', '/tmp', '/var/tmp'],
      deletionMethod: 'container-auto-remove',
      ephemeral: true,
      privacyAttestation: true,
    };

    const message = JSON.stringify(attestation);
    attestation.signature = await signMessage(message, keys);

    fs.writeFileSync(
      path.join(JOB_DIR, 'deletion-attestation.json'),
      JSON.stringify(attestation, null, 2)
    );

    console.log('✅ Deletion attestation signed');
    console.log(`   Created: ${creationTime}`);
    console.log(`   Deleted: ${deletionTime}`);
    if (creationTime !== 'unknown') {
      console.log(`   Duration: ${(new Date(deletionTime) - new Date(creationTime)) / 1000}s`);
    }
  }
} catch (e) {
  console.error(`❌ Attestation signing failed: ${e.message}`);
  process.exit(1);
}
})();
