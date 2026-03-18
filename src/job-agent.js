/**
 * Ephemeral Job Agent Runtime with Privacy Attestation
 *
 * Signs a deletion attestation when the container is destroyed
 * (destruction timestamp, data volumes). Submitted to the platform
 * for privacy verification.
 */

const { J41Agent } = require('@j41/sovagent-sdk/dist/index.js');
const { signMessage } = require('@j41/sovagent-sdk/dist/identity/signer.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createExecutor, EXECUTOR_TYPE } = require('./executors/index.js');

const API_URL = process.env.J41_API_URL;
const AGENT_ID = process.env.J41_AGENT_ID;
const IDENTITY = process.env.J41_IDENTITY;
const JOB_ID = process.env.J41_JOB_ID;
const TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || '3600000');
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || '600000'); // 10 min idle → deliver

const KEYS_FILE = process.env.J41_KEYS_FILE || '/app/keys.json';
const SOUL_FILE = process.env.J41_SOUL_FILE || '/app/SOUL.md';
const JOB_DIR = process.env.J41_JOB_DIR || '/app/job';

// Container metadata (from Docker labels)
const CONTAINER_ID = process.env.HOSTNAME || 'unknown'; // Docker sets HOSTNAME to container ID

// P2-1: Input sanitization helper
function sanitizeInput(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
    .substring(0, 10000); // Limit length to prevent DoS
}

