'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  supportsStorageOpt, resetStorageOptCache,
  assertDockerReachable, assertNvidiaRuntime,
  dockerImageExists, assertHomeGpuHostReady,
} = require('../src/docker-host');

function execFor({ driver, pquota, dockerInfo, runtimes, inspectOk }) {
  return (cmd) => {
    const c = String(cmd);
    if (c.includes('docker image inspect')) {
      if (inspectOk) return '';
      const err = new Error('no such image');
      throw err;
    }
    if (c.includes('json .Runtimes')) {
      if (runtimes === 'throw') throw new Error('docker missing');
      return runtimes;
    }
    if (c.includes('.Driver')) {
      if (driver === 'throw') throw new Error('docker missing');
      return driver;
    }
    if (c.includes('mount') && c.includes('pquota')) {
      if (!pquota) throw new Error('no pquota');
      return '/dev/sda on / type xfs (pquota)';
    }
    if (c.includes('docker info')) {
      if (dockerInfo === 'throw') throw new Error('Cannot connect to the Docker daemon');
      return 'ok';
    }
    throw new Error('unexpected cmd: ' + c);
  };
}

test('supportsStorageOpt is true only for overlay2 + pquota', () => {
  resetStorageOptCache();
  assert.equal(supportsStorageOpt({ execSync: execFor({ driver: 'overlay2', pquota: true }) }), true);
  resetStorageOptCache();
  assert.equal(supportsStorageOpt({ execSync: execFor({ driver: 'overlay2', pquota: false }) }), false);
  resetStorageOptCache();
  assert.equal(supportsStorageOpt({ execSync: execFor({ driver: 'vfs', pquota: true }) }), false);
});

test('assertDockerReachable throws HOME_GPU_NO_DOCKER when docker info fails', () => {
  assert.throws(
    () => assertDockerReachable({ execSync: execFor({ dockerInfo: 'throw' }) }),
    /HOME_GPU_NO_DOCKER/,
  );
  assert.doesNotThrow(() => assertDockerReachable({ execSync: execFor({ dockerInfo: 'ok' }) }));
});

test('assertNvidiaRuntime throws HOME_GPU_NO_NVIDIA unless Runtimes lists nvidia', () => {
  assert.throws(
    () => assertNvidiaRuntime({ execSync: execFor({ runtimes: '{}' }) }),
    /HOME_GPU_NO_NVIDIA/,
  );
  assert.doesNotThrow(() => assertNvidiaRuntime({ execSync: execFor({ runtimes: '{"nvidia":{}}' }) }));
});

test('assertHomeGpuHostReady refuses StorageOpt-incapable hosts and does not drop the cap', () => {
  const pcfg = { jail_image: 'j41/gpu-jail:latest' };
  const base = {
    execSync: execFor({
      dockerInfo: 'ok', runtimes: '{"nvidia":{}}',
      driver: 'overlay2', pquota: false, inspectOk: true,
    }),
    imageExists: () => true,
  };
  assert.throws(() => assertHomeGpuHostReady(pcfg, base), /HOME_GPU_NO_DISK_QUOTA/);
  assert.throws(() => assertHomeGpuHostReady(pcfg, base), /no buyer can pay into this fleet/);
});

test('assertHomeGpuHostReady refuses missing jail image', () => {
  const pcfg = { jail_image: 'j41/gpu-jail:custom' };
  assert.throws(
    () => assertHomeGpuHostReady(pcfg, {
      execSync: execFor({
        dockerInfo: 'ok', runtimes: '{"nvidia":{}}',
        driver: 'overlay2', pquota: true, inspectOk: false,
      }),
      imageExists: () => false,
    }),
    /HOME_GPU_NO_JAIL_IMAGE/,
  );
});

test('assertHomeGpuHostReady passes when docker, nvidia, StorageOpt, and image are present', () => {
  assert.doesNotThrow(() => assertHomeGpuHostReady({ jail_image: 'j41/gpu-jail:latest' }, {
    execSync: execFor({
      dockerInfo: 'ok', runtimes: '{"nvidia":{}}',
      driver: 'overlay2', pquota: true, inspectOk: true,
    }),
    imageExists: () => true,
  }));
});
