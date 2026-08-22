'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalRentalDeliverable, hashRentalDeliverable, noticeRentalDeliverable, deliverSealed } = require('../src/rental-delivery');

const d = {
  ssh: { host: 'gpu.example.com', port: 2222, user: 'renter', password: 's3cret' },
  expiresAt: 1755500000000,
  disclosure: 'all-or-nothing',
};

test('notice and deliverJob payload never contain SSH secrets', async () => {
  const notice = noticeRentalDeliverable(d);
  assert.match(notice, /1755500000000|all-or-nothing/);
  assert.doesNotMatch(notice, /s3cret|gpu\.example\.com/);
  const calls = { secret: null, deliver: null };
  const client = {
    async postRentalSecret(jobId, body) { calls.secret = { jobId, body }; },
    async deliverJob(jobId, hash, sig, ts, message) { calls.deliver = { jobId, hash, message }; },
  };
  await deliverSealed({
    client,
    signDeliver: ({ hash }) => ({ signature: 'sig', timestamp: 1, hash }),
    job: { id: 'job-1', jobHash: 'abcd' },
    deliverable: d,
  });
  assert.equal(calls.secret.body.ssh.password, 's3cret'); // sealed endpoint gets the real creds
  assert.doesNotMatch(calls.deliver.message, /s3cret|gpu\.example\.com/);
  assert.equal(calls.deliver.hash, hashRentalDeliverable(d));
});

test('canonical form is key-sorted and hashes stably', () => {
  const a = canonicalRentalDeliverable(d);
  const b = canonicalRentalDeliverable({
    disclosure: 'all-or-nothing',
    expiresAt: 1755500000000,
    ssh: { password: 's3cret', user: 'renter', port: 2222, host: 'gpu.example.com' },
  });
  assert.equal(a, b);
  assert.match(a, /"password":"s3cret"/);
  assert.equal(hashRentalDeliverable(d), hashRentalDeliverable({
    ssh: { host: 'gpu.example.com', port: 2222, user: 'renter', password: 's3cret' },
    disclosure: 'all-or-nothing',
    expiresAt: 1755500000000,
  }));
  assert.match(hashRentalDeliverable(d), /^[a-f0-9]{64}$/);
});

test('deliverSealed fails closed when rental-secret cannot be posted', async () => {
  let delivered = false;
  await assert.rejects(
    () => deliverSealed({
      client: {
        async deliverJob() { delivered = true; },
      },
      signDeliver: ({ hash }) => ({ signature: 'sig', timestamp: 1, hash }),
      job: { id: 'job-1', jobHash: 'abcd' },
      deliverable: d,
    }),
    /RENTAL_SECRET_FAILED/,
  );
  assert.equal(delivered, false);
});

test('deliverSealed does not call deliverJob when postRentalSecret throws', async () => {
  let delivered = false;
  await assert.rejects(
    () => deliverSealed({
      client: {
        async postRentalSecret() { throw new Error('seal refused'); },
        async deliverJob() { delivered = true; },
      },
      signDeliver: ({ hash }) => ({ signature: 'sig', timestamp: 1, hash }),
      job: { id: 'job-1', jobHash: 'abcd' },
      deliverable: d,
    }),
    /seal refused/,
  );
  assert.equal(delivered, false);
});
