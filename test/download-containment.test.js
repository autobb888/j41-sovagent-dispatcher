'use strict';
/**
 * I1 — containDownload: hire-time and chat-path downloads must not keep
 * a file that landed outside the job files dir.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';
const { containDownload } = require('../src/job-agent.js');

function withTmp(fn) {
  return async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-dl-'));
    try { await fn(t, root); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  };
}

test('contained path is kept', withTmp(async (_t, root) => {
  const filesDir = path.join(root, 'workspace', 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  const localPath = path.join(filesDir, 'notes.txt');
  fs.writeFileSync(localPath, 'ok');

  const result = containDownload(localPath, filesDir);

  assert.equal(result.contained, true);
  assert.equal(fs.existsSync(localPath), true);
  assert.equal(fs.readFileSync(localPath, 'utf8'), 'ok');
}));

test('escaped localPath is unlinked', withTmp(async (_t, root) => {
  const filesDir = path.join(root, 'workspace', 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  const escaped = path.join(root, 'tmp', 'ipc-msg.jsonl');
  fs.mkdirSync(path.dirname(escaped), { recursive: true });
  fs.writeFileSync(escaped, '{"type":"budget_increased"}');
  // SDK does path.join(filesDir, unsanitised Content-Disposition filename)
  const localPath = path.join(filesDir, '..', '..', 'tmp', 'ipc-msg.jsonl');
  assert.equal(path.resolve(localPath), path.resolve(escaped));
  assert.equal(fs.existsSync(escaped), true);

  const result = containDownload(localPath, filesDir);

  assert.equal(result.contained, false);
  assert.equal(fs.existsSync(escaped), false, 'escaped payload must be unlinked');
}));

test('symlink-smuggled path outside filesDir is unlinked', withTmp(async (_t, root) => {
  const filesDir = path.join(root, 'workspace', 'files');
  const brokerDir = path.join(root, 'sign', 'req');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(brokerDir, { recursive: true });
  fs.symlinkSync(brokerDir, path.join(filesDir, 'link'));
  const planted = path.join(brokerDir, 'abcd1234.json');
  fs.writeFileSync(planted, '{"method":"executeOnChain"}');
  const localPath = path.join(filesDir, 'link', 'abcd1234.json');

  const result = containDownload(localPath, filesDir);

  assert.equal(result.contained, false);
  assert.equal(fs.existsSync(planted), false, 'realpath must follow the planted link and unlink the target');
}));

test('missing filesDir fail-closes and unlinks the planted file', withTmp(async (_t, root) => {
  const filesDir = path.join(root, 'workspace', 'files');
  const planted = path.join(root, 'tmp', 'ipc-msg.jsonl');
  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.writeFileSync(planted, '{"type":"shutdown"}');
  assert.equal(fs.existsSync(filesDir), false);

  const result = containDownload(planted, filesDir);

  assert.equal(result.contained, false);
  assert.equal(fs.existsSync(planted), false, 'unresolvable filesDir must unlink via the original path');
}));

test('missing dirname(localPath) fail-closes', withTmp(async (_t, root) => {
  const filesDir = path.join(root, 'workspace', 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  const localPath = path.join(root, 'does-not-exist', 'notes.txt');
  assert.equal(fs.existsSync(path.dirname(localPath)), false);

  const result = containDownload(localPath, filesDir);

  assert.equal(result.contained, false);
}));

test('both downloadFileTo sites call containDownload', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'job-agent.js'), 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const slices = code.split('downloadFileTo(');
  assert.equal(slices.length - 1, 2, 'hire-time and downloadNewFiles are the two download sites');
  for (let i = 1; i < slices.length; i++) {
    assert.ok(
      slices[i].includes('containDownload('),
      `downloadFileTo site ${i} must call containDownload before the next statement`,
    );
  }
  const calls = code.match(/containDownload\(/g) || [];
  assert.equal(calls.length, 3, `definition + two call sites, found ${calls.length}`);
});
