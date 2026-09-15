'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  buildJobChatMessage,
  sendBuyerJobChat,
} = require('../src/buyer-job-chat');

const BUYER = {
  identity: 'alice.agentplatform@',
  iAddress: 'iAliceBuyer',
  address: 'Ralice',
  wif: 'WIF-MUST-NOT-PRINT',
};
const JOB = {
  id: 'job-labour-1',
  jobHash: 'abc123def456',
  buyerVerusId: 'alice.agentplatform@',
  sellerVerusId: 'bob.agentplatform@',
  status: 'in_progress',
};

function contentHash(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function fakeClock(startMs = 1_000_000) {
  let t = startMs;
  return {
    nowMs: () => t,
    nowSec: () => Math.floor(t / 1000),
    sleep: async (ms) => { t += Number(ms) || 0; },
  };
}

test('buildJobChatMessage is J41-CHAT|Job|Ts|sha256(utf8 content)', () => {
  const content = 'please review the patch';
  const msg = buildJobChatMessage({ jobHash: JOB.jobHash, timestamp: 1700000000, content });
  assert.ok(msg.startsWith('J41-CHAT|'), 'signature payload must start with J41-CHAT|');
  assert.equal(msg, `J41-CHAT|Job:${JOB.jobHash}|Ts:1700000000|${contentHash(content)}`);
  assert.equal(msg.includes(content), false, 'raw content is hashed, not concatenated');
});

test('sendBuyerJobChat signs J41-CHAT| and POSTs { content, signature, timestamp }', async () => {
  const sent = [];
  const signed = [];
  const client = {
    getJob: async () => JOB,
    sendChatMessage: async () => { throw new Error('SDK sendChatMessage omits timestamp — must wrap'); },
    request: async (method, path, body) => {
      sent.push({ method, path, body });
      return { data: { id: 'm1', content: body.content, senderVerusId: BUYER.identity } };
    },
    getChatMessages: async () => { throw new Error('must not poll without --wait'); },
  };
  const r = await sendBuyerJobChat({
    client,
    keys: BUYER,
    jobId: JOB.id,
    content: 'hello seller',
    signMessage: (wif, message, network) => {
      signed.push({ message, network, wifLen: String(wif || '').length });
      return 'sig-from-buyer-wif';
    },
    network: 'verustest',
    now: 1_700_000_111,
  });
  assert.equal(r.ok, true);
  assert.equal(signed.length, 1);
  assert.ok(signed[0].message.startsWith('J41-CHAT|'));
  assert.equal(
    signed[0].message,
    `J41-CHAT|Job:${JOB.jobHash}|Ts:1700000111|${contentHash('hello seller')}`,
  );
  assert.equal(signed[0].network, 'verustest');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].path, `/v1/jobs/${JOB.id}/messages`);
  assert.equal(sent[0].body.content, 'hello seller');
  assert.equal(sent[0].body.signature, 'sig-from-buyer-wif');
  assert.equal(sent[0].body.timestamp, 1_700_000_111);
  assert.equal(typeof sent[0].body.timestamp, 'number');
});

