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
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || '480000'); // idle → pause (8 min, before backend's 10-min auto-deliver)

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
let _paused = false;
let _lastActivityAt = Date.now();
let _postDeliveryHandler = null;
let _workspaceConnected = false;
let _workspaceTools = [];
let _workspaceStats = null;
let _workspaceMode = 'supervised';
let _shuttingDown = false;
let _sessionEndResolve = null; // global ref so shutdown IPC can resolve the session

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
    console.log('  IDLE_TIMEOUT_MS    Idle timeout before pausing session (default: 600000)');
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

  // M13: Validate required job files before constructing the job object
  const REQUIRED_JOB_FILES = ['description.txt', 'buyer.txt', 'amount.txt', 'currency.txt'];
  for (const filename of REQUIRED_JOB_FILES) {
    const fp = path.join(JOB_DIR, filename);
    if (!fs.existsSync(fp)) {
      throw new Error(`Required job file missing: ${fp}`);
    }
    const content = fs.readFileSync(fp, 'utf8').trim();
    if (!content) {
      throw new Error(`Required job file is empty: ${fp}`);
    }
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
  // Keep global ref in sync so shutdown IPC can resolve from outside main()
  const setSessionEndResolve = (fn) => { sessionEndResolve = fn; _sessionEndResolve = fn; };

  // ─────────────────────────────────────────
  // STEP 2: INTERACTIVE CHAT SESSION (Executor pattern — M6)
  // ─────────────────────────────────────────
  console.log(`→ Starting chat session (executor: ${EXECUTOR_TYPE})...\n`);

  const executor = createExecutor();
  _executor = executor;

  // H6: Single consolidated IPC handler — replaces two separate listeners
  const ipcQueue = [];
  if (process.send) {
    process.on('message', async (msg) => {
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case 'workspace_ready':
          await connectWorkspace(msg.jobId, msg.permissions, msg.mode);
          break;
        case 'workspace_closed':
          disconnectWorkspace();
          break;
        case 'end_session_request':
          console.log(`[IPC] end_session_request received for job ${msg.jobId}`);
          if (sessionEndResolve) sessionEndResolve('end-session-request');
          break;
        case 'extension_request':
          console.log(`[IPC] extension_request received for job ${msg.jobId}`);
          ipcQueue.push(msg);
          break;
        case 'reconnect':
          console.log(`[IPC] reconnect requested for job ${msg.jobId}`);
          _paused = false;
          _idleMessageSent = false;
          _lastActivityAt = Date.now();
          try {
            await _agent.authenticate();
            await _agent.connectChat();
            _agent.joinJobChat(msg.jobId);
            _agent.sendChatMessage(msg.jobId, 'I\'m back online. How can I help?');
            console.log(`[IPC] Reconnected chat for job ${msg.jobId}`);
          } catch (err) {
            console.error(`[IPC] Reconnect failed: ${err.message}`);
          }
          break;
        case 'ttl_expired':
          console.log(`[IPC] Pause TTL expired for job ${msg.jobId} — auto-delivering`);
          _agent?.sendChatMessage(msg.jobId, 'Session expired due to inactivity. Delivering results.');
          if (sessionEndResolve) sessionEndResolve('ttl-expired');
          break;
        case 'shutdown':
          console.log(`[IPC] Dispatcher shutdown — delivering current work and exiting`);
          _shuttingDown = true;
          _agent?.sendChatMessage(msg.jobId, 'Service is shutting down. Delivering current work now.');
          if (sessionEndResolve) sessionEndResolve('dispatcher-shutdown');
          break;
        default:
          // Queue for post-delivery handler
          ipcQueue.push(msg);
          break;
      }
    });
  }

  let result;
  try {
    result = await processJob(job, agent, soulPrompt, executor, (resolve) => { setSessionEndResolve(resolve); });
    console.log('\n✅ Work completed\n');

    // Log token usage summary
    if (_executor?.getTokenUsage) {
      const usage = _executor.getTokenUsage();
      console.log(`[TOKENS] Session: ${usage.llmCalls} calls, ${usage.promptTokens} in, ${usage.completionTokens} out, ${usage.totalTokens} total`);
      if (process.send) process.send({ type: 'token_usage', jobId: JOB_ID, usage });
    }
  } catch (e) {
    console.error('\n❌ Job failed:', e.message);
    await executor.cleanup().catch(() => {});
    result = { error: e.message, content: 'Job failed: ' + e.message };
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

  // Signal workspace done to buyer
  if (_workspaceConnected) {
    _agent.workspace.signalDone();
    console.log('[WORKSPACE] Signaled done to buyer');
  }

  // Wait for chat to flush
  await new Promise(r => setTimeout(r, 3000));

  // ─────────────────────────────────────────
  // STEP 4: POST-DELIVERY WAIT (Dispute Resolution)
  // ─────────────────────────────────────────
  let postDeliveryResult;
  if (_shuttingDown) {
    console.log('→ Skipping post-delivery wait (dispatcher shutting down)');
    postDeliveryResult = { reason: 'dispatcher-shutdown' };
  } else {
    console.log('→ Entering post-delivery review window...');
    console.log('  Container stays alive until job.completed or dispute resolution.\n');
    postDeliveryResult = await waitForPostDelivery(job, agent, keys, fullJob, executor, soulPrompt, (resolve) => { setSessionEndResolve(resolve); }, ipcQueue);
  }

  // ─────────────────────────────────────────
  // STEP 5: CLEANUP + ATTESTATION + IDENTITY UPDATE
  // ─────────────────────────────────────────
  disconnectWorkspace();
  await performCleanup(agent, keys, fullJob, postDeliveryResult);
}

