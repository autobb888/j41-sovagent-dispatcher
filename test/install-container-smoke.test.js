'use strict';
/**
 * Closest automated stand-in for "curl | bash on a stock Ubuntu 24.04 VM".
 * Guest has curl/ca-certificates/xz-utils only — no Node, no Docker engine.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INSTALL = path.join(ROOT, 'scripts', 'install.sh');

function dockerOk() {
  const r = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 8000, stdio: 'pipe' });
  return r.status === 0;
}

const SKIP = !dockerOk();

test('ubuntu 24.04 without node or docker: Node 22 tarball + fail-closed, no runtime=local', {
  skip: SKIP,
  timeout: 180000,
}, () => {
  const r = spawnSync('docker', [
    'run', '--rm',
    '-e', 'J41_SKIP_NPM=1',
    '-e', 'HOME=/root',
    '-v', `${INSTALL}:/install.sh:ro`,
    'ubuntu:24.04',
    'bash', '-lc',
    [
      'export DEBIAN_FRONTEND=noninteractive',
      'apt-get update -qq',
      'apt-get install -y -qq curl ca-certificates xz-utils >/dev/null',
      'bash /install.sh; ec=$?',
      'echo EXIT:$ec',
      'if [ -x /root/.local/node/bin/node ]; then /root/.local/node/bin/node --version; else echo NO_NODE; fi',
      'exit 0',
    ].join('\n'),
  ], { encoding: 'utf8', timeout: 170000 });

  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  assert.equal(r.status, 0, `docker run failed\n${out}`);
  assert.match(out, /EXIT:1/, `installer must fail-closed on missing Docker\n${out}`);
  assert.match(out, /v22\.19\.0/, `must install pinned Node 22.19.0\n${out}`);
  assert.doesNotMatch(out, /runtime:\s*local/i);
  assert.doesNotMatch(out, /NO_NODE/);
  assert.match(out, /docker/i);
});
