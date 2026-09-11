'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { EventEmitter } = require('events');
const {
  assertPublicSshHost,
  assertRentalHostPublic,
  probeSshHost,
  isLanSshHost,
  shouldRefuseLanGpuRental,
  completeRentalHonesty,
  formatBuyerCompleteOutput,
} = require('../src/ssh-host');

function restoreLanEnv(prev) {
  if (prev === undefined) delete process.env.J41_ALLOW_LAN_RENTAL;
  else process.env.J41_ALLOW_LAN_RENTAL = prev;
}

test('assertPublicSshHost throws RENTAL_LAN_HOST on 192.168.1.69', () => {
  assert.throws(() => assertPublicSshHost('192.168.1.69'), /RENTAL_LAN_HOST/);
});

test('assertPublicSshHost throws on 10.x RFC1918', () => {
  assert.throws(() => assertPublicSshHost('10.0.0.1'), /RENTAL_LAN_HOST/);
  assert.throws(() => assertPublicSshHost('10.255.255.255'), /RENTAL_LAN_HOST/);
});

test('assertPublicSshHost throws on 127.0.0.1', () => {
  assert.throws(() => assertPublicSshHost('127.0.0.1'), /RENTAL_LAN_HOST/);
});

test('assertPublicSshHost throws on .local hostnames', () => {
  assert.throws(() => assertPublicSshHost('gpu.local'), /RENTAL_LAN_HOST/);
  assert.throws(() => assertPublicSshHost('orchard.internal'), /RENTAL_LAN_HOST/);
  assert.throws(() => assertPublicSshHost('localhost'), /RENTAL_LAN_HOST/);
});

test('assertPublicSshHost allows a public hostname', () => {
  assert.equal(assertPublicSshHost('gpu.example.com'), 'gpu.example.com');
  assert.equal(assertPublicSshHost('1.1.1.1'), '1.1.1.1');
});

test('J41_ALLOW_LAN_RENTAL=1 allows RFC1918', () => {
  const prev = process.env.J41_ALLOW_LAN_RENTAL;
  process.env.J41_ALLOW_LAN_RENTAL = '1';
  try {
    assert.equal(assertPublicSshHost('192.168.1.69'), '192.168.1.69');
    assert.equal(assertPublicSshHost('10.1.2.3'), '10.1.2.3');
  } finally {
    restoreLanEnv(prev);
  }
});

test('assertRentalHostPublic loads ssh_hostname and throws RENTAL_LAN_HOST', () => {
  const cfg = {
    compute: {
      enabled: true,
      providers: {
        card0: { type: 'home-gpu', agent_id: 'gpu-1', ssh_hostname: '192.168.1.69' },
      },
    },
  };
  assert.throws(() => assertRentalHostPublic('gpu-1', cfg), /RENTAL_LAN_HOST/);
  assert.doesNotThrow(() => assertRentalHostPublic('gpu-1', {
    compute: { providers: { card0: { type: 'home-gpu', agent_id: 'gpu-1', ssh_hostname: 'gpu.example.com' } } },
  }));
});

test('assertRentalHostPublic skips vast providers with no static ssh_hostname', () => {
  assert.doesNotThrow(() => assertRentalHostPublic('gpu-1', {
    compute: { providers: { cloud: { type: 'vast', agent_id: 'gpu-1', api_key: 'k' } } },
  }));
});

test('probeSshHost is not passed credential fields', async () => {
  let seen;
  const fake = () => {
    const s = new EventEmitter();
    s.setTimeout = () => {};
    s.destroy = () => {};
    process.nextTick(() => s.emit('error', new Error('refused')));
    return s;
  };
  await probeSshHost(
    { host: 'gpu.example.com', port: 2222, user: 'renter', password: 's3cret', privateKey: 'KEY' },
    {
      connect: (opts) => {
        seen = opts;
        return fake();
      },
    },
  );
  assert.deepEqual(Object.keys(seen).sort(), ['host', 'port']);
  assert.equal(seen.host, 'gpu.example.com');
  assert.equal(seen.port, 2222);
  assert.equal(seen.password, undefined);
  assert.equal(seen.privateKey, undefined);
  assert.equal(seen.user, undefined);
});

