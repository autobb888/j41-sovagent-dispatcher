'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { homeGpuConfigured } = require('../src/rental-setup.js');

test('package.json files includes Dockerfile.gpu-jail', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.ok(pkg.files.includes('Dockerfile.gpu-jail'));
});

test('gpu-jail renter is not a locked shadow account (pubkey must work with UsePAM no)', () => {
  const df = fs.readFileSync(path.join(__dirname, '../Dockerfile.gpu-jail'), 'utf8');
  assert.match(df, /useradd --create-home --shell \/bin\/bash renter/);
  assert.match(df, /usermod -p '\*' renter/, 'Debian useradd locks with !; sshd then refuses pubkey as Permission denied (publickey)');
  assert.match(df, /mkdir -p \/workspace/);
  assert.match(df, /chown renter:renter \/workspace/);
  assert.match(df, /libcap2-bin/);
  assert.match(df, /python3-pip/);
  assert.match(df, /python3-venv/);
  assert.match(df, /build-essential/);
  assert.doesNotMatch(df, /^\s+sudo\s*\\?\s*$/m);
  assert.match(df, /gpu-jail-init/);
  assert.match(df, /LoginGraceTime 60/);
  assert.doesNotMatch(df, /LoginGraceTime 0/);
  assert.doesNotMatch(df, /bind-mounted from the host jail dir/);
});

test('gpu-jail-init umounts docker hosts/resolv binds and drops SYS_ADMIN before sshd', () => {
  const init = fs.readFileSync(path.join(__dirname, '../docker/gpu-jail-init.sh'), 'utf8');
  assert.match(init, /umount/);
  assert.doesNotMatch(init, /\|\|\s*true\b/);
  assert.match(init, /capsh --drop=cap_sys_admin,cap_setpcap/);
  assert.match(init, /nameserver 1\.1\.1\.1/);
  assert.match(init, /\/usr\/sbin\/sshd/);
  assert.match(init, /gpu-jail-init: umount \$f failed — docker bind may remain on host xfs/);
  const loop = init.match(/for f in \/etc\/resolv\.conf \/etc\/hosts \/etc\/hostname; do\n[\s\S]*?\ndone/);
  assert.ok(loop, 'hosts/resolv umount loop must exist');
  const thenIdx = loop[0].search(/\bthen\b/);
  const elseIdx = loop[0].search(/\belse\b/);
  const printfIdx = loop[0].indexOf('nameserver 1.1.1.1');
  assert.ok(thenIdx >= 0 && elseIdx > thenIdx, 'umount success/failure branches');
  assert.ok(printfIdx > thenIdx && printfIdx < elseIdx, 'printf resolv is behind the umount success path');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.ok(pkg.files.includes('docker/gpu-jail-init.sh'));
});

test('homeGpuConfigured is true only when compute is on and a home-gpu provider exists', () => {
  assert.equal(homeGpuConfigured({ compute: { enabled: false, providers: { c: { type: 'home-gpu' } } } }), false);
  assert.equal(homeGpuConfigured({ compute: { enabled: true, providers: { c: { type: 'vast' } } } }), false);
  assert.equal(homeGpuConfigured({ compute: { enabled: true, providers: { c: { type: 'home-gpu' } } } }), true);
});

test('cli.js start gate names j41-dispatcher build-image when home-gpu is configured', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  assert.match(src, /jailImageExists/);
  assert.match(src, /JAIL_IMAGE|j41\/gpu-jail/);
});

test('build-image still builds the jail when the job image already exists', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const helper = src.indexOf('function buildJailImageScriptPath(');
  assert.ok(helper > 0, 'buildJailImageScriptPath sibling must exist');
  assert.match(src.slice(helper, helper + 200), /build-jail-image\.sh/);
  const start = src.indexOf(".command('build-image')");
  assert.ok(start > 0, 'build-image command must exist');
  const next = src.indexOf(".command('start')", start);
  const body = src.slice(start, next > start ? next : start + 5000);
  assert.match(body, /buildJailImageScriptPath/);
  assert.match(body, /jailImageExists/);
  const skip = body.match(/if \(!options\.force && jobImageExists\(\)\) \{[\s\S]*?\n    \}/);
  assert.ok(skip, 'job-image skip block must exist');
  assert.doesNotMatch(skip[0], /\breturn\b/, 'skipping the job image must not return before the jail build');
});

test('start jail gate inspects jailImageRef per home-gpu provider, not only env JAIL_IMAGE', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const refuse = src.indexOf('the jail image');
  assert.ok(refuse > 0);
  const body = src.slice(refuse - 900, refuse + 1200);
  assert.match(body, /homeGpuConfigured/);
  assert.match(body, /jailImageRef/);
  assert.match(body, /assertHomeGpuHostReady/);
  assert.match(body, /NODE_ENV !== 'test'/);
  assert.match(body, /RUNTIME !== 'local'/);
  assert.match(body, /no buyer can pay into this fleet/);
  assert.match(body, /j41-dispatcher build-image/);
});

test('JAIL_IMAGE constant is jailImageRef({})', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  assert.match(src, /const JAIL_IMAGE = jailImageRef\(\{\}\)/);
});