// Retry helper with exponential backoff for transient API failures
async function withRetry(fn, label, { maxAttempts = 3, baseDelayMs = 1000 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const isLast = attempt === maxAttempts;
      console.error(`[RETRY] ${label} attempt ${attempt}/${maxAttempts} failed: ${e.message}`);
      if (isLast) throw e;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Track agent+executor globally for SIGTERM cleanup
let _agent = null;
let _executor = null;

async function main() {
  // Check for required environment variables
  if (!AGENT_ID || !JOB_ID || !IDENTITY) {
    console.log(`╔══════════════════════════════════════════╗`);
    console.log(`║     J41 Job Agent Runtime               ║`);
    console.log(`╚══════════════════════════════════════════╝\n`);
    console.log('Usage: docker run --rm -e J41_AGENT_ID=<id> -e J41_JOB_ID=<job> -e J41_IDENTITY=<identity> j41/job-agent\n');
    console.log('Required environment variables:');
    console.log('  J41_AGENT_ID     Agent identifier (e.g., agent-1)');
    console.log('  J41_JOB_ID       Job ID from platform');
    console.log('  J41_IDENTITY     Verus identity (e.g., myagent.agentplatform@)');
    console.log('  J41_API_URL      API endpoint (default: https://api.autobb.app)');
    console.log('\nOptional:');
    console.log('  J41_EXECUTOR       Executor type: local-llm (default), webhook, langserve, langgraph, a2a, mcp');
    console.log('  KIMI_API_KEY       Kimi K2.5 API key (local-llm executor)');
    console.log('  KIMI_BASE_URL      API base URL (default: https://api.kimi.com/coding/v1)');
    console.log('  KIMI_MODEL         Model name (default: kimi-k2.5)');
    console.log('  J41_EXECUTOR_URL   Endpoint URL (webhook, langserve, langgraph, a2a)');
    console.log('  J41_EXECUTOR_AUTH  Authorization header');
    console.log('  J41_EXECUTOR_ASSISTANT  LangGraph assistant ID (default: agent)');
    console.log('  J41_MCP_COMMAND    MCP server command (mcp executor, stdio)');
    console.log('  J41_MCP_URL        MCP server URL (mcp executor, HTTP)');
    console.log('  IDLE_TIMEOUT_MS    Idle timeout before auto-deliver (default: 120000)');
    console.log('\nThis container is spawned by j41-dispatcher for each job.');
    process.exit(0);
  }

  console.log(`╔══════════════════════════════════════════╗`);
  console.log(`║     Ephemeral Job Agent (Privacy)       ║`);
  console.log(`║     ${AGENT_ID.padEnd(21)}║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  console.log(`Job ID: ${JOB_ID}`);
  console.log(`Identity: ${IDENTITY}`);
  console.log(`Container: ${CONTAINER_ID.substring(0, 12)}`);
  console.log(`Timeout: ${TIMEOUT_MS / 60000} min`);
  console.log(`Executor: ${EXECUTOR_TYPE}\n`);

  // Load keys
  const keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));

  // Load SOUL personality
  let soulPrompt = '';
  try {
    soulPrompt = fs.readFileSync(SOUL_FILE, 'utf8').trim();
  } catch {
    soulPrompt = 'You are a helpful AI agent on the Junction41.';
  }

  // Load job data with input validation (P2-1)
  const job = {
    id: JOB_ID,
    description: sanitizeInput(fs.readFileSync(path.join(JOB_DIR, 'description.txt'), 'utf8')),
    buyer: sanitizeInput(fs.readFileSync(path.join(JOB_DIR, 'buyer.txt'), 'utf8')),
    amount: sanitizeInput(fs.readFileSync(path.join(JOB_DIR, 'amount.txt'), 'utf8')),
    currency: sanitizeInput(fs.readFileSync(path.join(JOB_DIR, 'currency.txt'), 'utf8')),
  };

  console.log('Job Details:');
  console.log(`  Description: ${job.description.substring(0, 100)}...`);
  console.log(`  Buyer: ${job.buyer}`);
  console.log(`  Payment: ${job.amount} ${job.currency}\n`);

  // Initialize agent
  const agent = new J41Agent({
    apiUrl: API_URL,
    wif: keys.wif,
    identityName: IDENTITY,
    iAddress: keys.iAddress,
  });
  _agent = agent;

  // Establish authenticated API session via SDK login
  await withRetry(() => agent.authenticate(), 'authenticate');
  console.log('✅ Agent logged in\n');

  const creationTime = new Date().toISOString();

  // ─────────────────────────────────────────
  // STEP 1: ACCEPT JOB (sign + submit)
  // ─────────────────────────────────────────
  // Accept job — dispatcher may have already accepted during prepay flow
  console.log('→ Accepting job...');
  const fullJob = await agent.client.getJob(job.id);
  if (!fullJob || !fullJob.jobHash || !fullJob.buyerVerusId) {
    throw new Error(`Invalid job data from API for ${job.id}: missing jobHash or buyerVerusId`);
  }

  if (fullJob.status === 'accepted' || fullJob.status === 'in_progress') {
    console.log('✅ Job already accepted (by dispatcher)\n');
  } else {
    const timestamp = Math.floor(Date.now() / 1000);
    const acceptMsg = `J41-ACCEPT|Job:${fullJob.jobHash}|Buyer:${fullJob.buyerVerusId}|Amt:${fullJob.amount} ${fullJob.currency}|Ts:${timestamp}|I accept this job and commit to delivering the work.`;
    const acceptSig = signMessage(keys.wif, acceptMsg, 'verustest');
    await withRetry(() => agent.client.acceptJob(job.id, acceptSig, timestamp), 'acceptJob');
    console.log('✅ Job accepted\n');
  }

  // Connect to chat (guarded — job is already accepted, must not crash without delivery)
  try {
    await agent.connectChat();
    console.log('✅ Connected to SovGuard\n');
  } catch (chatErr) {
    console.error('❌ Chat connection failed after job acceptance:', chatErr.message);
    // Deliver a "failed" result so the accepted job isn't left in limbo
    const deliverTimestamp = Math.floor(Date.now() / 1000);
    const deliverMessage = `J41-DELIVER|Job:${fullJob.jobHash}|Delivery:failed|Ts:${deliverTimestamp}|I have delivered the work for this job.`;
    const deliverSig = signMessage(keys.wif, deliverMessage, 'verustest');
    await withRetry(
      () => agent.client.deliverJob(job.id, 'failed', deliverSig, deliverTimestamp, 'Chat connection failed — could not process job'),
      'deliverJob-chatfail',
      { maxAttempts: 5, baseDelayMs: 2000 }
    );
    console.log('✅ Delivered failure result');
    agent.stop();
    process.exit(1);
  }

  // Explicitly join this job's chat room
  agent.joinJobChat(job.id);
  console.log(`[CHAT] Joined job room: ${job.id}`);

  // Debug: log ALL chat events to help diagnose message delivery
  agent.on('chat:message', (msg) => {
    console.log(`[CHAT-DEBUG] Received message event — jobId=${msg.jobId} sender=${msg.senderVerusId} content="${(msg.content || '').substring(0, 80)}"`);
  });

  // Prevent J41Agent's built-in autoDeliver (which has wrong delivery format)
  // by setting a custom handler that we control
  agent.setHandler({
    onSessionEnding: async (sessionJob, reason, requestedBy) => {
      console.log(`[SESSION] Session ending for job ${sessionJob.id} — reason: ${reason}, requestedBy: ${requestedBy}`);
      if (sessionJob.id === job.id && sessionEndResolve) {
        agent.sendChatMessage(job.id, 'Session ended — wrapping up and delivering results. Thank you!');
        sessionEndResolve('session-ended');
      }
    },
  });

  // Session-end signal: when buyer or platform ends the session, we resolve processJob
  let sessionEndResolve = null;

  // ─────────────────────────────────────────
  // STEP 2: INTERACTIVE CHAT SESSION (Executor pattern — M6)
  // ─────────────────────────────────────────
  console.log(`→ Starting chat session (executor: ${EXECUTOR_TYPE})...\n`);

  const executor = createExecutor();
  _executor = executor;
  let result;
  try {
    result = await processJob(job, agent, soulPrompt, executor, (resolve) => { sessionEndResolve = resolve; });
    console.log('\n✅ Work completed\n');
  } catch (e) {
    console.error('\n❌ Job failed:', e.message);
    await executor.cleanup().catch(() => {});
    result = { error: e.message, content: 'Job failed: ' + e.message };
  }

  // Register IPC listener early to avoid race condition
  const ipcQueue = [];
  if (process.send) {
    process.on('message', (msg) => { ipcQueue.push(msg); });
  }

  // ─────────────────────────────────────────
  // STEP 3: DELIVER RESULT
  // ─────────────────────────────────────────
  console.log('→ Delivering result...');
  const deliverTimestamp = Math.floor(Date.now() / 1000);
  const deliverHash = result.hash || 'failed';
  const deliverMessage = `J41-DELIVER|Job:${fullJob.jobHash}|Delivery:${deliverHash}|Ts:${deliverTimestamp}|I have delivered the work for this job.`;
  const deliverSig = signMessage(keys.wif, deliverMessage, 'verustest');

  await withRetry(
    () => agent.client.deliverJob(job.id, deliverHash, deliverSig, deliverTimestamp, result.content.substring(0, 200)),
    'deliverJob',
    { maxAttempts: 5, baseDelayMs: 2000 }
  );
  console.log('✅ Job delivered\n');

  // Wait for chat to flush
  await new Promise(r => setTimeout(r, 3000));

  // ─────────────────────────────────────────
  // STEP 4: POST-DELIVERY WAIT (Dispute Resolution)
  // ─────────────────────────────────────────
  console.log('→ Entering post-delivery review window...');
  console.log('  Container stays alive until job.completed or dispute resolution.\n');

  const postDeliveryResult = await waitForPostDelivery(job, agent, keys, fullJob, executor, soulPrompt, (resolve) => { sessionEndResolve = resolve; }, ipcQueue);

  // ─────────────────────────────────────────
  // STEP 5: CLEANUP + ATTESTATION + IDENTITY UPDATE
  // ─────────────────────────────────────────
  await performCleanup(agent, keys, fullJob, postDeliveryResult);
}

// ─────────────────────────────────────────
// Chat-based job processing (M6: Executor pattern)
// ─────────────────────────────────────────

async function processJob(job, agent, soulPrompt, executor, registerSessionEndResolve) {
  let lastActivityAt = Date.now();
  let sessionEnded = false;
  let resolveSession;
  let messageCount = 0;
  let messageQueue = Promise.resolve(); // J4: Serialize handleMessage calls

  // Promise that resolves when session ends or idle timeout
  const sessionPromise = new Promise((resolve) => {
    resolveSession = resolve;
    if (registerSessionEndResolve) registerSessionEndResolve(resolve);
  });

  // Check for files attached to the job (buyer may have uploaded before session)
  let jobFiles = [];
  try {
    const fileResult = await agent.listFiles(job.id);
    jobFiles = fileResult.data || [];
    if (jobFiles.length > 0) {
      console.log(`[FILES] ${jobFiles.length} file(s) attached to job:`);
      for (const f of jobFiles) {
        console.log(`  - ${f.filename} (${(f.sizeBytes / 1024).toFixed(1)}KB, ${f.mimeType})`);
      }
      // Download files to job directory for executor access
      const filesDir = path.join(JOB_DIR, 'files');
      fs.mkdirSync(filesDir, { recursive: true });
      for (const f of jobFiles) {
        try {
          const localPath = await agent.downloadFileTo(job.id, f.id, filesDir);
          console.log(`  ✓ Downloaded: ${localPath}`);
        } catch (dlErr) {
          console.error(`  ⚠️  Failed to download ${f.filename}: ${dlErr.message}`);
        }
      }
    }
  } catch (e) {
    console.log(`[FILES] Could not check for files: ${e.message}`);
  }

  // Initialize executor (sends greeting, sets up state)
  await executor.init(job, agent, soulPrompt);

  // Handle incoming messages — delegate to executor (J4: serialized via queue)
  agent.onChatMessage((jobId, msg) => {
    if (jobId !== job.id) return;
    lastActivityAt = Date.now();

    const buyerMessage = sanitizeInput(msg.content);

    // Detect platform file upload notification — download immediately, don't send to executor
    if (buyerMessage.startsWith('📎 Uploaded file:') || buyerMessage.startsWith('Uploaded file:')) {
      console.log(`[FILES] File upload detected: ${buyerMessage.substring(0, 80)}`);
      downloadNewFiles();
      return;
    }

    messageCount++;
    console.log(`[CHAT] ${msg.senderVerusId}: ${buyerMessage.substring(0, 80)}`);

    // Serialize: each message waits for the previous to complete
    messageQueue = messageQueue.then(async () => {
      try {
        const response = await executor.handleMessage(buyerMessage, {
          senderVerusId: msg.senderVerusId,
          jobId: msg.jobId,
        });

        agent.sendChatMessage(job.id, response);
        console.log(`[CHAT] Agent: ${response.substring(0, 80)}`);
      } catch (e) {
        console.error(`[CHAT] Executor error: ${e.message}`);
        agent.sendChatMessage(job.id, 'I experienced an issue processing your message. Please try again.');
      }
    });
  });

  // ── File detection: react to platform's "📎 Uploaded file:" chat messages ──
  const knownFileIds = new Set(jobFiles.map(f => f.id));

  async function downloadNewFiles() {
    try {
      const fileResult = await agent.listFiles(job.id);
      const files = fileResult.data || [];
      const newFiles = files.filter(f => !knownFileIds.has(f.id));
      if (newFiles.length === 0) return;

      const filesDir = path.join(JOB_DIR, 'files');
      fs.mkdirSync(filesDir, { recursive: true });

      for (const f of newFiles) {
        knownFileIds.add(f.id);
        try {
          const localPath = await agent.downloadFileTo(job.id, f.id, filesDir);
          console.log(`[FILES] ✓ ${f.filename} (${(f.sizeBytes / 1024).toFixed(1)}KB)`);
        } catch (dlErr) {
          console.error(`[FILES] ⚠️  Failed to download ${f.filename}: ${dlErr.message}`);
        }
      }
    } catch (e) {
      console.error(`[FILES] Error checking files: ${e.message}`);
    }
  }

  // Idle timer — check periodically if we should auto-deliver
  const idleCheck = setInterval(() => {
    const idleMs = Date.now() - lastActivityAt;
    console.log(`[CHAT] Heartbeat — idle ${Math.round(idleMs / 1000)}s, messages: ${messageCount}, timeout: ${IDLE_TIMEOUT_MS / 1000}s`);
    if (idleMs >= IDLE_TIMEOUT_MS && !sessionEnded) {
      console.log(`[CHAT] Idle for ${Math.round(idleMs / 1000)}s — auto-delivering`);
      agent.sendChatMessage(job.id, 'Session idle — delivering results. Thank you!');
      sessionEnded = true;
      resolveSession();
    }
  }, 10000);

  // Wait for session end or idle timeout
  await sessionPromise;
  clearInterval(idleCheck);

  // Finalize executor — get deliverable
  return await executor.finalize();
}

// J1: Graceful shutdown on SIGTERM — submit attestation before exit
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received — shutting down gracefully');
  try {
    // Clean up executor
    if (_executor) await _executor.cleanup().catch(() => {});

    // Submit deletion attestation
    const keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    const attestTimestamp = Math.floor(Date.now() / 1000);
    try {
      if (_agent) {
        const { message: attestMessage } = await _agent.client.getDeletionAttestationMessage(JOB_ID, attestTimestamp);
        const attestSig = signMessage(keys.wif, attestMessage, 'verustest');
        fs.writeFileSync(
          path.join(JOB_DIR, 'deletion-attestation-sigterm.json'),
          JSON.stringify({ jobId: JOB_ID, message: attestMessage, signature: attestSig, timestamp: attestTimestamp }, null, 2)
        );
        await _agent.client.submitDeletionAttestation(JOB_ID, attestSig, attestTimestamp);
        console.log('✅ SIGTERM attestation submitted');
      }
    } catch (e) {
      console.error('⚠️  SIGTERM attestation failed:', e.message);
    }

    if (_agent) _agent.stop();
  } catch (e) {
    console.error('SIGTERM cleanup error:', e.message);
  }
  process.exit(130);
});

// Timeout protection (J4: also submit attestation to API, not just disk)
setTimeout(async () => {
  console.error('⏰ Job timeout! Signing deletion attestation and exiting.');

  try {
    const keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    const attestTimestamp = Math.floor(Date.now() / 1000);

    // Try to use the platform's canonical attestation flow (J4)
    try {
      const { J41Agent } = require('@j41/sovagent-sdk/dist/index.js');
      const agent = new J41Agent({
        apiUrl: API_URL,
        wif: keys.wif,
        identityName: IDENTITY,
        iAddress: keys.iAddress,
      });
      await agent.authenticate();
      const { message: attestMessage } = await agent.client.getDeletionAttestationMessage(JOB_ID, attestTimestamp);
      const { signMessage: signMsg } = require('@j41/sovagent-sdk/dist/identity/signer.js');
      const attestSig = signMsg(keys.wif, attestMessage, 'verustest');

      fs.writeFileSync(
        path.join(JOB_DIR, 'deletion-attestation-timeout.json'),
        JSON.stringify({ jobId: JOB_ID, message: attestMessage, signature: attestSig, timestamp: attestTimestamp }, null, 2)
      );

      const result = await agent.client.submitDeletionAttestation(JOB_ID, attestSig, attestTimestamp);
      console.log(`✅ Timeout attestation submitted (verified: ${result.signatureVerified})`);
      agent.stop();
    } catch (apiErr) {
      // Fallback: sign locally and save to disk only
      console.error('⚠️  Could not submit attestation to API:', apiErr.message);
      const deletionAttestation = {
        jobId: JOB_ID,
        containerId: CONTAINER_ID,
        destroyedAt: new Date().toISOString(),
        deletionMethod: 'timeout',
      };
      const { signMessage: signMsg } = require('@j41/sovagent-sdk/dist/identity/signer.js');
      deletionAttestation.signature = signMsg(keys.wif, JSON.stringify(deletionAttestation), 'verustest');
      fs.writeFileSync(
        path.join(JOB_DIR, 'deletion-attestation-timeout.json'),
        JSON.stringify(deletionAttestation, null, 2)
      );
    }
  } catch (e) {
    console.error('Could not sign timeout attestation:', e.message);
  }

  process.exit(1);
}, TIMEOUT_MS);

/**
 * Post-delivery wait loop. Listens for IPC messages from dispatcher
 * for job completion, disputes, and rework events.
 */
async function waitForPostDelivery(job, agent, keys, fullJob, executor, soulPrompt, registerSessionEndResolve, ipcQueue) {
  const { buildDeliverMessage } = require('@j41/sovagent-sdk/dist/signing/messages.js');
  const { signMessage } = require('@j41/sovagent-sdk/dist/identity/signer.js');

  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (val) => { if (!resolved) { resolved = true; resolve(val); } };

    // Safety timeout: resolutionWindow + 30 min (default: 90 min if unknown)
    const safetyMs = ((fullJob.resolutionWindow || 60) + 30) * 60 * 1000;
    let safetyTimer = setTimeout(() => {
      console.log('⚠️  Post-delivery safety timeout reached — exiting');
      safeResolve({ reason: 'timeout' });
    }, safetyMs);

    function resetSafetyTimer() {
      clearTimeout(safetyTimer);
      safetyTimer = setTimeout(() => {
        console.log('⚠️  Post-delivery safety timeout reached — exiting');
        safeResolve({ reason: 'timeout' });
      }, safetyMs);
    }

    async function handleMessage(msg) {
      if (!msg || !msg.type) return;
      console.log(`[POST-DELIVERY] Received: ${msg.type}`);

      switch (msg.type) {
        case 'job.completed': {
          clearTimeout(safetyTimer);
          console.log('✅ Job completed by buyer (or auto-complete after review window)');
          safeResolve({ reason: 'completed' });
          break;
        }

        case 'dispute.filed': {
          console.log(`⚠️  Dispute filed: ${msg.data?.reason || 'no reason'}`);
          if (agent.handler?.onJobDisputed) {
            try {
              const freshJob = await agent.client.getJob(job.id);
              await agent.handler.onJobDisputed(freshJob, msg.data?.reason || '');
            } catch (e) {
              console.error('Handler error:', e.message);
            }
          }
          // Stay alive — wait for resolution
          break;
        }

        case 'dispute.resolved': {
          clearTimeout(safetyTimer);
          const action = msg.data?.action || 'unknown';
          console.log(`✅ Dispute resolved: ${action}`);
          safeResolve({
            reason: action === 'rejected' ? 'resolved_rejected' : 'resolved',
            disputeOutcome: msg.data,
          });
          break;
        }

        case 'dispute.rework_accepted': {
          console.log('🔄 Rework accepted — re-entering chat session...');
          if (agent.handler?.onReworkRequested) {
            try {
              const freshJob = await agent.client.getJob(job.id);
              await agent.handler.onReworkRequested(freshJob, msg.data?.reworkCost || 0);
            } catch (e) {
              console.error('Handler error:', e.message);
            }
          }
          // Re-enter chat and re-deliver
          try {
            const reworkResult = await processJob(job, agent, soulPrompt, executor, registerSessionEndResolve);
            console.log('✅ Rework completed — re-delivering...');

            const ts = Math.floor(Date.now() / 1000);
            const hash = reworkResult.hash || 'rework';
            const deliverMsg = buildDeliverMessage({ jobHash: fullJob.jobHash, deliveryHash: hash, timestamp: ts });
            const sig = signMessage(keys.wif, deliverMsg, 'verustest');
            await withRetry(
              () => agent.client.deliverJob(job.id, hash, sig, ts, reworkResult.content?.substring(0, 200)),
              'deliverJob (rework)',
              { maxAttempts: 5, baseDelayMs: 2000 }
            );
            console.log('✅ Rework delivered — new review window started\n');
            // Reset safety timer for new review window
            resetSafetyTimer();
          } catch (e) {
            console.error('❌ Rework failed:', e.message);
          }
          break;
        }
      }
    }

    // Drain any messages that arrived before we started listening
    for (const queued of ipcQueue) {
      handleMessage(queued);
    }
    ipcQueue.length = 0;

    // Listen for future IPC messages
    process.on('message', handleMessage);
  });
}

/**
 * Final cleanup: attestation, file deletion, identity update, exit.
 */
async function performCleanup(agent, keys, fullJob, postDeliveryResult) {
  console.log('→ Performing final cleanup...');

  const attestTimestamp = Math.floor(Date.now() / 1000);

  // Deletion attestation
  try {
    const { message: attestMessage, timestamp: attestTs } =
      await agent.client.getDeletionAttestationMessage(JOB_ID, attestTimestamp);
    const { signMessage } = require('@j41/sovagent-sdk/dist/identity/signer.js');
    const attestSig = signMessage(keys.wif, attestMessage, 'verustest');

    fs.writeFileSync(
      path.join(JOB_DIR, 'deletion-attestation.json'),
      JSON.stringify({
        jobId: JOB_ID,
        message: attestMessage,
        signature: attestSig,
        timestamp: attestTs,
        disputeOutcome: postDeliveryResult.disputeOutcome || null,
      }, null, 2)
    );

    const result = await agent.client.submitDeletionAttestation(JOB_ID, attestSig, attestTs);
    console.log(`✅ Deletion attestation submitted (verified: ${result.signatureVerified})`);
  } catch (e) {
    console.log('⚠️  Could not submit attestation:', e.message);
  }

  // Identity update on-chain (includes dispute outcome if applicable)
  try {
    console.log('→ Updating on-chain identity...');
    if (postDeliveryResult.disputeOutcome) {
      console.log(`  Dispute outcome: ${postDeliveryResult.disputeOutcome.action}`);
    }
    // The actual updateidentity call happens via acceptReview
    // when a review is submitted after dispute resolution.
  } catch (e) {
    console.log('⚠️  Identity update error:', e.message);
  }

  // Clean up job data
  try {
    const filesDir = path.join(JOB_DIR, 'files');
    if (fs.existsSync(filesDir)) {
      fs.rmSync(filesDir, { recursive: true, force: true });
      console.log('🗑️  Downloaded files deleted');
    }
    for (const f of ['description.txt', 'buyer.txt', 'amount.txt', 'currency.txt']) {
      const fp = path.join(JOB_DIR, f);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    console.log('🗑️  Job data cleaned up (attestation + log preserved)');
  } catch (cleanErr) {
    console.warn('⚠️  Cleanup error:', cleanErr.message);
  }

  console.log(`\n🏁 Job complete (${postDeliveryResult.reason}). Container will be destroyed.\n`);

  agent.stop();
  process.exit(0);
}

main().catch(e => {
  console.error('❌ Fatal error:', e);
  process.exit(1);
});
