'use strict';
/**
 * Buyer labour job-chat. Model inference is `chat` (grant + callProxied);
 * this module POSTs a signed REST line to an existing hire job.
 *
 * Backend verifies J41-CHAT from POST { content, signature, timestamp }.
 * SDK 2.16.1 sendChatMessage omits timestamp — wrap via client.request.
 */
const crypto = require('crypto');
const { buyerOwnsJob } = require('./hire-pay');

const JOB_CHAT_TERMINAL = ['completed', 'cancelled', 'refunded', 'resolved', 'resolved_rejected'];
const DEFAULT_WAIT_MS = 180000;
const DEFAULT_POLL_MS = 5000;

function contentSha256(content) {
  return crypto.createHash('sha256').update(String(content), 'utf8').digest('hex');
}

function buildJobChatMessage({ jobHash, timestamp, content } = {}) {
  const ts = Number(timestamp);
  return `J41-CHAT|Job:${jobHash}|Ts:${ts}|${contentSha256(content)}`;
}

function isTerminalJobStatus(status) {
  return JOB_CHAT_TERMINAL.includes(String(status || ''));
}

function chatLines(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.data)) return raw.data;
  if (Array.isArray(raw.messages)) return raw.messages;
  return [];
}

function actorOf(msg) {
  if (!msg || typeof msg !== 'object') return '';
  return String(msg.role || msg.sender || msg.senderVerusId || '')
    .replace(/@$/, '')
    .toLowerCase();
}

function buyerAliases(keys) {
  return [keys && keys.identity, keys && keys.iAddress, keys && keys.address]
    .filter(Boolean)
    .map((s) => String(s).replace(/@$/, '').toLowerCase());
}

function isSellerChatLine(msg, keys) {
  const actor = actorOf(msg);
  if (!actor) return false;
  if (actor === 'buyer' || actor === 'user' || actor === 'system') return false;
  if (actor === 'seller' || actor === 'agent' || actor === 'assistant') return true;
  return !buyerAliases(keys).includes(actor);
}

function sellerLineKey(msg) {
  if (!msg || typeof msg !== 'object') return '';
  return [msg.id, msg.timestamp, msg.ts, msg.content || msg.message || ''].join('|');
}

function pickSellerReply(raw, keys, seenKeys) {
  const seen = seenKeys instanceof Set ? seenKeys : null;
  return chatLines(raw).find((m) => {
    if (!isSellerChatLine(m, keys)) return false;
    if (!seen) return true;
    return !seen.has(sellerLineKey(m));
  }) || null;
}

async function defaultSleep(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return;
  await new Promise((r) => setTimeout(r, n));
}

function resolveSignMessage(signFn) {
  if (typeof signFn === 'function') return signFn;
  // Lazy SDK load — tests inject signMessage so this path is CLI-only.
  const { signMessage } = require('@junction41/sovagent-sdk/dist/identity/signer.js');
  return signMessage;
}

function unwrapRequestData(res) {
  if (res && typeof res === 'object' && res.data !== undefined) return res.data;
  return res;
}

async function postSignedJobChat(client, jobId, body) {
  if (typeof client.postJobChat === 'function') {
    return client.postJobChat(jobId, body);
  }
  const res = await client.request(
    'POST',
    `/v1/jobs/${encodeURIComponent(jobId)}/messages`,
    body,
  );
  return unwrapRequestData(res);
}

