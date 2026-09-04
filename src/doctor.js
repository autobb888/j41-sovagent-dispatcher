'use strict';
/**
 * Mass-use doctor — single classifier for CLI `doctor`, `--json`, and the TUI.
 * Read-only. Never prints secrets. Never recommends `config --runtime local`.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseListingKind, kindFromIdentityName } = require('./listing-kind');
const { DEFAULT_FLOOR_WRITES } = require('./fee-tank');

const PKG = require('../package.json');
const CLOCK_SKEW_MS = 30 * 1000;
const SCOPED_INSTALL = 'npm install -g @junction41/dispatcher';

const CHECK_IDS = Object.freeze([
  'os', 'node', 'package',
  'docker.cli', 'docker.daemon', 'docker.sock', 'docker.group',
  'image.job-agent', 'image.gpu-jail',
  'clock', 'runtime', 'llm', 'identity', 'fee-tank',
  'gpu.nvidia', 'gpu.storage',
]);

function mkCheck(id, name, status, detail, nextCommand = null, copyPasteBlock = null) {
  return { id, name, status, detail: String(detail || '').slice(0, 400), nextCommand, copyPasteBlock };
}

function classifyDockerError(err) {
  if (!err) return 'unknown';
  const code = err.code || '';
  const msg = String(err.message || err);
  if (code === 'EACCES' || code === 'EPERM' || /permission denied|EACCES/i.test(msg)) return 'eacces';
  if (code === 'ENOENT' || /ENOENT|no such file|cannot connect|Is the docker daemon running/i.test(msg)) {
    if (/permission denied|EACCES/i.test(msg)) return 'eacces';
    if (/ENOENT|no such file/i.test(msg)) return 'enoent';
    return 'daemon-down';
  }
  return 'unknown';
}

function nodeMajor(version) {
  const m = String(version || '').match(/^v?(\d+)/);
  return m ? Number(m[1]) : 0;
}

function detectOs(deps) {
  const platform = deps.platform || process.platform;
  const arch = deps.arch || os.arch();
  const env = deps.env || process.env;
  const procVersion = deps.procVersion != null
    ? deps.procVersion
    : (platform === 'linux' && typeof deps.fs.readFileSync === 'function'
      ? (() => { try { return deps.fs.readFileSync('/proc/version', 'utf8'); } catch { return ''; } })()
      : '');
  const wsl = !!(env.WSL_DISTRO_NAME) || /microsoft/i.test(String(procVersion || ''));
  let macOSMajor = null;
  if (platform === 'darwin') {
    const maj = parseInt(String(deps.release || os.release()).split('.')[0], 10);
    macOSMajor = Number.isFinite(maj) ? maj : null;
  }
  let distro = 'unknown';
  let osVersion = deps.osReleaseVersion || null;
  if (platform === 'linux') {
    distro = deps.osReleaseId || 'linux';
    if (wsl && distro === 'linux') distro = 'ubuntu';
  } else if (platform === 'darwin') {
    distro = 'macos';
    osVersion = macOSMajor != null ? String(macOSMajor) : osVersion;
  } else if (platform === 'win32') {
    distro = wsl ? 'wsl2' : 'windows';
  } else {
    distro = String(platform);
  }

  let dockerDesktopWSL2 = deps.dockerDesktopWSL2;
  if (dockerDesktopWSL2 === undefined) dockerDesktopWSL2 = platform === 'win32' ? false : null;

  let supported = false;
  if (platform === 'linux') supported = true;
  else if (platform === 'darwin') supported = macOSMajor != null && macOSMajor >= 23;
  else if (platform === 'win32') supported = dockerDesktopWSL2 === true;

  return {
    platform,
    arch,
    distro,
    osVersion,
    supported,
    macOSMajor,
    wsl: platform === 'linux' ? wsl : false,
    dockerDesktopWSL2: platform === 'win32' ? !!dockerDesktopWSL2 : (platform === 'darwin' ? dockerDesktopWSL2 : null),
  };
}

function classifyIdentities(agentsDir, deps = {}) {
  const fss = deps.fs || fs;
  const rows = [];
  let names = [];
  try { names = fss.readdirSync(agentsDir); } catch { return rows; }
  for (const id of names) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || id.includes('..')) continue;
    const keysPath = path.join(agentsDir, id, 'keys.json');
    if (!fss.existsSync(keysPath)) continue;
    let keys = {};
    try {
      keys = JSON.parse(fss.readFileSync(keysPath, 'utf8'));
    } catch {
      rows.push({
        id, kind: 'agent', stage: 'local-only', identity: null, iAddress: null,
        local: true, onChain: false, finalized: false, platformReady: false, feeTank: null,
      });
      continue;
    }
    const identity = keys.identity || null;
    const iAddress = keys.iAddress || null;
    const kind = parseListingKind(keys.kind) || kindFromIdentityName(identity) || 'agent';
    const timeout = keys.registrationStatus === 'timeout';
    const onChain = !!(identity && iAddress) && !timeout;
    let finalized = false;
    try {
      const st = JSON.parse(fss.readFileSync(path.join(agentsDir, id, 'finalize-state.json'), 'utf8'));
      finalized = !!(st && st.stage === 'ready');
    } catch { /* absent or corrupt → not finalized */ }
    let stage = 'local-only';
    if (identity && !iAddress) stage = 'pending';
    else if (onChain && finalized) stage = 'finalized';
    else if (onChain) stage = 'on-chain';
    else if (identity) stage = 'pending';
    rows.push({
      id,
      kind,
      stage,
      identity,
      iAddress,
      local: true,
      onChain,
      finalized,
      platformReady: finalized,
      feeTank: onChain ? null : 'unregistered',
    });
  }
  return rows;
}

function formatIdentitySummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return '0 local';
  const ready = list.filter((r) => r.platformReady || r.stage === 'platform-ready').length;
  const finalized = list.filter((r) => r.finalized).length;
  const onChainNotFin = list.filter((r) => r.onChain && !r.finalized).length;
  const localOnly = list.filter((r) => r.stage === 'local-only' || r.stage === 'pending').length;
  const parts = [];
  if (ready) parts.push(`${ready} ready`);
  else if (finalized) parts.push(`${finalized} finalized`);
  if (onChainNotFin) parts.push(`${onChainNotFin} on-chain (not finalized)`);
  if (localOnly) parts.push(`${localOnly} local-only`);
  if (!parts.length) parts.push(`${list.length} local`);
  return parts.join(', ');
}

function redact(s) {
  return String(s || '')
    .replace(/gsk_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/sk-[A-Za-z0-9-]+/g, '[redacted]')
    .replace(/\bnpm_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/\bUw[A-Za-z0-9]{20,}/g, '[redacted]');
}

function pickNext(checks) {
  const fails = checks.filter((c) => c.status === 'fail');
  const warns = checks.filter((c) => c.status === 'warn');
  const hit = fails[0] || warns.find((c) => ['llm', 'identity', 'image.job-agent', 'fee-tank'].includes(c.id)) || warns[0];
  if (!hit) return { nextCommand: 'j41-dispatcher start', copyPasteBlock: null };
  return { nextCommand: hit.nextCommand, copyPasteBlock: hit.copyPasteBlock };
}

function dockerCandidates(deps, osInfo) {
  const home = deps.homedir || os.homedir();
  if (osInfo.platform === 'darwin') {
    return [
      path.join(home, '.docker', 'run', 'docker.sock'),
      '/var/run/docker.sock',
      path.join(home, '.colima', 'default', 'docker.sock'),
    ];
  }
  if (osInfo.platform === 'win32') return ['//./pipe/docker_engine'];
  return ['/var/run/docker.sock', '/run/docker.sock'];
}

function sockExists(p, deps) {
  if (typeof deps.dockerSockExists === 'function') return deps.dockerSockExists(p);
  if (p.startsWith('//./pipe/')) return true;
  try { return deps.fs.existsSync(p); } catch { return false; }
}

