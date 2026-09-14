'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  COMPUTE_OUTBOUND_SSH_V1,
  KEEP_ALIVE_MS,
  hasOutboundSshV1,
  buildAttachMessage,
  parseAttachBody,
  challengeAndAttach,
  attachAndDial,
  keepOutboundUntilBuyer,
} = require('../src/compute-edge');

test('hasOutboundSshV1 is only the live token', () => {
  assert.equal(hasOutboundSshV1({ features: [COMPUTE_OUTBOUND_SSH_V1] }), true);
  assert.equal(hasOutboundSshV1({ features: ['rental.public-host-v1'] }), false);
  assert.equal(hasOutboundSshV1({}), false);
  assert.equal(hasOutboundSshV1(null), false);
});

test('buildAttachMessage matches backend A–C', () => {
  assert.equal(buildAttachMessage('job-1', 1700000000), 'J41-COMPUTE-ATTACH|Job:job-1|Ts:1700000000');
});

test('parseAttachBody requires public host and job-scoped port; same-socket dial', () => {
  const a = parseAttachBody({ host: 'gpu.junction41.io', port: 40123, dial: 'tcp://gpu.junction41.io:40123' });
  assert.equal(a.host, 'gpu.junction41.io');
  assert.equal(a.port, 40123);
  assert.equal(a.dialHost, 'gpu.junction41.io');
  assert.equal(a.dialPort, 40123);
  assert.throws(() => parseAttachBody({ host: '192.168.1.69', port: 40123 }), /RENTAL_LAN_HOST/);
  assert.throws(() => parseAttachBody({ host: 'gpu.junction41.io' }), /COMPUTE_EDGE_BAD_ATTACH/);
});

test('challengeAndAttach signs the challenge and POSTs attach', async () => {
  const calls = [];
  const client = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (method === 'GET') return { message: 'J41-COMPUTE-ATTACH|Job:job-1|Ts:1700000000', timestamp: 1700000000 };
      return { host: 'gpu.junction41.io', port: 40123, dial: 'tcp://gpu.junction41.io:40123' };
    },
  };
  const signed = [];
  const out = await challengeAndAttach({
    client,
    jobId: 'job-1',
    signMessage: async (m) => { signed.push(m); return 'sig'; },
  });
  assert.deepEqual(signed, ['J41-COMPUTE-ATTACH|Job:job-1|Ts:1700000000']);
  assert.equal(calls[1].body.signature, 'sig');
  assert.equal(calls[1].body.timestamp, 1700000000);
  assert.equal(out.port, 40123);
});

test('challengeAndAttach maps 402 to COMPUTE_EDGE_UNPAID', async () => {
  const client = {
    async request() {
      const e = new Error('Payment required');
      e.statusCode = 402;
      throw e;
    },
  };
  await assert.rejects(
    () => challengeAndAttach({ client, jobId: 'job-1', signMessage: async () => 's' }),
    /COMPUTE_EDGE_UNPAID/,
  );
});

test('attachAndDial connects to dial immediately (seller first accept)', async () => {
  const order = [];
  const mkSock = (name) => {
    const sock = {
      name,
      pipe(other) { order.push(`pipe:${name}->${other.name}`); return other; },
      setKeepAlive(on, delay) { sock.keepAlive = { on, delay }; },
      setNoDelay() { sock.noDelay = true; },
      once(ev, fn) {
        if (ev === 'connect') queueMicrotask(fn);
        return sock;
      },
      destroy() { order.push(`destroy:${name}`); },
    };
    return sock;
  };
  const client = {
    async request(method) {
      order.push(method);
      if (method === 'GET') return { message: 'J41-COMPUTE-ATTACH|Job:job-1|Ts:1', timestamp: 1 };
      return { host: 'gpu.junction41.io', port: 40123, dial: 'tcp://gpu.junction41.io:40123' };
    },
  };
  const connected = [];
  await attachAndDial({
    client,
    jobId: 'job-1',
    signMessage: async () => 'sig',
    localPort: 2222,
    connect: (opts) => {
      connected.push(`${opts.host}:${opts.port}`);
      return mkSock(`${opts.host}:${opts.port}`);
    },
  });
  assert.deepEqual(connected[0], 'gpu.junction41.io:40123');
  assert.ok(connected.includes('127.0.0.1:2222'));
  assert.equal(order[0], 'GET');
  assert.equal(order[1], 'POST');
});

