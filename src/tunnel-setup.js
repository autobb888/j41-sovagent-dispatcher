'use strict';
/**
 * Named Cloudflare HTTP+TCP tunnel config. Dispatcher does not create the
 * Cloudflare account — the operator supplies DNS names they already routed.
 * Default is print-only; never shells out unless cloudflared is on PATH and
 * --run is passed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertPublicSshHost } = require('./ssh-host');

const DEFAULT_WEBHOOK_PORT = 9841;
const DEFAULT_SSH_PORT = 2222;

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function assertAgentId(agentId) {
  const id = String(agentId || '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || id.includes('..')) {
    throw codedError('TUNNEL_BAD_AGENT', `Invalid agent ID format: ${id || '(empty)'}`);
  }
  return id;
}

function normalizeDnsHost(raw) {
  let h = String(raw == null ? '' : raw).trim();
  h = h.replace(/^https?:\/\//i, '');
  h = h.replace(/\/+$/, '');
  const slash = h.indexOf('/');
  if (slash !== -1) h = h.slice(0, slash);
  return h;
}

function assertTunnelHosts({ httpHost, sshHost } = {}) {
  const http = normalizeDnsHost(httpHost);
  const ssh = normalizeDnsHost(sshHost);
  if (!http) throw codedError('TUNNEL_NO_HTTP_HOST', 'TUNNEL_NO_HTTP_HOST: --http-host is required');
  if (!ssh) throw codedError('TUNNEL_NO_SSH_HOST', 'TUNNEL_NO_SSH_HOST: --ssh-host is required');
  assertPublicSshHost(http);
  assertPublicSshHost(ssh);
  return { httpHost: http, sshHost: ssh };
}

function buildCloudflaredYaml({ httpHost, sshHost, webhookPort, sshPort } = {}) {
  const hosts = assertTunnelHosts({ httpHost, sshHost });
  const httpPort = Number(webhookPort) > 0 ? Number(webhookPort) : DEFAULT_WEBHOOK_PORT;
  const tcpPort = Number(sshPort) > 0 ? Number(sshPort) : DEFAULT_SSH_PORT;
  return [
    'ingress:',
    `  - hostname: ${hosts.httpHost}`,
    `    service: http://127.0.0.1:${httpPort}`,
    `  - hostname: ${hosts.sshHost}`,
    `    service: tcp://127.0.0.1:${tcpPort}`,
    '  - service: http_status:404',
    '',
  ].join('\n');
}

function tunnelConfigPath(agentId, { homedir } = {}) {
  const home = homedir || os.homedir();
  return path.join(home, '.j41', 'dispatcher', 'tunnels', assertAgentId(agentId), 'config.yml');
}

function cloudflaredCommands({ tunnel, httpHost, sshHost, configPath } = {}) {
  const name = String(tunnel || 'tunnel');
  const http = normalizeDnsHost(httpHost);
  const ssh = normalizeDnsHost(sshHost);
  return [
    `cloudflared tunnel route dns ${name} ${http}`,
    `cloudflared tunnel route dns ${name} ${ssh}`,
    `cloudflared tunnel --config ${configPath} run`,
  ];
}

function writeMode(fss, filePath, body, mode) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fss.writeFileSync(tmp, body, { mode });
  fss.renameSync(tmp, filePath);
  try { fss.chmodSync(filePath, mode); } catch { /* umask already 077 in cli */ }
}

function persistAgentPublicUrl(agentId, publicUrl, { homedir, fs: fss } = {}) {
  const home = homedir || os.homedir();
  const agentDir = path.join(home, '.j41', 'dispatcher', 'agents', agentId);
  fss.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const configPath = path.join(agentDir, 'agent-config.json');
  let config = {};
  try {
    if (fss.existsSync(configPath)) config = JSON.parse(fss.readFileSync(configPath, 'utf8'));
  } catch { config = {}; }
  config.publicUrl = publicUrl;
  writeMode(fss, configPath, JSON.stringify(config, null, 2) + '\n', 0o600);
  return configPath;
}

function persistSshHostname(agentId, sshHost, sshPort, { cfg, saveDispatcherConfig } = {}) {
  if (typeof saveDispatcherConfig !== 'function') return null;
  const { providerCfgForAgent } = require('./rental-setup');
  const found = providerCfgForAgent(cfg || {}, agentId);
  const table = found
    ? found[0]
    : (String(agentId || 'card').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32) || 'card');
  const partial = {
    compute: {
      providers: {
        [table]: {
          ssh_hostname: sshHost,
          ssh_tunnel_port: Number(sshPort) > 0 ? Number(sshPort) : DEFAULT_SSH_PORT,
        },
      },
    },
  };
  saveDispatcherConfig(partial);
  return partial;
}

