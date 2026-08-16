'use strict';
/**
 * Task 2 — host must only act on request files it created.
 *
 * I1 residual: a container download can plant req/<hex>.json onto the bind-
 * mounted channel before containDownload unlinks it. fs.watch + the 200ms
 * poll would consume that file as a real sign request. The durable fix is
 * that _tryProcess returns immediately unless the name was openSync'd by
 * start() / nextReqId() / expect(id).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { SignChannelHost, POLL_INTERVAL_MS } = require('../src/sign-channel-host.js');
const { SignChannelClient } = require('../src/sign-channel-client.js');

const NET = 'verustest';
const FAKE_WIF = 'U' + '0'.repeat(51);

async function makeHost() {
  const channelDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'j41-sign-precreate-'));
  const calls = { handle: 0, executors: 0, signMessage: 0 };
  const host = new SignChannelHost({
    channelDir,
    jobId: 'job-precreate',
    wif: FAKE_WIF,
    network: NET,
    getJob: async () => ({ id: 'job-precreate', jobHash: 'a'.repeat(64) }),
    executors: {
      ping: async () => {
        calls.executors += 1;
        return { pong: true };
      },
    },
  });
  const origHandle = host._handle.bind(host);
  host._handle = async (req) => {
    calls.handle += 1;
    if (req && req.method === 'signMessage') calls.signMessage += 1;
    return origHandle(req);
  };
  return { host, channelDir, calls };
}

test('forged req filename written from outside is ignored (no pre-create)', async () => {
  const { host, channelDir, calls } = await makeHost();
  await host.start();
  try {
    const reqDir = path.join(channelDir, 'req');
    const respDir = path.join(channelDir, 'resp');

    await fsp.writeFile(path.join(reqDir, 'abcd1234.json'), JSON.stringify({
      id: 'abcd1234',
      method: 'signMessage',
      params: { message: 'pwned-from-outside' },
    }));
    await fsp.writeFile(path.join(reqDir, 'ffffeeee.json'), JSON.stringify({
      id: 'ffffeeee',
      method: 'executeOnChain',
      params: { kind: 'ping' },
    }));

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS * 3 + 200));

    assert.equal(calls.handle, 0, 'host must not _handle a file it did not create');
    assert.equal(calls.signMessage, 0, 'signMessage must not run for a planted req');
    assert.equal(calls.executors, 0, 'executors must not run for a planted req');
    assert.equal(fs.existsSync(path.join(respDir, 'abcd1234.json')), false);
    assert.equal(fs.existsSync(path.join(respDir, 'ffffeeee.json')), false);
  } finally {
    await host.destroy();
  }
});

test('write into a host-created placeholder is processed', async () => {
  const { host, channelDir, calls } = await makeHost();
  await host.start();
  const client = new SignChannelClient({ channelDir, timeoutMs: 3000 });
  try {
    const result = await client.executeOnChain('ping', { n: 1 });
    assert.deepEqual(result, { pong: true });
    assert.equal(calls.executors, 1);
    assert.ok(calls.handle >= 1);
  } finally {
    await host.destroy();
  }
});

test('replaced host slot (unlink + new inode, same name) is ignored', async () => {
  const { host, channelDir, calls } = await makeHost();
  await host.start();
  try {
    const id = host.expect('cafebabe');
    const reqPath = path.join(channelDir, 'req', `${id}.json`);
    await fsp.unlink(reqPath);
    await fsp.writeFile(reqPath, JSON.stringify({
      id,
      method: 'executeOnChain',
      params: { kind: 'ping' },
    }));
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS * 3 + 200));
    assert.equal(calls.handle, 0, 'replacement inode must not be processed');
    assert.equal(calls.executors, 0);
    assert.equal(fs.existsSync(path.join(channelDir, 'resp', `${id}.json`)), false);
  } finally {
    await host.destroy();
  }
});
