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

function supportsStorageOpt({ execSync } = {}) {
  const injected = typeof execSync === 'function';
  if (!injected && _storageOptSupported !== null) return _storageOptSupported;
  let ok = false;
  try {
    const driver = String(runExec(execSync, 'docker info --format "{{.Driver}}"', {
      encoding: 'utf8', timeout: 5000,
    })).trim();
    if (driver !== 'overlay2') {
      ok = false;
    } else {
      runExec(execSync, 'mount | grep pquota', {
        encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      ok = true;
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
      'HOME_GPU_NO_DISK_QUOTA: host docker cannot cap disk_gb (need overlay2 size or xfs pquota). Nothing was accepted and no buyer can pay into this fleet.',
    );
  }
  assertDockerReachable({ execSync });
  assertNvidiaRuntime({ execSync });
  if (typeof deps.supportsStorageOpt !== 'function' && !supportsStorageOpt({ execSync })) {
    throw new Error(
      'HOME_GPU_NO_DISK_QUOTA: host docker cannot cap disk_gb (need overlay2 size or xfs pquota). Nothing was accepted and no buyer can pay into this fleet.',
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
  resetStorageOptCache,
  assertDockerReachable,
  assertNvidiaRuntime,
  dockerImageExists,
  assertHomeGpuHostReady,
};