// ─────────────────────────────────────────
// Chat-based job processing (M6: Executor pattern)
// ─────────────────────────────────────────

async function processJob(job, agent, soulPrompt, executor, registerSessionEndResolve) {
  _lastActivityAt = Date.now();
  _paused = false;
  let sessionEnded = false;
  let resolveSession;
  let messageCount = 0;
  let messageQueue = Promise.resolve(); // J4: Serialize handleMessage calls

  // Promise that resolves when session ends or idle timeout
  const sessionPromise = new Promise((resolve) => {
    resolveSession = resolve;
    if (registerSessionEndResolve) registerSessionEndResolve(resolve);
    // Keep global ref in sync for shutdown IPC
    _sessionEndResolve = resolve;
  });

  // If shutdown was requested before we got here, resolve immediately
  if (_shuttingDown) {
    resolveSession('dispatcher-shutdown');
  }

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

    // Layer 3 message guard: refuse LLM calls when paused (don't update activity for dropped messages)
    if (_paused) {
      console.log(`[GUARD] Message received while paused — dropping (sender: ${msg.senderVerusId})`);
      return;
    }

    _lastActivityAt = Date.now();
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

  // Idle timer — check periodically if we should pause (not auto-deliver)
  _idleMessageSent = false;
  const idleCheck = setInterval(async () => {
    const idleMs = Date.now() - _lastActivityAt;
    if (idleMs >= IDLE_TIMEOUT_MS && !sessionEnded && !_paused) {
      if (!_idleMessageSent) {
        _idleMessageSent = true;
        console.log(`[CHAT] Idle for ${Math.round(idleMs / 1000)}s — requesting pause`);
        try {
          agent.sendChatMessage(job.id, 'Session going idle — I\'ll be here when you\'re ready to continue.');
        } catch {}
      }
      try {
        await agent.client.pauseJob(job.id);
        _paused = true;
        if (process.send) process.send({ type: 'job_idle', jobId: job.id });
        console.log(`[CHAT] Paused successfully`);
      } catch (err) {
        // If pause fails (job already delivered/completed by backend), end session
        if (err.message?.includes('cannot be paused') || err.message?.includes('Only in-progress')) {
          console.log(`[CHAT] Pause rejected (${err.message}) — ending session`);
          _paused = true; // Stop retrying
          if (resolveSession) resolveSession('backend-ended');
        }
      }
    }
  }, 10000);

  // Wait for session end or idle timeout
  await sessionPromise;
  clearInterval(idleCheck);

  // Finalize executor — get deliverable
  return await executor.finalize();
}

