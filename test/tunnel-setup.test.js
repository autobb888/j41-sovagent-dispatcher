'use strict';
/**
 * tunnel-setup: named Cloudflare HTTP+TCP config (spec 2.37.4 §12).
 * Injected homedir only — never touches the operator ~/.j41.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildCloudflaredYaml,
  runTunnelSetup,
  cloudflaredCommands,
} = require('../src/tunnel-setup');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'j41-tunnel-'));
}

function restoreLanEnv(prev) {
  if (prev === undefined) delete process.env.J41_ALLOW_LAN_RENTAL;
  else process.env.J41_ALLOW_LAN_RENTAL = prev;
}

test('YAML contains HTTP + TCP ingresses and a 404 catch-all', () => {
  const yaml = buildCloudflaredYaml({
    httpHost: 'proxy.example.com',
    sshHost: 'gpu.example.com',
    webhookPort: 9841,
    sshPort: 2222,
  });
  assert.match(yaml, /hostname:\s*proxy\.example\.com/);
  assert.match(yaml, /service:\s*http:\/\/127\.0\.0\.1:9841/);
  assert.match(yaml, /hostname:\s*gpu\.example\.com/);
  assert.match(yaml, /service:\s*tcp:\/\/127\.0\.0\.1:2222/);
  assert.match(yaml, /service:\s*http_status:404/);
});

test('RFC1918 --ssh-host 192.168.1.69 is refused', async () => {
  const prev = process.env.J41_ALLOW_LAN_RENTAL;
  delete process.env.J41_ALLOW_LAN_RENTAL;
  try {
    await assert.rejects(
      () => runTunnelSetup({
        agentId: 'gpu-1',
        httpHost: 'proxy.example.com',
        sshHost: '192.168.1.69',
        homedir: tmpHome(),
      }),
      /RENTAL_LAN_HOST/,
    );
  } finally {
    restoreLanEnv(prev);
  }
});

test('loopback --ssh-host is refused', async () => {
  const prev = process.env.J41_ALLOW_LAN_RENTAL;
  delete process.env.J41_ALLOW_LAN_RENTAL;
  try {
    await assert.rejects(
      () => runTunnelSetup({
        agentId: 'gpu-1',
        httpHost: 'proxy.example.com',
        sshHost: '127.0.0.1',
        homedir: tmpHome(),
      }),
      /RENTAL_LAN_HOST/,
    );
    await assert.rejects(
      () => runTunnelSetup({
        agentId: 'gpu-1',
        httpHost: 'proxy.example.com',
        sshHost: 'localhost',
        homedir: tmpHome(),
      }),
      /RENTAL_LAN_HOST/,
    );
  } finally {
    restoreLanEnv(prev);
  }
});

test('runTunnelSetup writes config.yml mode 0600 with both ingresses', async () => {
  const home = tmpHome();
  const saved = [];
  const result = await runTunnelSetup({
    agentId: 'gpu-1',
    httpHost: 'proxy.example.com',
    sshHost: 'gpu.example.com',
    sshPort: 2222,
    homedir: home,
    saveDispatcherConfig: (partial) => { saved.push(partial); },
    updateProfile: async () => ({ skipped: true }),
  });
  const yamlPath = path.join(home, '.j41', 'dispatcher', 'tunnels', 'gpu-1', 'config.yml');
  assert.equal(result.yamlPath, yamlPath);
  assert.ok(fs.existsSync(yamlPath));
  const st = fs.statSync(yamlPath);
  assert.equal(st.mode & 0o777, 0o600);
  const yaml = fs.readFileSync(yamlPath, 'utf8');
  assert.match(yaml, /hostname:\s*proxy\.example\.com/);
  assert.match(yaml, /service:\s*http:\/\/127\.0\.0\.1:9841/);
  assert.match(yaml, /hostname:\s*gpu\.example\.com/);
  assert.match(yaml, /service:\s*tcp:\/\/127\.0\.0\.1:2222/);
});

test('runTunnelSetup sets publicUrl and dispatcher ssh_hostname / ssh_tunnel_port', async () => {
  const home = tmpHome();
  const agentDir = path.join(home, '.j41', 'dispatcher', 'agents', 'gpu-1');
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, 'agent-config.json'), JSON.stringify({ rental: true }), { mode: 0o600 });
  const saved = [];
  const result = await runTunnelSetup({
    agentId: 'gpu-1',
    httpHost: 'proxy.example.com',
    sshHost: 'gpu.example.com',
    sshPort: 2222,
    homedir: home,
    saveDispatcherConfig: (partial) => { saved.push(partial); },
    updateProfile: async () => ({ skipped: true }),
  });
  assert.equal(result.publicUrl, 'https://proxy.example.com');
  const cfg = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent-config.json'), 'utf8'));
  assert.equal(cfg.publicUrl, 'https://proxy.example.com');
  const st = fs.statSync(path.join(agentDir, 'agent-config.json'));
  assert.equal(st.mode & 0o777, 0o600);
  assert.ok(saved.length >= 1);
  const provider = Object.values(saved[0].compute.providers)[0];
  assert.equal(provider.ssh_hostname, 'gpu.example.com');
  assert.equal(provider.ssh_tunnel_port, 2222);
});

test('default is print-only: does not spawn cloudflared', async () => {
  const home = tmpHome();
  let spawned = 0;
  const result = await runTunnelSetup({
    agentId: 'gpu-1',
    httpHost: 'proxy.example.com',
    sshHost: 'gpu.example.com',
    homedir: home,
    cloudflaredOnPath: true,
    spawnCloudflared: () => { spawned += 1; },
    saveDispatcherConfig: () => {},
    updateProfile: async () => ({ skipped: true }),
  });
  assert.equal(spawned, 0);
  assert.equal(result.ran, false);
  const blob = result.commands.join('\n');
  assert.match(blob, /cloudflared tunnel route dns /);
  assert.match(blob, /proxy\.example\.com/);
  assert.match(blob, /gpu\.example\.com/);
  assert.match(blob, /cloudflared tunnel --config /);
});

test('cloudflaredCommands print route dns + run, never a WIF', () => {
  const cmds = cloudflaredCommands({
    tunnel: 'gpu-1',
    httpHost: 'proxy.example.com',
    sshHost: 'gpu.example.com',
    configPath: '/tmp/config.yml',
  });
  assert.match(cmds[0], /cloudflared tunnel route dns gpu-1 proxy\.example\.com/);
  assert.match(cmds[1], /cloudflared tunnel route dns gpu-1 gpu\.example\.com/);
  assert.match(cmds[2], /cloudflared tunnel --config \/tmp\/config\.yml run/);
  assert.doesNotMatch(cmds.join('\n'), /Uw[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(cmds.join('\n'), /WIF/i);
});

test('cli.js registers tunnel-setup as a thin rind', () => {
  const cli = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
  assert.match(cli, /\.command\('tunnel-setup <agent-id>'\)/);
  assert.match(cli, /require\('\.\/tunnel-setup'\)/);
  assert.match(cli, /--http-host/);
  assert.match(cli, /--ssh-host/);
});

test('api-setup fails closed without publicUrl / --webhook-url', () => {
  const cli = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
  const apiStart = cli.indexOf(".command('api-setup <agent-id>')");
  const apiEnd = cli.indexOf('\n  .command(', apiStart + 1);
  const apiBlock = cli.slice(apiStart, apiEnd === -1 ? apiStart + 8000 : apiEnd);
  assert.match(apiBlock, /--webhook-url/);
  assert.match(apiBlock, /model\.public_url|publicUrl/);
  assert.match(apiBlock, /process\.exit\(1\)/);
});

test('start skips compute/model listings that fail doctor codes', () => {
  const cli = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
  assert.match(cli, /listingAdvertiseRefusal/);
  assert.match(cli, /not advertising/);
});
