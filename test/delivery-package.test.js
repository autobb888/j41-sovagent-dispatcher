'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  buildDeliveryPackage, readStoredZip, listOutputFiles, LONG_NOTICE, MAX_PACKAGE_BYTES,
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