test('attachAndDial enables TCP keepalive on the outbound socket', async () => {
  const mkSock = (name) => {
    const sock = {
      name,
      pipe() { return sock; },
      setKeepAlive(on, delay) { sock.keepAlive = { on, delay }; },
      setNoDelay() { sock.noDelay = true; },
      once(ev, fn) {
        if (ev === 'connect') queueMicrotask(fn);
        return sock;
      },
      destroy() {},
    };
    return sock;
  };
  const client = {
    async request(method) {
      if (method === 'GET') return { message: 'J41-COMPUTE-ATTACH|Job:job-1|Ts:1', timestamp: 1 };
      return { host: 'sovcompute.junction41.io', port: 40002, dial: 'tcp://sovcompute.junction41.io:40002' };
    },
  };
  const edge = await attachAndDial({
    client,
    jobId: 'job-1',
    signMessage: async () => 'sig',
    localPort: 2222,
    connect: (opts) => mkSock(`${opts.host}:${opts.port}`),
  });
  assert.deepEqual(edge.remote.keepAlive, { on: true, delay: KEEP_ALIVE_MS });
  assert.equal(edge.remote.noDelay, true);
});

test('local sshd close does not destroy the edge TCP (denied login must not drop the public port)', async () => {
  const destroyed = [];
  const mkSock = (name) => {
    const handlers = {};
    const sock = {
      name,
      destroyed: false,
      pipeOpts: null,
      pipe(_other, opts) { sock.pipeOpts = opts || {}; return sock; },
      unpipe() {},
      once(ev, fn) {
        handlers[ev] = handlers[ev] || [];
        handlers[ev].push(fn);
        if (ev === 'connect') queueMicrotask(fn);
        return sock;
      },
      emit(ev) { for (const fn of handlers[ev] || []) fn(); },
      destroy() { sock.destroyed = true; destroyed.push(name); },
    };
    return sock;
  };
  const client = {
    async request(method) {
      if (method === 'GET') return { message: 'J41-COMPUTE-ATTACH|Job:job-1|Ts:1', timestamp: 1 };
      return { host: 'gpu.junction41.io', port: 40123, dial: 'tcp://gpu.junction41.io:40123' };
    },
  };
  const socks = [];
  const edge = await attachAndDial({
    client,
    jobId: 'job-1',
    signMessage: async () => 'sig',
    localPort: 2222,
    connect: (opts) => {
      const s = mkSock(`${opts.host}:${opts.port}`);
      socks.push(s);
      return s;
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  const local = socks.find((s) => s.name === '127.0.0.1:2222');
  assert.ok(local);
  local.emit('close');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(destroyed.includes('gpu.junction41.io:40123'), false);
  assert.equal(edge.remote.destroyed, false);
  assert.equal(edge.remote.pipeOpts && edge.remote.pipeOpts.end, false);
  assert.equal(local.pipeOpts && local.pipeOpts.end, false);
});

function mockEdgeSock(name) {
  const handlers = {};
  const sock = {
    name,
    destroyed: false,
    pipe() { return sock; },
    unpipe() {},
    setKeepAlive() {},
    setNoDelay() {},
    on(ev, fn) {
      (handlers[ev] = handlers[ev] || []).push(fn);
      return sock;
    },
    once(ev, fn) {
      (handlers[ev] = handlers[ev] || []).push(fn);
      if (ev === 'connect') queueMicrotask(fn);
      return sock;
    },
    emit(ev, ...a) { for (const fn of handlers[ev] || []) fn(...a); },
    destroy() { sock.destroyed = true; },
  };
  return sock;
}

test('keepOutboundUntilBuyer re-attaches a new port if outbound dies before first SSH', async () => {
  const first = mockEdgeSock('edge-1');
  const second = mockEdgeSock('edge-2');
  const session = { host: 'sovcompute.junction41.io', port: 40002, remote: first, stopHold() {} };
  const reseal = [];
  let attaches = 0;
  keepOutboundUntilBuyer(session, {
    maxReattach: 3,
    log() {},
    attach: async () => {
      attaches += 1;
      return { host: 'sovcompute.junction41.io', port: 40003, remote: second, stopHold() {} };
    },
    onReattached: async ({ host, port }) => { reseal.push({ host, port }); },
  });
  first.emit('close');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(attaches, 1);
  assert.deepEqual(reseal, [{ host: 'sovcompute.junction41.io', port: 40003 }]);
  assert.equal(session.port, 40003);
  assert.equal(session.remote, second);
});

test('keepOutboundUntilBuyer re-attaches even after a failed SSH (buyer bytes then close)', async () => {
  const first = mockEdgeSock('edge-1');
  const second = mockEdgeSock('edge-2');
  const session = { host: 'sovcompute.junction41.io', port: 40000, remote: first, stopHold() {} };
  const reseal = [];
  keepOutboundUntilBuyer(session, {
    log() {},
    attach: async () => ({ host: 'sovcompute.junction41.io', port: 40001, remote: second, stopHold() {} }),
    onReattached: async ({ port }) => { reseal.push(port); },
  });
  first.emit('data', Buffer.from('SSH-2.0'));
  first.emit('close');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(reseal, [40001]);
  assert.equal(session.port, 40001);
});
