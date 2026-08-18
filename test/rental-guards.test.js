'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertRentalEligibleAgent, assertApiEligibleAgent, assertProviderCanSsh, formatRentalDeliverable } = require('../src/rental-job');

test('assertRentalEligibleAgent rejects an agent that already has an api-endpoint service', () => {
  assert.throws(() => assertRentalEligibleAgent([{ serviceType: 'api-endpoint' }]), /RENTAL_SLOT_CONFLICT/);
  assert.doesNotThrow(() => assertRentalEligibleAgent([{ serviceType: 'gpu-rental' }]));
  assert.doesNotThrow(() => assertRentalEligibleAgent([]));
});

test('assertApiEligibleAgent rejects an agent that already has a gpu-rental service', () => {
  assert.throws(() => assertApiEligibleAgent([{ serviceType: 'gpu-rental' }]), /API_SLOT_CONFLICT/);
});

test('assertProviderCanSsh hard-blocks a provider that cannot offer SSH', () => {
  assert.throws(() => assertProviderCanSsh({ capabilities: { canSsh: false } }), /RENTAL_NO_SSH/);
  assert.doesNotThrow(() => assertProviderCanSsh({ capabilities: { canSsh: true } }));
});

test('formatRentalDeliverable carries ssh, expiry, and the all-or-nothing disclosure', () => {
  const d = formatRentalDeliverable({ ssh: { host: '1.2.3.4', port: 22, user: 'root' }, expiresAt: 1755500000000 }, { jobTimeoutMin: 60 });
  assert.equal(d.ssh.host, '1.2.3.4');
  assert.equal(d.expiresAt, 1755500000000);
  assert.match(d.disclosure, /no pro-rata|all-or-nothing|not refundable/i);
});