function runExec(deps, cmd, extraEnv) {
  const env = { ...process.env, ...(deps.env || {}), ...(extraEnv || {}) };
  return deps.execSync(cmd, { encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'], env });
}

function ntpBlock(osInfo) {
  if (osInfo.platform === 'darwin') {
    return 'System Settings → General → Date & Time → Set time and date automatically';
  }
  if (osInfo.platform === 'win32') {
    return 'Settings → Time & language → Date & time → Set time automatically';
  }
  const lines = ['sudo timedatectl set-ntp true', 'timedatectl  # wait until "System clock synchronized: yes"'];
  if (osInfo.wsl) lines.push('sudo hwclock -s   # if skew returns: from Windows run  wsl --shutdown');
  return lines.join('\n');
}

async function probeClock(deps, apiUrl) {
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  let header = deps.fetchDateHeader;
  if (header == null && deps.fetchOk === false) {
    return { status: 'warn', detail: 'API unreachable — could not compare clocks', skewMs: null };
  }
  if (header == null) {
    try {
      const fetchFn = deps.fetch || globalThis.fetch;
      if (typeof fetchFn !== 'function') {
        return { status: 'warn', detail: 'no fetch — skipped clock check', skewMs: null };
      }
      const res = await fetchFn(apiUrl, { method: 'HEAD' });
      header = res.headers && res.headers.get && res.headers.get('date');
    } catch (e) {
      return { status: 'warn', detail: `API unreachable (${redact(e.message)})`, skewMs: null };
    }
  }
  const remote = Date.parse(header);
  if (!Number.isFinite(remote)) {
    return { status: 'warn', detail: 'API Date header missing', skewMs: null };
  }
  const skewMs = remote - now;
  const abs = Math.abs(skewMs);
  if (abs > CLOCK_SKEW_MS) {
    return {
      status: 'fail',
      detail: `clock skew ${(abs / 1000).toFixed(0)}s vs API (limit 30s)`,
      skewMs,
    };
  }
  return { status: 'pass', detail: `ok  (skew ${(abs / 1000).toFixed(1)}s)`, skewMs };
}

function applyFeeTank(identities, rows) {
  const byId = new Map((rows || []).map((r) => [r.agentId, r]));
  for (const idn of identities) {
    const r = byId.get(idn.id);
    if (!idn.onChain) {
      idn.feeTank = 'unregistered';
      continue;
    }
    if (!r) continue;
    if (r.status) idn.feeTank = r.status;
    else if (r.writes === 0) idn.feeTank = 'empty-unfunded';
    else if (r.writes < DEFAULT_FLOOR_WRITES) idn.feeTank = 'low';
    else idn.feeTank = 'ok';
  }
}

async function runDoctor(opts = {}) {
  const deps = {
    fs: opts.fs || fs,
    execSync: opts.execSync || require('child_process').execSync,
    homedir: opts.homedir || os.homedir(),
    env: opts.env || process.env,
    platform: opts.platform || process.platform,
    arch: opts.arch || os.arch(),
    release: opts.release,
    nodeVersion: opts.nodeVersion || process.version,
    packageVersion: opts.packageVersion || PKG.version,
    pathBinaryVersion: opts.pathBinaryVersion != null ? opts.pathBinaryVersion : opts.packageVersion || PKG.version,
    now: opts.now || (() => Date.now()),
    fetch: opts.fetch,
    fetchDateHeader: opts.fetchDateHeader,
    fetchOk: opts.fetchOk,
    osReleaseId: opts.osReleaseId,
    osReleaseVersion: opts.osReleaseVersion,
    procVersion: opts.procVersion,
    dockerDesktopWSL2: opts.dockerDesktopWSL2,
    dockerSockExists: opts.dockerSockExists,
    llm: opts.llm,
    computeEnabled: !!opts.computeEnabled,
    nvidiaRuntime: !!opts.nvidiaRuntime,
    dockerDriver: opts.dockerDriver,
    supportsStorageOpt: opts.supportsStorageOpt,
    feeTankRows: opts.feeTankRows,
  };

  const osInfo = detectOs(deps);
  const dispatcherDir = path.join(deps.homedir, '.j41', 'dispatcher');
  const agentsDir = path.join(dispatcherDir, 'agents');
  const identities = classifyIdentities(agentsDir, deps);
  if (deps.feeTankRows) applyFeeTank(identities, deps.feeTankRows);

  const checks = [];

  // os
  if (!['linux', 'darwin', 'win32'].includes(osInfo.platform)) {
    checks.push(mkCheck('os', 'OS', 'fail', `unsupported platform ${osInfo.platform}`, null,
      'Junction41 dispatcher supports Linux, macOS 14+, and Windows 10/11 with Docker Desktop WSL2.'));
  } else if (osInfo.platform === 'darwin' && !osInfo.supported) {
    checks.push(mkCheck('os', 'OS', 'fail',
      `macOS ${osInfo.macOSMajor != null ? osInfo.macOSMajor : '?'} (need 14 / Darwin 23+)`,
      null,
      'macOS 14+ (Sonoma) and Docker Desktop are required. Current Docker Desktop does not support this macOS.'));
  } else if (osInfo.platform === 'win32' && !osInfo.supported) {
    checks.push(mkCheck('os', 'OS', 'fail',
      'Windows without Docker Desktop WSL2',
      null,
      'Install Docker Desktop and enable the WSL2 backend (Linux containers). Hyper-V-only is not a first-class path.\nThen open Ubuntu in WSL and run the Linux installer, or install Node 20+ and @junction41/dispatcher inside WSL.'));
  } else {
    const label = osInfo.platform === 'darwin'
      ? `darwin ${osInfo.macOSMajor}+ (${osInfo.arch})`
      : osInfo.platform === 'win32'
        ? `windows WSL2 (${osInfo.arch})`
        : `${osInfo.distro || 'linux'} ${osInfo.osVersion || ''} (${osInfo.arch})`.trim();
    checks.push(mkCheck('os', 'OS', 'pass', `${label}  supported`));
  }

  // node
  const major = nodeMajor(deps.nodeVersion);
  if (major < 20) {
    checks.push(mkCheck('node', 'Node.js', 'fail',
      `${deps.nodeVersion} — need Node 20+ (22 recommended). Distro nodejs on Ubuntu 24.04 / Debian 12 is 18 and will fail.`,
      'nvm install 22',
      '# Do not: apt install nodejs\nnvm install 22\n# or official tarball → ~/.local/node  https://nodejs.org/dist/'));
  } else {
    checks.push(mkCheck('node', 'Node.js', 'pass', `${deps.nodeVersion}`));
  }

  // package
  const pathVer = String(deps.pathBinaryVersion || '').replace(/^v/, '');
  if (pathVer === '2.0.0') {
    checks.push(mkCheck('package', 'Package', 'fail',
      'j41-dispatcher 2.0.0 on PATH is frozen (2026-04-08). Current product is @junction41/dispatcher.',
      SCOPED_INSTALL,
      `npm uninstall -g j41-dispatcher\n${SCOPED_INSTALL}`));
  } else {
    checks.push(mkCheck('package', 'Package', 'pass',
      `@junction41/dispatcher ${deps.packageVersion}`));
  }

  // docker
  let dockerClass = null;
  let dockerHost = deps.env && deps.env.DOCKER_HOST;
  let cliOk = false;
  try {
    const ver = String(runExec(deps, 'docker --version')).trim();
    cliOk = true;
    checks.push(mkCheck('docker.cli', 'Docker CLI', 'pass', ver.split('\n')[0]));
  } catch {
    const block = osInfo.platform === 'darwin'
      ? 'Install Docker Desktop: https://docs.docker.com/desktop/setup/install/mac-install/\nOpen Docker.app and wait until docker info works.'
      : osInfo.platform === 'win32'
        ? 'Install Docker Desktop with the WSL2 backend. Start it, then retry.'
        : 'sudo apt install docker.io   # or the distro block from docs/plans/2026-09-04-distro-operability.md\nsudo usermod -aG docker "$USER"\n# then open a new terminal';
    checks.push(mkCheck('docker.cli', 'Docker CLI', 'fail', 'not found',
      osInfo.platform === 'linux' ? 'sudo apt install docker.io' : null, block));
  }

  if (cliOk) {
    const tryInfo = (extraEnv) => {
      try {
        runExec(deps, 'docker info', extraEnv);
        return { ok: true };
      } catch (e) {
        return { ok: false, err: e, class: classifyDockerError(e) };
      }
    };
    let info = tryInfo(dockerHost ? { DOCKER_HOST: dockerHost } : undefined);
    if (!info.ok && info.class === 'enoent' && osInfo.platform === 'darwin') {
      for (const sock of dockerCandidates(deps, osInfo)) {
        if (!sockExists(sock, deps)) continue;
        const unix = sock.startsWith('unix://') ? sock : `unix://${sock}`;
        process.env.DOCKER_HOST = unix;
        dockerHost = unix;
        info = tryInfo({ DOCKER_HOST: unix });
        if (info.ok) break;
      }
    }

    if (info.ok) {
      checks.push(mkCheck('docker.daemon', 'Docker daemon', 'pass',
        dockerHost ? `running  (${dockerHost})` : 'running'));
      checks.push(mkCheck('docker.sock', 'Docker sock', 'pass',
        dockerHost || (osInfo.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock')));
      if (osInfo.platform === 'linux') {
        checks.push(mkCheck('docker.group', 'Docker group', 'pass', 'can talk to the daemon'));
      } else {
        checks.push(mkCheck('docker.group', 'Docker group', 'skip', `n/a (${osInfo.platform})`));
      }
      dockerClass = 'ok';
    } else if (info.class === 'eacces') {
      dockerClass = 'eacces';
      checks.push(mkCheck('docker.daemon', 'Docker daemon', 'pass', 'installed; this session cannot use the socket'));
      checks.push(mkCheck('docker.sock', 'Docker sock', 'pass', '/var/run/docker.sock exists (permission denied)'));
      checks.push(mkCheck('docker.group', 'Docker group', 'fail',
        'this login is not in group docker (EACCES). A new terminal or `newgrp docker` is required — Docker is not missing.',
        'newgrp docker',
        'id -nG   # must list docker\nnewgrp docker\n# or close this terminal and open a new one, then:\nj41-dispatcher doctor'));
    } else if (info.class === 'enoent') {
      dockerClass = 'enoent';
      const hint = osInfo.platform === 'darwin'
        ? 'Start Docker Desktop and wait until the whale is steady.'
        : osInfo.platform === 'win32'
          ? 'Start Docker Desktop (WSL2 backend).'
          : 'sudo systemctl enable --now docker';
      checks.push(mkCheck('docker.daemon', 'Docker daemon', 'fail', 'not running or sock missing', hint, hint));
      checks.push(mkCheck('docker.sock', 'Docker sock', 'fail',
        'ENOENT on the Docker socket', hint, hint));
      checks.push(mkCheck('docker.group', 'Docker group', osInfo.platform === 'linux' ? 'skip' : 'skip',
        'n/a until the daemon is listening'));
    } else {
      dockerClass = 'daemon-down';
      const hint = osInfo.platform === 'darwin'
        ? 'Start Docker Desktop.'
        : 'sudo systemctl start docker';
      checks.push(mkCheck('docker.daemon', 'Docker daemon', 'fail',
        redact(info.err && info.err.message) || 'docker info failed', hint, hint));
      checks.push(mkCheck('docker.sock', 'Docker sock', 'fail', 'could not reach the engine', hint, hint));
      checks.push(mkCheck('docker.group', 'Docker group', 'skip', 'n/a'));
    }
  } else {
    checks.push(mkCheck('docker.daemon', 'Docker daemon', 'fail', 'no docker CLI'));
    checks.push(mkCheck('docker.sock', 'Docker sock', 'fail', 'no docker CLI'));
    checks.push(mkCheck('docker.group', 'Docker group', osInfo.platform === 'linux' ? 'fail' : 'skip',
      osInfo.platform === 'linux' ? 'no docker CLI' : `n/a (${osInfo.platform})`));
  }

  const dockerUsable = dockerClass === 'ok';
  if (dockerUsable) {
    const hasImage = (name) => {
      try {
        runExec(deps, `docker image inspect j41/${name}:latest`);
        return true;
      } catch { return false; }
    };
    if (hasImage('job-agent')) {
      checks.push(mkCheck('image.job-agent', 'Job image', 'pass', 'j41/job-agent:latest'));
    } else {
      checks.push(mkCheck('image.job-agent', 'Job image', 'fail',
        'j41/job-agent:latest is not built',
        'j41-dispatcher build-image',
        'j41-dispatcher build-image'));
    }
    const computeIds = identities.filter((r) => r.kind === 'compute');
    const wantJail = osInfo.platform === 'linux' && (deps.nvidiaRuntime || deps.computeEnabled || computeIds.length);
    if (osInfo.platform !== 'linux' || !wantJail) {
      checks.push(mkCheck('image.gpu-jail', 'Jail image', 'skip',
        osInfo.platform === 'linux' ? 'not needed until a compute listing' : 'GPU chapter is Linux NVIDIA only'));
    } else if (hasImage('gpu-jail')) {
      checks.push(mkCheck('image.gpu-jail', 'Jail image', 'pass', 'j41/gpu-jail:latest'));
    } else {
      checks.push(mkCheck('image.gpu-jail', 'Jail image', 'fail',
        'j41/gpu-jail:latest is not built',
        'j41-dispatcher build-image',
        'j41-dispatcher build-image'));
    }
  } else {
    checks.push(mkCheck('image.job-agent', 'Job image', 'skip', 'Docker not usable'));
    checks.push(mkCheck('image.gpu-jail', 'Jail image', 'skip', 'Docker not usable'));
  }

  // clock
  const apiUrl = (opts.apiUrl) || 'https://api.junction41.io';
  const clock = await probeClock(deps, apiUrl);
  checks.push(mkCheck('clock', 'Clock', clock.status, clock.detail,
    clock.status === 'fail' ? 'sudo timedatectl set-ntp true' : null,
    clock.status === 'fail' ? ntpBlock(osInfo) : null));

  // runtime
  let runtime = 'docker';
  try {
    const raw = deps.fs.readFileSync(path.join(dispatcherDir, 'config.json'), 'utf8');
    runtime = (JSON.parse(raw).runtime || 'docker').toLowerCase();
  } catch { /* defaults docker */ }
  if (runtime === 'local') {
    checks.push(mkCheck('runtime', 'Runtime', 'fail',
      'runtime is local (ZERO isolation). Mass-use requires Docker.',
      'j41-dispatcher config --runtime docker',
      'j41-dispatcher config --runtime docker\n# Then install/start Docker. Do not start with --dev-unsafe for public jobs.'));
  } else {
    checks.push(mkCheck('runtime', 'Runtime', 'pass', runtime || 'docker'));
  }

  // llm
  const llm = deps.llm || {};
  const llmConfigured = llm.configured === true || !!(llm.provider && llm.provider !== '');
  if (!llmConfigured) {
    checks.push(mkCheck('llm', 'LLM', 'warn',
      'not configured — labour jobs will be refused at accept',
      'j41-dispatcher dashboard',
      'j41-dispatcher dashboard   # [4] Configure Global LLM Default'));
  } else {
    const name = llm.provider ? redact(String(llm.provider)) : 'configured';
    checks.push(mkCheck('llm', 'LLM', 'pass', `configured (${name})`));
  }

  // identity
  if (identities.length === 0) {
    checks.push(mkCheck('identity', 'Identities', 'warn', 'no local agents',
      'j41-dispatcher setup agent-1 <name> --template code-review',
      'j41-dispatcher setup agent-1 myagent --template code-review'));
  } else if (identities.every((r) => r.stage === 'local-only' || r.stage === 'pending')) {
    checks.push(mkCheck('identity', 'Identities', 'warn',
      formatIdentitySummary(identities) + ' — none on-chain',
      'j41-dispatcher setup agent-1 <name> --template code-review',
      'j41-dispatcher register agent-1 <name>\n# or: j41-dispatcher setup agent-1 <name> --template code-review'));
  } else {
    checks.push(mkCheck('identity', 'Identities', 'pass', formatIdentitySummary(identities)));
  }

  // fee-tank
  const tanks = identities.map((r) => r.feeTank).filter(Boolean);
  const empty = identities.filter((r) => r.feeTank === 'empty-sweepable' || r.feeTank === 'empty-unfunded');
  const low = identities.filter((r) => r.feeTank === 'low');
  const onChain = identities.filter((r) => r.onChain);
  if (onChain.length === 0) {
    checks.push(mkCheck('fee-tank', 'Fee tank', 'skip', 'n/a (no on-chain identities)'));
  } else if (empty.length) {
    const sweepable = empty.find((r) => r.feeTank === 'empty-sweepable');
    checks.push(mkCheck('fee-tank', 'Fee tank', 'fail',
      sweepable
        ? `${sweepable.id} empty-sweepable — earnings at i-address, tank cannot write`
        : `${empty[0].id} empty-unfunded — fund the R-address externally`,
      sweepable ? `j41-dispatcher wallet sweep ${sweepable.id}` : `j41-dispatcher wallet`,
      sweepable ? `j41-dispatcher wallet sweep ${sweepable.id}` : null));
  } else if (low.length) {
    const w = (deps.feeTankRows || []).find((r) => r.agentId === low[0].id);
    const writes = w && w.writes != null ? w.writes : '?';
    checks.push(mkCheck('fee-tank', 'Fee tank', 'warn',
      `${low[0].id} low (${writes}/${DEFAULT_FLOOR_WRITES} writes) — not empty`));
  } else if (!tanks.filter((t) => t && t !== 'unregistered').length) {
    checks.push(mkCheck('fee-tank', 'Fee tank', 'warn', 'no snapshot yet — run start or wallet'));
  } else {
    checks.push(mkCheck('fee-tank', 'Fee tank', 'pass', 'ok'));
  }

  // gpu
  const gpuOffered = osInfo.platform === 'linux' && !!deps.nvidiaRuntime;
  const computeConfigured = deps.computeEnabled || identities.some((r) => r.kind === 'compute');
  if (osInfo.platform !== 'linux') {
    checks.push(mkCheck('gpu.nvidia', 'GPU NVIDIA', 'skip', 'GPU chapter is Linux NVIDIA only'));
    checks.push(mkCheck('gpu.storage', 'GPU storage', 'skip', 'GPU chapter is Linux NVIDIA only'));
  } else if (!computeConfigured) {
    checks.push(mkCheck('gpu.nvidia', 'GPU NVIDIA', 'skip',
      gpuOffered ? 'nvidia runtime present — labour-only until you list compute' : 'labour-only; no nvidia runtime'));
    checks.push(mkCheck('gpu.storage', 'GPU storage', 'skip', 'not checked until a compute listing'));
  } else {
    if (deps.nvidiaRuntime) {
      checks.push(mkCheck('gpu.nvidia', 'GPU NVIDIA', 'pass', 'nvidia runtime registered'));
    } else {
      checks.push(mkCheck('gpu.nvidia', 'GPU NVIDIA', 'fail',
        'docker has no nvidia runtime (install nvidia-container-toolkit)',
        'sudo nvidia-ctk runtime configure --runtime=docker',
        'install nvidia-container-toolkit, then:\nsudo nvidia-ctk runtime configure --runtime=docker\nsudo systemctl restart docker'));
    }
    let storageOk = false;
    if (typeof deps.supportsStorageOpt === 'function') storageOk = !!deps.supportsStorageOpt();
    else {
      try {
        const { supportsStorageOpt } = require('./docker-host');
        storageOk = supportsStorageOpt({ execSync: deps.execSync });
      } catch { storageOk = false; }
    }
    if (storageOk) {
      checks.push(mkCheck('gpu.storage', 'GPU storage', 'pass', 'StorageOpt capable'));
    } else {
      const driver = deps.dockerDriver || 'unknown';
      checks.push(mkCheck('gpu.storage', 'GPU storage', 'fail',
        `host docker cannot cap disk_gb (driver ${driver}; need overlay2 over XFS -o prjquota, or btrfs/zfs)`,
        null,
        'Linux NVIDIA hosts only. Do not auto-rewrite daemon.json from install.\nNeed classic overlay2 + XFS prjquota (or btrfs/zfs), and Docker 29 must set\n  "storage-driver": "overlay2"\n  "features": { "containerd-snapshotter": false }\nSee docs/plans/2026-09-04-distro-operability.md'));
    }
  }

  const { nextCommand, copyPasteBlock } = pickNext(checks);
  const ok = checks.every((c) => c.status !== 'fail');
  const generatedAt = new Date(typeof deps.now === 'function' ? deps.now() : Date.now()).toISOString();

  return {
    ok,
    generatedAt,
    version: String(deps.packageVersion),
    os: osInfo,
    checks,
    identities,
    nextCommand,
    copyPasteBlock,
    gpuOffered,
  };
}

function formatDoctorTable(report) {
  const icon = { pass: '✓', warn: '⚠', fail: '✗', skip: ' ' };
  const lines = ['j41-dispatcher doctor', ''];
  const show = report.checks.filter((c) => c.status !== 'skip' || c.id.startsWith('gpu.'));
  const nameWidth = Math.max(18, ...show.map((c) => c.name.length));
  for (const c of show) {
    if (c.status === 'skip' && c.id.startsWith('gpu.') && report.os && report.os.platform === 'linux' && !report.gpuOffered) {
      // still show a one-line GPU skip on non-linux in the summary below
    }
    if (c.status === 'skip' && !c.id.startsWith('gpu.')) continue;
    if (c.status === 'skip' && c.id.startsWith('gpu.') && report.os && report.os.platform === 'linux') continue;
    lines.push(`  ${c.name.padEnd(nameWidth)} ${c.detail}`);
  }
  if (report.os && report.os.platform !== 'linux') {
    lines.push(`  ${'GPU'.padEnd(nameWidth)} skipped (linux NVIDIA chapter)`);
  }
  lines.push('');
  for (const c of report.checks) {
    if (c.status === 'fail') lines.push(`  ${icon.fail} ${c.id.padEnd(18)} ${c.detail}`);
    else if (c.status === 'warn') lines.push(`  ${icon.warn} ${c.id.padEnd(18)} ${c.detail}`);
  }
  lines.push('');
  lines.push('Next:');
  lines.push(`  ${report.nextCommand || 'j41-dispatcher start'}`);
  if (report.copyPasteBlock) {
    lines.push('');
    lines.push('Copy-paste:');
    for (const row of String(report.copyPasteBlock).split('\n')) lines.push(`  ${row}`);
  }
  return lines.join('\n') + '\n';
}

function dockerAdviceFromError(err, platform) {
  const cls = classifyDockerError(err);
  if (cls === 'eacces') {
    return {
      class: cls,
      message: 'Docker is installed but this session cannot use /var/run/docker.sock (not in group docker). Open a new terminal or run: newgrp docker',
      nextCommand: 'newgrp docker',
    };
  }
  if (cls === 'enoent') {
    const msg = platform === 'darwin'
      ? 'Docker socket missing — start Docker Desktop.'
      : platform === 'win32'
        ? 'Docker engine not reachable — start Docker Desktop (WSL2 backend).'
        : 'Docker daemon is not running. Start it with: sudo systemctl start docker';
    return { class: cls, message: msg, nextCommand: platform === 'linux' ? 'sudo systemctl start docker' : null };
  }
  return {
    class: cls,
    message: `Docker error: ${err && err.message ? err.message : err}. Do not switch to local mode for public jobs.`,
    nextCommand: null,
  };
}

module.exports = {
  CHECK_IDS,
  CLOCK_SKEW_MS,
  runDoctor,
  formatDoctorTable,
  formatIdentitySummary,
  classifyDockerError,
  classifyIdentities,
  detectOs,
  dockerAdviceFromError,
};
