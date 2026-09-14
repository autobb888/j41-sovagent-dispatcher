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

test('both downloadFileTo sites call containDownload', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'job-agent.js'), 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const downloads = code.match(/downloadFileTo\(/g) || [];
  assert.equal(downloads.length, 2, 'hire-time and downloadNewFiles are the two download sites');
  const calls = code.match(/containDownload\(/g) || [];
  // definition + two call sites
  assert.ok(calls.length >= 3, `containDownload must wrap both downloads, found ${calls.length}`);
});
