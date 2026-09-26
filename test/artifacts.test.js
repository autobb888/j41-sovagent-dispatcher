'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { planArtifacts, fetchArtifacts, safeBasename, classifyArtifactJob } = require('../src/artifacts');

test('gpu rental has no file package', () => {
  const plan = planArtifacts({ status: 'delivered', serviceType: 'gpu-rental', delivery: { message: 'up' } }, []);
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'ARTIFACTS_NONE_LEASE');
  assert.equal(plan.sealed, false);
});

test('dataset points at data-open', () => {
  const plan = planArtifacts({ status: 'delivered', serviceType: 'dataset' }, []);
  assert.equal(plan.code, 'ARTIFACTS_DATASET_USE_DATA_OPEN');
});

test('paused with nothing is not ready', () => {
  const plan = planArtifacts({ status: 'paused', delivery: null }, []);
  assert.equal(plan.code, 'ARTIFACTS_NOT_READY');
});

test('buyer inputs before delivery are not the package', () => {
  const plan = planArtifacts(
    { status: 'in_progress', delivery: null },
    [{ id: 'f1', filename: 'brief.zip', checksum: 'aa' }],
  );
  assert.equal(plan.code, 'ARTIFACTS_NOT_READY');
});

test('a dataset is recognized from datasetTerms', () => {
  const plan = planArtifacts({ status: 'delivered', datasetTerms: { rows: 1 } }, []);
  assert.equal(plan.code, 'ARTIFACTS_DATASET_USE_DATA_OPEN');
});

test('a compute listing is a rental, including a service-id lookup', async () => {
  const plan = planArtifacts({ status: 'delivered', kind: 'compute', delivery: { message: 'up' } }, []);
  assert.equal(plan.code, 'ARTIFACTS_NONE_LEASE');
  const kind = await classifyArtifactJob(
    { status: 'delivered', serviceId: 'svc-1' },
    { getService: async () => ({ serviceType: 'gpu-rental' }) },
  );
  assert.equal(kind.gpu, true);
  assert.equal(kind.dataset, false);
});

test('delivered with only a notice is still a package', () => {
  const plan = planArtifacts({ status: 'delivered', delivery: { message: 'pong', hash: 'ab' } }, []);
  assert.equal(plan.ok, true);
  assert.equal(plan.notice, 'pong');
});

test('delivered with nothing is empty', () => {
  const plan = planArtifacts({ status: 'delivered', delivery: { message: '', hash: 'ab' } }, []);
  assert.equal(plan.code, 'ARTIFACTS_EMPTY');
});

test('file names stay inside --out', () => {
  assert.equal(safeBasename('../../etc/passwd'), 'passwd');
  assert.throws(() => safeBasename('..'), /leaves --out/);
});

test('a delivery zip is unpacked next to the archive', async () => {
  const { buildDeliveryPackage } = require('../src/delivery-package');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-art-'));
  const pkg = buildDeliveryPackage('finished', [{ name: 'drawings/part.dwg', data: Buffer.from('cad') }]);
  const result = await fetchArtifacts({
    job: { id: 'job-1', status: 'delivered', serviceType: 'agent', delivery: { message: pkg.notice, hash: pkg.hash } },
    files: [{ id: 'f1', filename: 'delivery.zip', checksum: pkg.hash }],
    outDir: dir,
    downloadFile: async () => ({ data: pkg.body, filename: 'delivery.zip', checksum: pkg.hash }),
  });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'answer.txt'), 'utf8'), 'finished');
  assert.equal(fs.readFileSync(path.join(dir, 'drawings', 'part.dwg'), 'utf8'), 'cad');
  assert.equal(fs.readFileSync(path.join(dir, 'delivery.zip')).length, pkg.body.length);
  fs.rmSync(dir, { recursive: true });
});

test('fetch writes the file and the notice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-art-'));
  const body = Buffer.from('finished work');
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const result = await fetchArtifacts({
    job: { id: 'job-1', status: 'delivered', serviceType: 'agent', delivery: { message: 'see file', hash: sha } },
    files: [{ id: 'f1', filename: 'delivery.txt', checksum: sha }],
    outDir: dir,
    downloadFile: async () => ({ data: body, filename: 'delivery.txt', checksum: sha }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.sealed, false);
  assert.equal(result.artifactsVersion, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'delivery.txt'), 'utf8'), 'finished work');
  assert.equal(fs.readFileSync(path.join(dir, 'notice.txt'), 'utf8'), 'see file');
  assert.equal(result.files[0].sha256, sha);
  fs.rmSync(dir, { recursive: true });
});

test('a file that is not the signed package is not downloaded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-art-'));
  const result = await fetchArtifacts({
    job: { id: 'job-1', status: 'delivered', serviceType: 'agent', delivery: { message: 'see file', hash: 'ab' } },
    files: [{ id: 'buyer', filename: 'brief.zip', checksum: '00' }],
    outDir: dir,
    downloadFile: async () => { throw new Error('should not download'); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.files.length, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'notice.txt'), 'utf8'), 'see file');
  assert.equal(fs.existsSync(path.join(dir, 'brief.zip')), false);
  fs.rmSync(dir, { recursive: true });
});

test('checksum mismatch refuses the write and leaves no zip', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-art-'));
  const claimed = 'ab'.repeat(32);
  await assert.rejects(
    () => fetchArtifacts({
      job: { id: 'job-1', status: 'delivered', delivery: { message: 'n', hash: claimed } },
      files: [{ id: 'f1', filename: 'delivery.zip', checksum: claimed }],
      outDir: dir,
      downloadFile: async () => ({ data: Buffer.from('nope'), filename: 'delivery.zip', checksum: claimed }),
    }),
    (err) => err.code === 'ARTIFACTS_BAD_HASH',
  );
  assert.equal(fs.existsSync(path.join(dir, 'delivery.zip')), false);
  fs.rmSync(dir, { recursive: true });
});

test('a zip whose central directory lies is not left on disk', async () => {
  const { buildDeliveryPackage, readStoredZip } = require('../src/delivery-package');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-art-'));
  const pkg = buildDeliveryPackage('finished');
  const flipped = Buffer.from(pkg.body);
  const central = flipped.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  flipped.writeUInt16LE(8, central + 10);
  assert.throws(() => readStoredZip(flipped));
  const hash = crypto.createHash('sha256').update(flipped).digest('hex');
  await assert.rejects(
    () => fetchArtifacts({
      job: { id: 'job-1', status: 'delivered', delivery: { message: 'n', hash } },
      files: [{ id: 'f1', filename: 'delivery.zip', checksum: hash }],
      outDir: dir,
      downloadFile: async () => ({ data: flipped, filename: 'delivery.zip', checksum: hash }),
    }),
    (err) => err.code === 'PACKAGE_BAD_ZIP',
  );
  assert.equal(fs.existsSync(path.join(dir, 'delivery.zip')), false);
  fs.rmSync(dir, { recursive: true });
});
