'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  appendChatOutboxLine,
  relayChatOutbox,
  installSealedChatFallback,
  outboxHasPending,
  chatSealRequiredError,
} = require('../src/chat-outbox');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'j41-outbox-'));
}

test('a sealed worker line is queued and the parent posts it once', async () => {
  const root = tmp();
  const jobId = 'job-seal-01';
  const jobDir = path.join(root, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  assert.equal(appendChatOutboxLine(jobDir, 'Reply with the single word pong.'), true);
  assert.equal(appendChatOutboxLine(jobDir, '   '), false);
  assert.equal(outboxHasPending(jobDir, root, jobId), true);
  const posted = [];
  const first = await relayChatOutbox({
    jobDir,
    jobsDir: root,
    jobId,
    post: async (text) => { posted.push(text); },
  });
  assert.equal(first.posted, 1);
  assert.deepEqual(posted, ['Reply with the single word pong.']);
  const second = await relayChatOutbox({
    jobDir,
    jobsDir: root,
    jobId,
    post: async () => { throw new Error('must not post twice'); },
  });
  assert.equal(second.posted, 0);
  assert.equal(outboxHasPending(jobDir, root, jobId), false);
  const offsetFile = path.join(root, '_chat-offsets', jobId);
  assert.equal(fs.existsSync(path.join(jobDir, '_chat-offsets')), false);
  assert.equal(fs.existsSync(offsetFile), true);
});

test('a failed post leaves the line for the next pass', async () => {
  const root = tmp();
  const jobId = 'job-seal-02';
  const jobDir = path.join(root, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  appendChatOutboxLine(jobDir, 'first line');
  appendChatOutboxLine(jobDir, 'second line');
  await assert.rejects(() => relayChatOutbox({
    jobDir,
    jobsDir: root,
    jobId,
    post: async (text) => { if (text === 'second line') throw new Error('offline'); },
  }), /offline/);
  const posted = [];
  await relayChatOutbox({
    jobDir,
    jobsDir: root,
    jobId,
    post: async (text) => { posted.push(text); },
  });
  assert.deepEqual(posted, ['second line']);
});

test('plaintext is queued once both seals exist and is sent before that', async () => {
  const root = tmp();
  const jobDir = path.join(root, 'job-seal-03');
  fs.mkdirSync(jobDir, { recursive: true });
  const sent = [];
  const agent = {
    sendChatMessage(jobId, text) { sent.push({ jobId, text }); },
  };
  installSealedChatFallback(agent, jobDir, async () => false);
  await agent.sendChatMessage('job-seal-03', 'hello');
  assert.equal(sent.length, 1);
  assert.equal(fs.existsSync(path.join(jobDir, 'chat-outbox.jsonl')), false);

  const sealed = {
    sendChatMessage() { throw new Error('must not send plaintext'); },
  };
  installSealedChatFallback(sealed, jobDir, async () => true);
  const queued = await sealed.sendChatMessage('job-seal-03', 'worker line');
  assert.equal(queued.queued, true);
  const prefixed = `(part 1/2)\n${'p'.repeat(3900)}`;
  const longQueued = await sealed.sendChatMessage('job-seal-03', prefixed);
  assert.equal(longQueued.queued, true);
  await assert.rejects(
    () => sealed.sendChatMessage('job-seal-03', 'x'.repeat(4001)),
    (err) => err && err.code === 'CHAT_OUTBOX_REJECTED',
  );
  assert.equal(chatSealRequiredError({ code: 'CHAT_SEAL_REQUIRED' }), true);
  assert.equal(chatSealRequiredError({ message: 'This job chat must be a sealed message' }), true);
});

test('the worker and the parent are wired to the outbox', () => {
  const worker = fs.readFileSync(path.join(__dirname, '../src/job-agent.js'), 'utf8');
  assert.match(worker, /installSealedChatFallback/);
  assert.match(worker, /if \(isSealArmorMessage\(msg\)\) return/);
  assert.match(worker, /contentEncoding: m\.contentEncoding \|\| m\.content_encoding/);
  const parent = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  assert.match(parent, /relayWorkerSealedChat/);
  assert.match(parent, /purgeUnhostedCanaries/);
  assert.match(parent, /contentEncoding: 'j41-seal-v1'/);
});