test('complete leftover LAN does not print the success checkmark; JSON warning COMPLETE_LAN_ONLY', () => {
  const out = formatBuyerCompleteOutput({
    jobId: 'e70731db-leftover',
    status: 'completed',
    warning: 'COMPLETE_LAN_ONLY',
  });
  assert.equal(out.json.ok, true);
  assert.equal(out.json.warning, 'COMPLETE_LAN_ONLY');
  assert.doesNotMatch(out.human, /✅ Job .* completed/);
  assert.match(out.human, /RFC1918/);
  assert.doesNotMatch(out.human, /SSH ready/i);
});

test('complete public unreachable omits the success checkmark', () => {
  const out = formatBuyerCompleteOutput({
    jobId: 'job-1',
    status: 'completed',
    warning: 'COMPLETE_HOST_UNREACHABLE',
  });
  assert.equal(out.json.ok, true);
  assert.equal(out.json.warning, 'COMPLETE_HOST_UNREACHABLE');
  assert.doesNotMatch(out.human, /✅ Job .* completed/);
});

test('complete success still prints the checkmark when there is no warning', () => {
  const out = formatBuyerCompleteOutput({ jobId: 'job-1', status: 'completed' });
  assert.match(out.human, /✅ Job job-1 completed/);
  assert.equal(out.json.warning, undefined);
});

test('completeRentalHonesty classifies RFC1918 without probing', async () => {
  let probed = 0;
  const r = await completeRentalHonesty(
    { ssh: { host: '192.168.1.69', port: 2222, password: 's3cret', privateKey: 'KEY' } },
    { probe: () => { probed++; return true; } },
  );
  assert.equal(r.warning, 'COMPLETE_LAN_ONLY');
  assert.equal(probed, 0);
  assert.doesNotMatch(r.message, /✅ Job .* completed/);
});

test('completeRentalHonesty unwraps .data and probes only host+port', async () => {
  let seen;
  const r = await completeRentalHonesty(
    { data: { ssh: { host: 'gpu.example.com', port: 2222, password: 's3cret', privateKey: 'KEY' } } },
    {
      probe: (opts) => {
        seen = opts;
        return false;
      },
    },
  );
  assert.equal(r.warning, 'COMPLETE_HOST_UNREACHABLE');
  assert.deepEqual(Object.keys(seen).sort(), ['host', 'port']);
  assert.equal(seen.password, undefined);
  assert.equal(seen.privateKey, undefined);
});

test('shouldRefuseLanGpuRental is true for gpu-rental on LAN and does not throw', () => {
  const cfg = {
    compute: { providers: { card0: { type: 'home-gpu', agent_id: 'gpu-1', ssh_hostname: '192.168.1.69' } } },
  };
  assert.equal(shouldRefuseLanGpuRental('gpu-1', { id: 'job-1', serviceType: 'gpu-rental' }, [], cfg), true);
  assert.equal(shouldRefuseLanGpuRental('gpu-1', { id: 'job-1', serviceType: 'agent' }, [], cfg), false);
});

test('isLanSshHost ignores J41_ALLOW_LAN_RENTAL (buyer complete stays honest)', () => {
  const prev = process.env.J41_ALLOW_LAN_RENTAL;
  process.env.J41_ALLOW_LAN_RENTAL = '1';
  try {
    assert.equal(isLanSshHost('192.168.1.69'), true);
    assert.equal(isLanSshHost('gpu.example.com'), false);
  } finally {
    restoreLanEnv(prev);
  }
});

test('probeSshHost connects to a live listener', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const prev = process.env.J41_ALLOW_LAN_RENTAL;
    process.env.J41_ALLOW_LAN_RENTAL = '1';
    try {
      assert.equal(await probeSshHost({ host: '127.0.0.1', port }, { timeoutMs: 500 }), true);
    } finally {
      restoreLanEnv(prev);
    }
  } finally {
    server.close();
  }
});
