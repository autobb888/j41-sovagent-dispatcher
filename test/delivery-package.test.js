'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  buildDeliveryPackage, readStoredZip, listOutputFiles, packageIdsToReplace, LONG_NOTICE, MAX_PACKAGE_BYTES,
} = require('../src/delivery-package');

test('a text answer becomes a zip a normal unzipper can open', () => {
  const pkg = buildDeliveryPackage('The answer is 41.');
  assert.equal(pkg.upload, true);
  assert.equal(pkg.tooBig, false);
  assert.equal(pkg.sealed, false);
  assert.equal(pkg.filename, 'delivery.zip');
  assert.equal(pkg.notice, LONG_NOTICE);
  assert.equal(pkg.body.readUInt32LE(0), 0x04034b50);
  assert.equal(pkg.hash, crypto.createHash('sha256').update(pkg.body).digest('hex'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-zip-'));
  const zipPath = path.join(dir, 'delivery.zip');
  fs.writeFileSync(zipPath, pkg.body);
  const unzipped = execFileSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); sys.stdout.write(z.read("answer.txt").decode())', zipPath], { encoding: 'utf8' });
  assert.equal(unzipped, 'The answer is 41.');
  const entries = readStoredZip(pkg.body);
  assert.equal(entries[0].name, 'answer.txt');
  assert.equal(entries[0].data.toString(), 'The answer is 41.');
  fs.rmSync(dir, { recursive: true });
});

test('out/ files ride inside the same zip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-out-'));
  fs.mkdirSync(path.join(dir, 'drawings'));
  fs.writeFileSync(path.join(dir, 'drawings', 'part.dwg'), Buffer.from('cad-bytes'));
  const pkg = buildDeliveryPackage('see the drawing', listOutputFiles(dir));
  const names = readStoredZip(pkg.body).map((entry) => entry.name).sort();
  assert.deepEqual(names, ['answer.txt', 'drawings/part.dwg']);
  fs.rmSync(dir, { recursive: true });
});

test('a missing out directory is an empty file list', () => {
  assert.deepEqual(listOutputFiles(path.join(os.tmpdir(), 'j41-no-such-out')), []);
});

test('empty content and no files is not a package', () => {
  const pkg = buildDeliveryPackage('');
  assert.equal(pkg.upload, false);
  assert.equal(pkg.hash, null);
});

test('over 25MB is refused instead of truncated', () => {
  const pkg = buildDeliveryPackage('', [{ name: 'big.bin', data: Buffer.alloc(MAX_PACKAGE_BYTES + 1) }]);
  assert.equal(pkg.tooBig, true);
  assert.equal(pkg.upload, false);
});

test('zip entries cannot climb out of the archive', () => {
  assert.throws(() => buildDeliveryPackage('', [{ name: '../secret', data: Buffer.from('x') }]), (err) => err.code === 'PACKAGE_BAD_NAME');
});

test('a symlink at out/ is not packaged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-out-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-secret-'));
  fs.writeFileSync(path.join(outside, 'canary.token'), 'secret-token');
  const link = path.join(dir, 'out');
  fs.symlinkSync(outside, link);
  assert.deepEqual(listOutputFiles(link, { boundary: dir }), []);
  fs.rmSync(dir, { recursive: true });
  fs.rmSync(outside, { recursive: true });
});

test('a symlink inside out/ is skipped and canary bytes are redacted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-out-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-secret-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  fs.writeFileSync(path.join(dir, 'note.txt'), 'hello TOKEN world');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'evil.txt'));
  const names = listOutputFiles(dir, { boundary: path.dirname(dir), canary: 'TOKEN' }).map((file) => file.name);
  assert.deepEqual(names, ['note.txt']);
  const note = listOutputFiles(dir, { canary: 'TOKEN' })[0];
  assert.equal(note.data.toString(), 'hello [redacted] world');
  fs.rmSync(dir, { recursive: true });
  fs.rmSync(outside, { recursive: true });
});

test('an oversized out tree is refused before the files are read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-out-'));
  fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(32));
  assert.throws(() => listOutputFiles(dir, { maxBytes: 8 }), (err) => err.code === 'PACKAGE_TOO_LARGE');
  fs.rmSync(dir, { recursive: true });
});

test('a central-directory lie and a data descriptor are rejected', () => {
  const pkg = buildDeliveryPackage('hi');
  const flipped = Buffer.from(pkg.body);
  const central = flipped.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central > 0);
  flipped.writeUInt16LE(8, central + 10);
  assert.throws(() => readStoredZip(flipped), (err) => err.code === 'PACKAGE_BAD_ZIP');
  const described = Buffer.from(pkg.body);
  described.writeUInt16LE(described.readUInt16LE(6) | 0x0008, 6);
  assert.throws(() => readStoredZip(described), (err) => err.code === 'PACKAGE_BAD_ZIP');
});

test('canary bytes in the answer are redacted before the zip is hashed', () => {
  const pkg = buildDeliveryPackage('see TOKEN', [], { canary: 'TOKEN' });
  const answer = readStoredZip(pkg.body).find((entry) => entry.name === 'answer.txt');
  assert.equal(answer.data.toString(), 'see [redacted]');
  assert.equal(pkg.hash, crypto.createHash('sha256').update(pkg.body).digest('hex'));
});

test('only a different delivery.zip id is replaced', () => {
  assert.deepEqual(
    packageIdsToReplace(
      [{ id: 'old', filename: 'delivery.zip' }, { id: 'new', filename: 'delivery.zip' }, { id: 'in', filename: 'brief.txt' }],
      'delivery.zip',
      { id: 'new' },
    ),
    ['old'],
  );
  assert.deepEqual(packageIdsToReplace([{ id: 'new', filename: 'delivery.zip' }], 'delivery.zip', {}), []);
});
