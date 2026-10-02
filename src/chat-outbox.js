'use strict';

/**
 * Worker lines that cannot be posted as plaintext once both job seals exist.
 * The container writes the line into the job directory. The parent, which
 * holds the seller key, seals it and posts it. The viewing key never enters
 * the container. The byte offset lives beside the job directory, not inside
 * the bind mount, so the container cannot rewind or skip a line.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isValidJobId } = require('./job-id');

const OUTBOX_NAME = 'chat-outbox.jsonl';
// A chunked reply adds "(part n/m)" in front of a 3900-character piece.
// 4000 is the platform plaintext cap, so that prefix still fits.
const MAX_TEXT = 4000;

function chatSealRequiredError(err) {
  if (!err) return false;
  const code = err.code || (err.error && err.error.code) || '';
  if (code === 'CHAT_SEAL_REQUIRED') return true;
  const message = String(err.message || (err.error && err.error.message) || '');
  return /must be a sealed message/i.test(message) || /CHAT_SEAL_REQUIRED/.test(message);
}

function outboxPath(jobDir) {
  return path.join(jobDir, OUTBOX_NAME);
}

function offsetPath(jobsDir, jobId) {
  if (!isValidJobId(jobId)) {
    const err = new Error('invalid job id');
    err.code = 'CHAT_OUTBOX_JOB';
    throw err;
  }
  return path.join(jobsDir, '_chat-offsets', jobId);
}

function appendChatOutboxLine(jobDir, text, fsImpl = fs) {
  const body = String(text == null ? '' : text).trim();
  if (!body || body.length > MAX_TEXT) return false;
  const line = JSON.stringify({ id: crypto.randomBytes(16).toString('hex'), text: body }) + '\n';
  fsImpl.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const file = outboxPath(jobDir);
  const fd = fsImpl.openSync(
    file,
    fsImpl.constants.O_WRONLY | fsImpl.constants.O_CREAT | fsImpl.constants.O_APPEND | fsImpl.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fsImpl.writeFileSync(fd, line);
  } finally {
    fsImpl.closeSync(fd);
  }
  return true;
}

function readChatOffset(jobsDir, jobId, fsImpl = fs) {
  let file;
  try { file = offsetPath(jobsDir, jobId); } catch { return 0; }
  try {
    const fd = fsImpl.openSync(file, fsImpl.constants.O_RDONLY | fsImpl.constants.O_NOFOLLOW);
    try {
      const n = Number(fsImpl.readFileSync(fd, 'utf8').trim());
      return Number.isInteger(n) && n >= 0 ? n : 0;
    } finally {
      fsImpl.closeSync(fd);
    }
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ELOOP') return 0;
    throw e;
  }
}

function writeChatOffset(jobsDir, jobId, offset, fsImpl = fs) {
  const file = offsetPath(jobsDir, jobId);
  fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fsImpl.openSync(
    file,
    fsImpl.constants.O_WRONLY | fsImpl.constants.O_CREAT | fsImpl.constants.O_TRUNC | fsImpl.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fsImpl.writeFileSync(fd, String(offset));
  } finally {
    fsImpl.closeSync(fd);
  }
}

function readOutboxLines(jobDir, byteOffset, fsImpl = fs) {
  const file = outboxPath(jobDir);
  let fd;
  try {
    fd = fsImpl.openSync(file, fsImpl.constants.O_RDONLY | fsImpl.constants.O_NOFOLLOW);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ELOOP') return [];
    throw e;
  }
  try {
    const stat = fsImpl.fstatSync(fd);
    let start = byteOffset;
    if (start > stat.size) start = 0;
    const len = stat.size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(Math.min(len, 1024 * 1024));
    const read = fsImpl.readSync(fd, buf, 0, buf.length, start);
    const text = buf.subarray(0, read).toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return [];
    const complete = text.slice(0, lastNl);
    const lines = [];
    let cursor = start;
    for (const raw of complete.split('\n')) {
      const end = cursor + Buffer.byteLength(raw, 'utf8') + 1;
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      const body = parsed && typeof parsed.text === 'string' ? parsed.text : '';
      const idOk = parsed && typeof parsed.id === 'string' && /^[0-9a-f]{16,64}$/.test(parsed.id);
      if (idOk && body.length >= 1 && body.length <= MAX_TEXT) lines.push({ id: parsed.id, text: body, end });
      else lines.push({ id: null, text: null, end });
      cursor = end;
    }
    return lines;
  } finally {
    fsImpl.closeSync(fd);
  }
}

function outboxHasPending(jobDir, jobsDir, jobId, fsImpl = fs) {
  const offset = readChatOffset(jobsDir, jobId, fsImpl);
  try {
    const stat = fsImpl.statSync(outboxPath(jobDir));
    return stat.size > offset;
  } catch {
    return false;
  }
}

/**
 * Post each new line. A failed post leaves the offset on that line so the
 * next pass retries it. A line that is not valid JSON is skipped.
 */
async function relayChatOutbox({ jobDir, jobsDir, jobId, post, fsImpl = fs }) {
  const start = readChatOffset(jobsDir, jobId, fsImpl);
  const lines = readOutboxLines(jobDir, start, fsImpl);
  let posted = 0;
  for (const line of lines) {
    if (line.text) {
      await post(line.text);
      posted += 1;
    }
    writeChatOffset(jobsDir, jobId, line.end, fsImpl);
  }
  return { posted, offset: readChatOffset(jobsDir, jobId, fsImpl) };
}

/**
 * Plaintext chat is refused once both seals exist, and the websocket send
 * does not surface that refusal as a thrown error. When `sealsReady` is
 * true, the line is queued for the parent. Otherwise the original send runs.
 */
function queueWorkerLine(jobDir, text, fsImpl) {
  if (appendChatOutboxLine(jobDir, text, fsImpl)) return;
  const err = new Error('worker chat line was not queued');
  err.code = 'CHAT_OUTBOX_REJECTED';
  throw err;
}

function installSealedChatFallback(agent, jobDir, sealsReady, fsImpl = fs) {
  if (!agent || typeof agent.sendChatMessage !== 'function' || agent._j41SealChatFallback) return agent;
  const raw = agent.sendChatMessage.bind(agent);
  agent.sendChatMessage = async (jobId, text) => {
    let sealed = false;
    try { sealed = await sealsReady(jobId); } catch { sealed = false; }
    if (sealed) {
      queueWorkerLine(jobDir, text, fsImpl);
      return { queued: true };
    }
    try {
      return await raw(jobId, text);
    } catch (err) {
      if (!chatSealRequiredError(err)) throw err;
      queueWorkerLine(jobDir, text, fsImpl);
      return { queued: true };
    }
  };
  agent._j41SealChatFallback = true;
  return agent;
}

module.exports = {
  OUTBOX_NAME,
  chatSealRequiredError,
  appendChatOutboxLine,
  readChatOffset,
  readOutboxLines,
  outboxHasPending,
  relayChatOutbox,
  installSealedChatFallback,
};