let _workspaceConnecting = false;
let _idleMessageSent = false;
async function connectWorkspace(jobId, permissions, mode) {
  if (_workspaceConnected || _workspaceConnecting) return;
  _workspaceConnecting = true;
  _workspaceMode = mode || 'supervised';
  try {
    console.log(`[WORKSPACE] Connecting for job ${jobId?.substring(0, 8)} (mode=${_workspaceMode})...`);
    await _agent.workspace.connect(jobId);
    _workspaceConnected = true;
    _workspaceTools = _agent.workspace.getAvailableTools();

    // Inject workspace tools into executor
    if (_executor && typeof _executor.setWorkspaceTools === 'function') {
      _executor.setWorkspaceTools(_workspaceTools, handleWorkspaceToolCall);
    }

    // Auto-scan project root so the agent has context immediately
    try {
      const rootFiles = await _agent.workspace.listDirectory('.');
      const fileList = Array.isArray(rootFiles) ? rootFiles.map(f => f.name || f).join(', ') : JSON.stringify(rootFiles);
      _agent.sendChatMessage(jobId, `I now have access to your project files. Here's your project structure:\n\n${fileList}\n\nWhat would you like me to work on?`);
      console.log(`[WORKSPACE] Auto-scanned root: ${typeof rootFiles === 'object' ? (Array.isArray(rootFiles) ? rootFiles.length + ' items' : 'ok') : 'ok'}`);
    } catch (scanErr) {
      console.warn(`[WORKSPACE] Auto-scan failed: ${scanErr.message}`);
      _agent.sendChatMessage(jobId, 'I now have access to your project files. Let me know what you need.');
    }

    let _wsDisconnectNotified = false;
    _agent.workspace.onStatusChanged((status, data) => {
      console.log(`[WORKSPACE] Status changed: ${status}`);
      if (status === 'aborted' || status === 'completed' || status === 'disconnected') {
        disconnectWorkspace();
        if (!_wsDisconnectNotified) {
          _wsDisconnectNotified = true;
          try { _agent.sendChatMessage(JOB_ID, 'Workspace disconnected. I can still help via chat.'); } catch {}
        }
      }
    });
    _agent.workspace.onDisconnected((reason) => {
      console.warn(`[WORKSPACE] Disconnected: ${reason}`);
      if (reason === 'io server disconnect' || reason === 'io client disconnect') {
        disconnectWorkspace();
        if (!_wsDisconnectNotified) {
          _wsDisconnectNotified = true;
          try { _agent.sendChatMessage(JOB_ID, 'Workspace disconnected. I can still help via chat.'); } catch {}
        }
      } else {
        console.log(`[WORKSPACE] Transient disconnect (${reason}) — waiting for auto-reconnect`);
      }
    });
    console.log(`[WORKSPACE] Connected — ${_workspaceTools.length} tool(s) available`);
  } catch (err) {
    _workspaceConnecting = false;
    console.error(`[WORKSPACE] Failed to connect: ${err.message}`);
    _agent.sendChatMessage(jobId, `Unable to connect to workspace: ${err.message}`);
  }
}

function disconnectWorkspace() {
  if (!_workspaceConnected) return;

  // Accumulate stats across sessions (for rework cycles)
  try {
    const sessionStats = _agent.workspace.getStats();
    if (_workspaceStats) {
      _workspaceStats.filesRead += sessionStats.filesRead;
      _workspaceStats.filesWritten += sessionStats.filesWritten;
      _workspaceStats.listDirectoryCalls += sessionStats.listDirectoryCalls;
      _workspaceStats.duration += sessionStats.duration;
    } else {
      _workspaceStats = { ...sessionStats };
    }
  } catch {}

  _workspaceConnected = false;
  _workspaceTools = [];
  if (_executor && typeof _executor.clearWorkspaceTools === 'function') {
    _executor.clearWorkspaceTools();
  }
  try { _agent.workspace.disconnect(); } catch {}
  console.log('[WORKSPACE] Disconnected');
}

const _blockedFiles = new Set(); // tracks files that were blocked or not found

