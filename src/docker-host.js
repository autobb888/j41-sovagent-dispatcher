'use strict';
const childProcess = require('child_process');

let _storageOptSupported = null;

function resetStorageOptCache() {
  _storageOptSupported = null;
}

function runExec(execSync, cmd, opts) {
  const run = execSync || childProcess.execSync;
  return run(cmd, opts);
}

/**
 * XFS project-quota mount options, per xfs(5): `pquota` and `prjquota` both
 * enable accounting AND enforcement; `pqnoenforce` accounts without enforcing,
 * so it must NOT count — Docker would accept the flag and then fail to cap.
 *
 * Word-anchored so `pqnoenforce` cannot match, and so `gquota`/`uquota`
 * (group/user quotas) are not mistaken for project quotas.
 */
const XFS_PROJECT_QUOTA_RE = /\b(?:pquota|prjquota)\b/;

/** Storage drivers that enforce `--storage-opt size` without a quota mount option. */
const SIZE_CAPABLE_DRIVERS = new Set(['btrfs', 'zfs']);

function supportsStorageOpt({ execSync } = {}) {
  const injected = typeof execSync === 'function';
  if (!injected && _storageOptSupported !== null) return _storageOptSupported;
  let ok = false;
  try {
    const driver = String(runExec(execSync, 'docker info --format "{{.Driver}}"', {
      encoding: 'utf8', timeout: 5000,
    })).trim();
    if (SIZE_CAPABLE_DRIVERS.has(driver)) {
      // btrfs and zfs cap disk natively. Previously these were refused outright
      // (`driver !== 'overlay2'`), which turned away hosts that CAN enforce a
      // quota — a false refusal, since the gate is fail-closed.
      ok = true;
    } else if (driver === 'overlay2') {
      // overlay2 enforces `size` ONLY over XFS with project quotas.
      //
      // This used to shell out to `mount | grep pquota` and rely on grep's exit
      // code. Two problems: the literal `pquota` does not match the `prjquota`
      // spelling the kernel actually reports, so a correctly configured XFS host
      // was refused; and the exit-code control flow could not be tested against
      // real mount output. Read `mount` and match here instead.
      const mounts = String(runExec(execSync, 'mount', {
        encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      }));
      ok = XFS_PROJECT_QUOTA_RE.test(mounts);
    } else {
      ok = false;
    }
  } catch {
    ok = false;
  }
  if (!injected) _storageOptSupported = ok;
  return ok;
}

function assertDockerReachable({ execSync } = {}) {
  try {
    runExec(execSync, 'docker info', { stdio: 'ignore', timeout: 8000 });
  } catch (err) {
    throw new Error(
      `HOME_GPU_NO_DOCKER: docker is not reachable on this machine (home-gpu needs docker.sock on the GPU host): ${(err && err.message) || err}`,
    );
  }
}

function assertNvidiaRuntime({ execSync } = {}) {
  let info;
  try {
    info = String(runExec(execSync, 'docker info --format "{{json .Runtimes}}"', {
      encoding: 'utf8', timeout: 8000,
    }));
  } catch (err) {
    throw new Error(
      `HOME_GPU_NO_NVIDIA: nvidia-container-toolkit is not available to docker: ${(err && err.message) || err}`,
    );
  }
  if (!/nvidia/i.test(info)) {
    throw new Error(
      'HOME_GPU_NO_NVIDIA: docker has no nvidia runtime (install nvidia-container-toolkit). Nothing was accepted and no buyer can pay into this fleet.',
    );
  }
}

function dockerImageExists(image, { execSync } = {}) {
  try {
    runExec(execSync, `docker image inspect ${image}`, { stdio: 'ignore', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

function assertHomeGpuHostReady(pcfg, deps = {}) {
  const execSync = deps.execSync;
  // Injected supportsStorageOpt is authoritative — evaluate before shelling out so
  // hermetic rental-setup tests can refuse disk without a live docker.sock.
  if (typeof deps.supportsStorageOpt === 'function' && !deps.supportsStorageOpt()) {
    throw new Error(
      'HOME_GPU_NO_DISK_QUOTA: host docker cannot cap disk_gb. Need one of: overlay2 over XFS mounted -o prjquota (or pquota), or the btrfs/zfs storage driver. Nothing was accepted and no buyer can pay into this fleet.',
    );
  }
  assertDockerReachable({ execSync });
  assertNvidiaRuntime({ execSync });
  if (typeof deps.supportsStorageOpt !== 'function' && !supportsStorageOpt({ execSync })) {
    throw new Error(
      'HOME_GPU_NO_DISK_QUOTA: host docker cannot cap disk_gb. Need one of: overlay2 over XFS mounted -o prjquota (or pquota), or the btrfs/zfs storage driver. Nothing was accepted and no buyer can pay into this fleet.',
    );
  }
  const { jailImageRef } = require('./providers/home-gpu');
  const image = jailImageRef(pcfg || {});
  const exists = typeof deps.imageExists === 'function'
    ? deps.imageExists(image)
    : dockerImageExists(image, { execSync });
  if (!exists) {
    throw new Error(
      `HOME_GPU_NO_JAIL_IMAGE: ${image} is not built. Run: j41-dispatcher build-image. Nothing was accepted and no buyer can pay into this fleet.`,
    );
  }
  return { image };
}

module.exports = {
  supportsStorageOpt,
  XFS_PROJECT_QUOTA_RE,
  SIZE_CAPABLE_DRIVERS,
  resetStorageOptCache,
  assertDockerReachable,
  assertNvidiaRuntime,
  dockerImageExists,
  assertHomeGpuHostReady,
};