async function sendBuyerJobChat({
  client,
  keys,
  jobId,
  content,
  signMessage: signFn,
  network,
  now,
  wait = false,
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  nowMs,
  sleep,
} = {}) {
  const text = content == null ? '' : String(content);
  if (!text.trim()) {
    return { ok: false, code: 'JOB_CHAT_EMPTY', message: '--message is required.' };
  }
  const canPost = client && (typeof client.request === 'function' || typeof client.postJobChat === 'function');
  if (!client || typeof client.getJob !== 'function' || !canPost) {
    return { ok: false, code: 'JOB_CHAT_CLIENT_MISSING', message: 'Authenticated client is required (POST { content, signature, timestamp }).' };
  }
  if (!keys || !keys.wif) {
    return { ok: false, code: 'BUYER_NOT_REGISTERED', message: 'Buyer WIF is required to sign job-chat.' };
  }

  let job;
  try {
    job = await client.getJob(jobId);
  } catch (e) {
    return { ok: false, code: 'JOB_CHAT_FAILED', message: e.message || String(e) };
  }
  if (!job || !job.id) {
    return { ok: false, code: 'JOB_CHAT_NOT_FOUND', message: `Job ${jobId} not found.` };
  }
  if (!buyerOwnsJob(keys, job)) {
    return { ok: false, code: 'JOB_CHAT_NOT_BUYER', message: 'This identity is not the buyer on that job.' };
  }
  if (isTerminalJobStatus(job.status)) {
    return {
      ok: false,
      code: 'JOB_CHAT_TERMINAL',
      message: `Job status ${job.status} is terminal — chat is closed.`,
      jobId: job.id,
      status: job.status,
    };
  }
  if (!job.jobHash) {
    return { ok: false, code: 'JOB_CHAT_NO_HASH', message: 'Job is missing jobHash — cannot sign chat.' };
  }
  const serviceType = job.serviceType || job.service_type;
  const jobKind = job.kind || job.listingKind;
  if (serviceType === 'gpu-rental' || serviceType === 'api-endpoint' || jobKind === 'compute' || jobKind === 'model') {
    return {
      ok: false,
      code: 'JOB_CHAT_NOT_LABOUR',
      message: 'job-chat is for labour hires. GPU is SSH; models are access/chat.',
      jobId: job.id,
    };
  }

  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Math.floor(Date.now() / 1000);
  const payload = buildJobChatMessage({ jobHash: job.jobHash, timestamp, content: text });
  if (!payload.startsWith('J41-CHAT|')) {
    return { ok: false, code: 'JOB_CHAT_UNSIGNED', message: 'Refusing to send unsigned job-chat.' };
  }

  let signature;
  try {
    signature = await resolveSignMessage(signFn)(keys.wif, payload, network);
  } catch (e) {
    return { ok: false, code: 'JOB_CHAT_FAILED', message: e.message || String(e) };
  }
  if (typeof signature !== 'string' || !signature) {
    return { ok: false, code: 'JOB_CHAT_UNSIGNED', message: 'Refusing to send unsigned job-chat.' };
  }

  const body = { content: text, signature, timestamp };
  const seenSeller = new Set();
  if (wait && typeof client.getChatMessages === 'function') {
    try {
      const prior = await client.getChatMessages(job.id);
      for (const m of chatLines(prior)) {
        if (isSellerChatLine(m, keys)) seenSeller.add(sellerLineKey(m));
      }
    } catch { /* poll loop will surface a hard getChatMessages failure */ }
  }
  let sent;
  try {
    sent = await postSignedJobChat(client, job.id, body);
  } catch (e) {
    return { ok: false, code: 'JOB_CHAT_FAILED', message: e.message || String(e) };
  }

  const result = {
    ok: true,
    jobId: job.id,
    sent: sent || { content: text },
    sellerReply: null,
    timedOut: false,
  };
  if (!wait) return result;
  if (typeof client.getChatMessages !== 'function') {
    return { ok: false, code: 'JOB_CHAT_FAILED', message: 'Client cannot poll getChatMessages.' };
  }

  const nowMsFn = typeof nowMs === 'function' ? nowMs : Date.now;
  const sleepFn = typeof sleep === 'function' ? sleep : defaultSleep;
  const budget = Number.isFinite(Number(waitMs)) ? Number(waitMs) : DEFAULT_WAIT_MS;
  const interval = Number.isFinite(Number(pollMs)) ? Number(pollMs) : DEFAULT_POLL_MS;
  const deadline = nowMsFn() + budget;

  while (true) {
    let raw;
    try {
      raw = await client.getChatMessages(job.id);
    } catch (e) {
      return { ok: false, code: 'JOB_CHAT_FAILED', message: e.message || String(e), jobId: job.id };
    }
    const seller = pickSellerReply(raw, keys, seenSeller);
    if (seller) {
      result.sellerReply = seller;
      result.timedOut = false;
      return result;
    }
    if (nowMsFn() >= deadline) break;
    await sleepFn(interval);
    if (nowMsFn() >= deadline) break;
  }
  result.sellerReply = null;
  result.timedOut = true;
  return result;
}

module.exports = {
  buildJobChatMessage,
  sendBuyerJobChat,
  postSignedJobChat,
  isSellerChatLine,
  sellerLineKey,
  isTerminalJobStatus,
  JOB_CHAT_TERMINAL,
  DEFAULT_WAIT_MS,
};