function detectCloudflared(execSync) {
  try {
    const out = execSync('command -v cloudflared', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return String(out || '').trim();
  } catch {
    return '';
  }
}

async function applyProfileWebsite({ agentId, publicUrl, keys, updateProfile, apiUrl, network }) {
  if (typeof updateProfile === 'function') {
    return updateProfile({ agentId, publicUrl, keys });
  }
  if (process.env.NODE_ENV === 'test') return { skipped: 'test' };
  if (!keys || !keys.identity || !keys.iAddress || !keys.wif) {
    return { skipped: 'not-registered' };
  }
  const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
  const { removeAndRewriteVdxfFields } = require('@junction41/sovagent-sdk/dist/onboarding/vdxf.js');
  const agent = new J41Agent({
    apiUrl,
    wif: keys.wif,
    identityName: keys.identity,
    iAddress: keys.iAddress,
  });
  try {
    await agent.authenticate();
    const result = await removeAndRewriteVdxfFields({
      agent,
      identityName: keys.identity,
      fieldsToUpdate: {
        profileWebsite: publicUrl,
        networkEndpoints: JSON.stringify([publicUrl]),
      },
      chain: network,
      wif: keys.wif,
    });
    return { writeTxid: result && result.writeTxid };
  } finally {
    try { agent.stop?.(); } catch { /* ignore */ }
  }
}

async function runTunnelSetup(opts = {}) {
  const fss = opts.fs || fs;
  const homedir = opts.homedir || os.homedir();
  const agentId = assertAgentId(opts.agentId);
  const hosts = assertTunnelHosts({ httpHost: opts.httpHost, sshHost: opts.sshHost });
  const sshPort = Number(opts.sshPort) > 0 ? Number(opts.sshPort) : DEFAULT_SSH_PORT;
  const webhookPort = Number(opts.webhookPort) > 0 ? Number(opts.webhookPort) : DEFAULT_WEBHOOK_PORT;
  const yaml = buildCloudflaredYaml({
    httpHost: hosts.httpHost,
    sshHost: hosts.sshHost,
    webhookPort,
    sshPort,
  });
  const yamlPath = tunnelConfigPath(agentId, { homedir });
  fss.mkdirSync(path.dirname(yamlPath), { recursive: true, mode: 0o700 });
  writeMode(fss, yamlPath, yaml, 0o600);

  const publicUrl = `https://${hosts.httpHost}`;
  persistAgentPublicUrl(agentId, publicUrl, { homedir, fs: fss });
  persistSshHostname(agentId, hosts.sshHost, sshPort, {
    cfg: opts.cfg,
    saveDispatcherConfig: opts.saveDispatcherConfig || require('./config-loader').saveDispatcherConfig,
  });

  const commands = cloudflaredCommands({
    tunnel: agentId,
    httpHost: hosts.httpHost,
    sshHost: hosts.sshHost,
    configPath: yamlPath,
  });

  let profile;
  try {
    profile = await applyProfileWebsite({
      agentId,
      publicUrl,
      keys: opts.keys,
      updateProfile: opts.updateProfile,
      apiUrl: opts.apiUrl,
      network: opts.network,
    });
  } catch (e) {
    profile = { skipped: 'update-failed', error: String(e && e.message ? e.message : e) };
  }

  let ran = false;
  const wantRun = opts.run === true;
  if (wantRun) {
    const onPath = opts.cloudflaredOnPath != null
      ? !!opts.cloudflaredOnPath
      : !!detectCloudflared(opts.execSync || require('child_process').execSync);
    if (onPath && typeof opts.spawnCloudflared === 'function') {
      opts.spawnCloudflared(commands, yamlPath);
      ran = true;
    } else if (onPath) {
      const { spawnSync } = require('child_process');
      spawnSync('cloudflared', ['tunnel', '--config', yamlPath, 'run'], { stdio: 'inherit' });
      ran = true;
    }
  }

  return {
    yamlPath,
    yaml,
    publicUrl,
    sshHostname: hosts.sshHost,
    sshTunnelPort: sshPort,
    commands,
    ran,
    profile,
  };
}

module.exports = {
  DEFAULT_WEBHOOK_PORT,
  DEFAULT_SSH_PORT,
  normalizeDnsHost,
  assertTunnelHosts,
  buildCloudflaredYaml,
  tunnelConfigPath,
  cloudflaredCommands,
  runTunnelSetup,
};