test('SDK sendChatMessage-only client cannot POST timestamp — JOB_CHAT_CLIENT_MISSING', async () => {
  const r = await sendBuyerJobChat({
    client: {
      getJob: async () => JOB,
      sendChatMessage: async () => ({ id: 'nope' }),
    },
    keys: BUYER,
    jobId: JOB.id,
    content: 'hello seller',
    signMessage: () => 'sig',
    now: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'JOB_CHAT_CLIENT_MISSING');
});

test('unsigned REST is not a skip: empty/missing signature is never sent', async () => {
  const sent = [];
  const r = await sendBuyerJobChat({
    client: {
      getJob: async () => JOB,
      request: async (_m, _p, body) => {
        sent.push(body);
        return {};
      },
    },
    keys: BUYER,
    jobId: JOB.id,
    content: 'hi',
    signMessage: () => '',
    now: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'JOB_CHAT_UNSIGNED');
  assert.equal(sent.length, 0);
});

test('not the buyer or a terminal job never POSTs messages', async () => {
  let sent = 0;
  const request = async () => { sent += 1; };
  const stranger = await sendBuyerJobChat({
    client: { getJob: async () => JOB, request },
    keys: { identity: 'eve.agentplatform@', iAddress: 'iEve', address: 'Reve', wif: 'WIF' },
    jobId: JOB.id,
    content: 'hi',
    signMessage: () => 'sig',
  });
  assert.equal(stranger.ok, false);
  assert.equal(stranger.code, 'JOB_CHAT_NOT_BUYER');

  const done = await sendBuyerJobChat({
    client: {
      getJob: async () => ({ ...JOB, status: 'completed' }),
      request,
    },
    keys: BUYER,
    jobId: JOB.id,
    content: 'hi',
    signMessage: () => 'sig',
  });
  assert.equal(done.ok, false);
  assert.equal(done.code, 'JOB_CHAT_TERMINAL');
  assert.equal(sent, 0);
});

test('--wait polls getChatMessages until a non-buyer line exists', async () => {
  const clock = fakeClock();
  let polls = 0;
  const r = await sendBuyerJobChat({
    client: {
      getJob: async () => JOB,
      request: async (_m, _p, body) => {
        assert.equal(body.signature, 'sig');
        assert.equal(typeof body.timestamp, 'number');
        return { data: { id: 'm1', content: body.content, senderVerusId: BUYER.identity } };
      },
      getChatMessages: async () => {
        polls += 1;
        const buyerLine = { senderVerusId: BUYER.identity, role: 'buyer', content: 'hello seller' };
        if (polls < 2) return { data: [buyerLine] };
        return {
          data: [
            buyerLine,
            { senderVerusId: JOB.sellerVerusId, role: 'seller', content: 'working on it' },
          ],
        };
      },
    },
    keys: BUYER,
    jobId: JOB.id,
    content: 'hello seller',
    signMessage: () => 'sig',
    wait: true,
    waitMs: 30_000,
    pollMs: 5_000,
    nowMs: clock.nowMs,
    sleep: clock.sleep,
    now: clock.nowSec(),
  });
  assert.equal(r.ok, true);
  assert.equal(r.sellerReply && r.sellerReply.content, 'working on it');
  assert.equal(r.timedOut, false);
  assert.ok(polls >= 2);
});

test('--wait does not latch a canned greeting already on the job', async () => {
  const clock = fakeClock();
  const greeting = { id: 'g1', senderVerusId: JOB.sellerVerusId, role: 'seller', content: 'Hi there canned' };
  const pong = { id: 'g2', senderVerusId: JOB.sellerVerusId, role: 'seller', content: 'pong' };
  let polls = 0;
  const r = await sendBuyerJobChat({
    client: {
      getJob: async () => JOB,
      request: async () => ({ data: { id: 'm1', content: 'ping' } }),
      getChatMessages: async () => {
        polls += 1;
        if (polls === 1) return { data: [greeting] };
        if (polls === 2) return { data: [greeting] };
        return { data: [greeting, pong] };
      },
    },
    keys: BUYER,
    jobId: JOB.id,
    content: 'ping',
    signMessage: () => 'sig',
    wait: true,
    waitMs: 30_000,
    pollMs: 5_000,
    nowMs: clock.nowMs,
    sleep: clock.sleep,
    now: clock.nowSec(),
  });
  assert.equal(r.ok, true);
  assert.equal(r.sellerReply && r.sellerReply.content, 'pong');
});

test('job-chat refuses gpu-rental', async () => {
  const r = await sendBuyerJobChat({
    client: {
      getJob: async () => ({ ...JOB, serviceType: 'gpu-rental' }),
      request: async () => { throw new Error('must not POST'); },
    },
    keys: BUYER,
    jobId: JOB.id,
    content: 'ping',
    signMessage: () => 'sig',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'JOB_CHAT_NOT_LABOUR');
});

test('--wait timeout is exit-0: ok true, sellerReply null', async () => {
  const clock = fakeClock();
  const r = await sendBuyerJobChat({
    client: {
      getJob: async () => JOB,
      request: async (_m, _p, body) => {
        assert.ok(body.signature);
        assert.equal(typeof body.timestamp, 'number');
        return { data: { id: 'm1', content: body.content, senderVerusId: BUYER.identity } };
      },
      getChatMessages: async () => ({
        data: [{ senderVerusId: BUYER.identity, role: 'buyer', content: 'hello' }],
      }),
    },
    keys: BUYER,
    jobId: JOB.id,
    content: 'hello',
    signMessage: () => 'sig',
    wait: true,
    waitMs: 15_000,
    pollMs: 5_000,
    nowMs: clock.nowMs,
    sleep: clock.sleep,
    now: clock.nowSec(),
  });
  assert.equal(r.ok, true);
  assert.equal(r.sellerReply, null);
  assert.equal(r.timedOut, true);
});

test('CLI job-chat is labour (job-id) and distinct from model chat (seller)', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  assert.match(cli, /\.command\('chat <buyer-agent-id> <seller>'\)/);
  assert.match(cli, /\.command\('job-chat <buyer-agent-id> <job-id>'\)/);
  const chatStart = cli.indexOf(".command('chat <buyer-agent-id> <seller>')");
  const jobChatStart = cli.indexOf(".command('job-chat <buyer-agent-id> <job-id>')");
  assert.ok(chatStart > -1 && jobChatStart > -1);
  const chatSrc = cli.slice(chatStart, jobChatStart);
  assert.match(chatSrc, /chatCompletions/);
  assert.doesNotMatch(chatSrc, /sendBuyerJobChat/);
  const next = cli.indexOf(".command('update-profile", jobChatStart);
  const jobChatSrc = cli.slice(jobChatStart, next > -1 ? next : jobChatStart + 2500);
  assert.match(jobChatSrc, /sendBuyerJobChat/);
  assert.match(jobChatSrc, /require\('\.\/buyer-job-chat'\)/);
  assert.match(jobChatSrc, /signMessage/);
  assert.match(jobChatSrc, /sovagent-sdk\/dist\//);
  assert.match(jobChatSrc, /\.option\('--wait'/);
  assert.match(jobChatSrc, /\.option\('--json'/);
  assert.doesNotMatch(jobChatSrc, /chatCompletions/);
  assert.doesNotMatch(jobChatSrc, /sendChatMessage\(/);
});
