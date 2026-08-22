'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertRentalEligibleAgent, assertApiEligibleAgent } = require('../src/rental-job');

// Pins the separate-agent-slots contract that rental-setup (and api-setup) enforce:
// an agent may not carry both a gpu-rental and an api-endpoint service, because the
// mixed-service _isApiEndpoint stamping (cli.js) would misclassify one of them.
test('rental-setup guard blocks mixing rental onto an api-endpoint agent', () => {
  assert.throws(() => assertRentalEligibleAgent([{ serviceType: 'api-endpoint', name: 'inference' }]), /RENTAL_SLOT_CONFLICT/);
});

test('rental-setup guard allows a clean agent', () => {
  assert.doesNotThrow(() => assertRentalEligibleAgent([{ serviceType: 'chat' }]));
  assert.doesNotThrow(() => assertRentalEligibleAgent([]));
});

test('api-setup guard (reverse) blocks mixing an api endpoint onto a rental agent', () => {
  assert.throws(() => assertApiEligibleAgent([{ serviceType: 'gpu-rental', name: 'a100' }]), /API_SLOT_CONFLICT/);
});
