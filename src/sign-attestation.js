/**
 * Lightweight Privacy Attestation Signer
 *
 * Signs creation or deletion attestations inside the ephemeral container.
 * Much simpler than the full job-agent.js — just attestation signing.
 *
 * Usage:
 *   node sign-attestation.js creation
 *   node sign-attestation.js deletion
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEYS_FILE = '/app/keys.json';
const JOB_DIR = '/app/job';

const JOB_ID = process.env.J41_JOB_ID || 'unknown';
const AGENT_ID = process.env.J41_AGENT_ID || 'unknown';
const IDENTITY = process.env.J41_IDENTITY || 'unknown';
const CONTAINER_ID = process.env.HOSTNAME || 'unknown';

const mode = process.argv[2]; // 'creation' or 'deletion'

if (!mode || (mode !== 'creation' && mode !== 'deletion')) {
  console.error('Usage: node sign-attestation.js <creation|deletion>');
  process.exit(1);
}

try {
  const keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  const { signChallenge } = require('@junction41/sovagent-sdk/dist/identity/signer.js');

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
    attestation.signature = signChallenge(keys.wif, message, keys.iAddress, process.env.J41_NETWORK || 'verustest');

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
    attestation.signature = signChallenge(keys.wif, message, keys.iAddress, process.env.J41_NETWORK || 'verustest');

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
