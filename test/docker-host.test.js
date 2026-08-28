'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  supportsStorageOpt, resetStorageOptCache,
  assertDockerReachable, assertNvidiaRuntime,
  dockerImageExists, assertHomeGpuHostReady,
} = require('../src/docker-host');

// REAL `mount` output, copied from live systems — not hand-written to match the
// implementation. The previous harness stubbed the mount check by matching on the
// command string and returned its own '(pquota)' literal, so no test could ever
// observe that the kernel reports `prjquota` and the grep missed it. Feed real
// output; that is the whole point.
const MOUNTS = {
  // ext4 root, no project quota anywhere — the Ubuntu/Debian default.
  ext4: [
    'sysfs on /sys type sysfs (rw,nosuid,nodev,noexec,relatime)',
    '/dev/sda3 on / type ext4 (rw,relatime,errors=remount-ro)',
    'tmpfs on /run type tmpfs (rw,nosuid,nodev,noexec,relatime,size=2097152k)',
  ].join('\n'),
  // XFS mounted -o prjquota. This is the spelling the kernel emits for
  // enforcing project quota, and the exact case the old `grep pquota` missed.
  xfsPrjquota: [
    '/dev/sda3 on / type ext4 (rw,relatime)',
    '/dev/nvme0n1p2 on /var/lib/docker type xfs (rw,relatime,attr2,inode64,logbufs=8,prjquota)',
  ].join('\n'),
  // The other accepted spelling.
  xfsPquota: '/dev/nvme0n1p2 on /var/lib/docker type xfs (rw,relatime,attr2,inode64,pquota)',
  // Accounting WITHOUT enforcement — Docker accepts the flag then fails to cap,
  // so this must NOT be treated as supported.
  xfsNoEnforce: '/dev/nvme0n1p2 on /var/lib/docker type xfs (rw,relatime,attr2,inode64,pqnoenforce)',
  // User/group quotas are not project quotas.
  xfsUserGroupQuota: '/dev/nvme0n1p2 on /var/lib/docker type xfs (rw,relatime,uquota,gquota)',
};

function execFor({ driver, mounts, dockerInfo, runtimes, inspectOk }) {
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
    if (c.includes('docker info')) {
      if (dockerInfo === 'throw') throw new Error('Cannot connect to the Docker daemon');
      return 'ok';
    }
    // Bare `mount` — matched AFTER the docker branches so it cannot swallow them.
    if (c.trim() === 'mount') {
      if (mounts === 'throw') throw new Error('mount unavailable');
      return mounts === undefined ? MOUNTS.ext4 : mounts;
    }
    throw new Error('unexpected cmd: ' + c);
  };
}

test('supportsStorageOpt: overlay2 needs XFS project quota, either spelling', () => {
  resetStorageOptCache();
  assert.equal(
    supportsStorageOpt({ execSync: execFor({ driver: 'overlay2', mounts: MOUNTS.xfsPquota }) }),
    true, 'pquota spelling must be accepted');

  resetStorageOptCache();
  assert.equal(
    supportsStorageOpt({ execSync: execFor({ driver: 'overlay2', mounts: MOUNTS.xfsPrjquota }) }),
    true, 'prjquota is what the kernel actually reports — the bug this test exists for');

  resetStorageOptCache();
  assert.equal(
    supportsStorageOpt({ execSync: execFor({ driver: 'overlay2', mounts: MOUNTS.ext4 }) }),
    false, 'ext4 host cannot cap disk with overlay2');
});

test('supportsStorageOpt: quota lookalikes must NOT count as project quota', () => {
  resetStorageOptCache();
  assert.equal(
    supportsStorageOpt({ execSync: execFor({ driver: 'overlay2', mounts: MOUNTS.xfsNoEnforce }) }),
    false, 'pqnoenforce accounts but does not enforce — Docker would fail to cap');

  resetStorageOptCache();
  assert.equal(
    supportsStorageOpt({ execSync: execFor({ driver: 'overlay2', mounts: MOUNTS.xfsUserGroupQuota }) }),
    false, 'uquota/gquota are user/group quotas, not project quotas');
});

test('supportsStorageOpt: btrfs and zfs cap natively; unknown drivers do not', () => {
  for (const driver of ['btrfs', 'zfs']) {
    resetStorageOptCache();
    assert.equal(
      supportsStorageOpt({ execSync: execFor({ driver, mounts: MOUNTS.ext4 }) }),
      true, `${driver} enforces --storage-opt size without a quota mount option`);
  }
  for (const driver of ['vfs', 'aufs', 'overlay']) {
    resetStorageOptCache();
    assert.equal(
      supportsStorageOpt({ execSync: execFor({ driver, mounts: MOUNTS.xfsPrjquota }) }),
      false, `${driver} cannot cap disk even with project quota mounted`);
  }
});

test('supportsStorageOpt fails closed when docker or mount is unavailable', () => {
  resetStorageOptCache();
  assert.equal(supportsStorageOpt({ execSync: execFor({ driver: 'throw' }) }), false);
  resetStorageOptCache();
  assert.equal(
    supportsStorageOpt({ execSync: execFor({ driver: 'overlay2', mounts: 'throw' }) }),
    false, 'unreadable mounts must refuse, never assume a cap exists');
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
      driver: 'overlay2', mounts: MOUNTS.ext4, inspectOk: true,
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
        driver: 'overlay2', mounts: MOUNTS.xfsPrjquota, inspectOk: false,
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
      driver: 'overlay2', mounts: MOUNTS.xfsPrjquota, inspectOk: true,
    }),
    imageExists: () => true,
  }));
});