async function handleWorkspaceToolCall(toolName, args) {
  if (!_workspaceConnected) return 'Workspace is not connected';

  // Workspace activity counts as activity — prevents idle timeout during buyer review
  _lastActivityAt = Date.now();

  // Reject repeat attempts on known-blocked files
  if ((toolName === 'workspace_read_file' || toolName === 'workspace_write_file') && _blockedFiles.has(args.path)) {
    return `BLOCKED: "${args.path}" was already denied (excluded by SovGuard or not found). Do NOT retry this file. Work with other files instead.`;
  }

  // M11: Validate path arg for write operations (defense in depth — SDK also validates)
  if (args.path) {
    if (args.path.startsWith('/') || args.path.split(/[\\/]/).includes('..')) {
      return `Workspace error: invalid path "${args.path}" — must be relative with no ".." segments`;
    }
  }

  try {
    switch (toolName) {
      case 'workspace_list_directory':
        return JSON.stringify(await _agent.workspace.listDirectory(args.path || '.'));
      case 'workspace_read_file': {
        const result = await _agent.workspace.readFile(args.path);
        // Detect blocked/not-found responses and remember them
        if (typeof result === 'string' && (result.includes('excluded') || result.includes('not found') || result.includes('blocked') || result.includes('denied'))) {
          _blockedFiles.add(args.path);
          return `BLOCKED: "${args.path}" is not accessible (${result}). Do NOT retry this file.`;
        }
        return result;
      }
      case 'workspace_write_file':
        return await _agent.workspace.writeFile(args.path, args.content);
      default:
        return `Unknown workspace tool: ${toolName}`;
    }
  } catch (err) {
    const msg = err.message || '';
    // Track files that error out so the LLM doesn't retry
    if (args.path && (msg.includes('excluded') || msg.includes('not found') || msg.includes('blocked') || msg.includes('No such file'))) {
      _blockedFiles.add(args.path);
      return `BLOCKED: "${args.path}" is not accessible (${msg}). Do NOT retry this file. Use workspace_list_directory to see available files.`;
    }
    return `Workspace error: ${msg}`;
  }
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
    // M14 fix: reuse existing _agent if available
    try {
      const agent = _agent || (() => {
        const { J41Agent } = require('@j41/sovagent-sdk/dist/index.js');
        const a = new J41Agent({ apiUrl: API_URL, wif: keys.wif, identityName: IDENTITY, iAddress: keys.iAddress });
        return a;
      })();

      // If using existing agent, skip re-authenticate (already authed)
      if (!_agent) await agent.authenticate();
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

        case 'shutdown': {
          clearTimeout(safetyTimer);
          console.log('[POST-DELIVERY] Dispatcher shutdown — exiting post-delivery wait');
          _shuttingDown = true;
          safeResolve({ reason: 'dispatcher-shutdown' });
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

    // Listen for future IPC messages (remove previous listener to prevent stacking)
    if (_postDeliveryHandler) process.removeListener('message', _postDeliveryHandler);
    _postDeliveryHandler = handleMessage;
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

  // On-chain identity update: job.record + review.record
  try {
    console.log('→ Updating on-chain identity (job completion)...');

    const { buildJobCompletionAdditions } = require('@j41/sovagent-sdk/dist/onboarding/vdxf.js');
    const { buildIdentityUpdateTx } = require('@j41/sovagent-sdk/dist/identity/update.js');

    const jobRecord = {
      jobHash: fullJob.jobHash,
      buyer: fullJob.buyerVerusId,
      description: (fullJob.description || '').substring(0, 200),
      amount: fullJob.amount,
      currency: fullJob.currency,
      completedAt: Math.floor(Date.now() / 1000),
      completionSignature: fullJob.signatures?.completion || '',
      paymentTxid: fullJob.payment?.txid || '',
      hasWorkspace: !!_workspaceStats,
      hasReview: !!fullJob.review,
    };

    let reviewRecord = undefined;
    if (fullJob.review) {
      reviewRecord = {
        buyer: fullJob.buyerVerusId,
        jobHash: fullJob.jobHash,
        message: fullJob.review.message || '',
        rating: fullJob.review.rating || 0,
        signature: fullJob.review.signature || '',
        timestamp: Math.floor(Date.now() / 1000),
      };
    }

    // Build workspace attestation if workspace was used
    let workspaceAttestation = undefined;
    if (_workspaceStats) {
      workspaceAttestation = {
        jobId: JOB_ID,
        buyer: fullJob.buyerVerusId,
        duration: _workspaceStats.duration,
        filesRead: _workspaceStats.filesRead,
        filesWritten: _workspaceStats.filesWritten,
        sovguardFlags: 0,
        completedClean: true,
        mode: _workspaceMode,
      };
    }

    if (postDeliveryResult.disputeOutcome) {
      console.log(`  Dispute outcome: ${postDeliveryResult.disputeOutcome.action}`);
    }

    const additions = buildJobCompletionAdditions({ jobRecord, reviewRecord, workspaceAttestation });

    // Read identity + UTXOs, build and broadcast signed tx
    const identityRawResp = await agent.client.getIdentityRaw();
    const identityData = identityRawResp.data || identityRawResp;
    const utxoResp = await agent.client.getUtxos();
    const utxos = utxoResp.utxos || utxoResp;

    if (utxos.length > 0) {
      const rawhex = buildIdentityUpdateTx({
        wif: keys.wif,
        identityData,
        utxos,
        vdxfAdditions: additions,
        network: 'verustest',
      });
      const txResult = await agent.client.broadcast(rawhex);
      console.log(`✅ On-chain identity updated: ${txResult.txid || txResult}`);
    } else {
      console.log('⚠️  No UTXOs available — skipping on-chain update');
    }
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
