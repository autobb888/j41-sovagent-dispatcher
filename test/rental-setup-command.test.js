'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { assertRentalEligibleAgent } = require('../src/rental-job');

// Extracted setup-time checks live next to the command. Prefer a small
// src/rental-setup.js so cli.js stays glue.
const { assertRentalSetupAllowed } = require('../src/rental-setup');

test('rental-setup refuses api-endpoint mix', () => {
  assert.throws(() => assertRentalEligibleAgent([{ serviceType: 'api-endpoint' }]), /RENTAL_SLOT_CONFLICT/);
});

test('rental-setup fails closed without a TCP-tunnel hostname on home-gpu', () => {
  const cfg = { compute: { enabled: true, providers: { card0: { type: 'home-gpu', agent_id: 'gpu-1' } } } };
  assert.throws(() => assertRentalSetupAllowed({ agentId: 'gpu-1', cfg, services: [], paymentTerms: 'prepay' }), /HOME_GPU_NO_TUNNEL/);
});

test('rental-setup refuses local provider (canSsh false)', () => {
  const cfg = { compute: { enabled: true, providers: { w: { type: 'local', agent_id: 'gpu-1', base_url: 'http://127.0.0.1:8000/v1' } } } };
  assert.throws(() => assertRentalSetupAllowed({ agentId: 'gpu-1', cfg, services: [], paymentTerms: 'prepay' }), /RENTAL_NO_SSH/);
});

test('vast + postpay without ack fails closed', () => {
  const cfg = { compute: { enabled: true, max_usd_per_hour: 1, providers: { cloud: { type: 'vast', agent_id: 'gpu-1', api_key: 'k' } } } };
  assert.throws(
    () => assertRentalSetupAllowed({ agentId: 'gpu-1', cfg, services: [], paymentTerms: 'postpay', ackPostpayVastRisk: false }),
    /VAST_POSTPAY_UNACKED/,
  );
});

test('vast + postpay with ack is allowed (disclosed Alice risk)', () => {
  const cfg = { compute: { enabled: true, max_usd_per_hour: 1, providers: { cloud: { type: 'vast', agent_id: 'gpu-1', api_key: 'k' } } } };
  assert.doesNotThrow(() => assertRentalSetupAllowed({ agentId: 'gpu-1', cfg, services: [], paymentTerms: 'postpay', ackPostpayVastRisk: true }));
});

const {
  rentalServiceDescription,
  applyRentalAgentConfig,
  slotServicesFromAgentConfig,
} = require('../src/rental-setup');

test('rental-setup fails closed without a provider bound to this agent', () => {
  const cfg = { compute: { enabled: true, providers: {} } };
  assert.throws(
    () => assertRentalSetupAllowed({ agentId: 'gpu-1', cfg, services: [], paymentTerms: 'prepay' }),
    /RENTAL_NO_PROVIDER/,
  );
});

test('rentalServiceDescription is all-or-nothing and discloses Vast postpay risk only when acked', () => {
  const d = rentalServiceDescription({ jobTimeoutMin: 60, paymentTerms: 'prepay' });
  assert.match(d, /all-or-nothing/);
  assert.match(d, /60 minutes/);
  assert.equal(/Vast/i.test(d), false);
  const v = rentalServiceDescription({ jobTimeoutMin: 45, paymentTerms: 'postpay', vastPostpayAck: true });
  assert.match(v, /45 minutes/);
  assert.match(v, /Vast\.ai/);
});

test('applyRentalAgentConfig persists rentalAckPostpayVastRisk when the ack flag is passed', () => {
  const patched = applyRentalAgentConfig({ foo: 1 }, { ackPostpayVastRisk: true });
  assert.equal(patched.rental, true);
  assert.equal(patched.serviceType, 'gpu-rental');
  assert.equal(patched.rentalAckPostpayVastRisk, true);
  assert.equal(patched.foo, 1);
  const noAck = applyRentalAgentConfig({}, { ackPostpayVastRisk: false });
  assert.equal(noAck.rentalAckPostpayVastRisk, undefined);
});

test('slotServicesFromAgentConfig reconstructs the slot-guard input', () => {
  assert.deepEqual(slotServicesFromAgentConfig({ serviceType: 'gpu-rental' }), [{ serviceType: 'gpu-rental' }]);
  assert.deepEqual(slotServicesFromAgentConfig({ rental: true }), [{ serviceType: 'gpu-rental' }]);
  assert.deepEqual(slotServicesFromAgentConfig({ apiEndpointUrl: 'http://127.0.0.1:11434/v1' }), [{ serviceType: 'api-endpoint' }]);
  assert.deepEqual(slotServicesFromAgentConfig({}), []);
});

test('cli.js registers rental-setup and wires the reverse api-setup guard', () => {
  const cli = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
  const setupSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'rental-setup.js'), 'utf8');
  assert.match(cli, /\.command\('rental-setup <agent-id>'\)/);
  assert.match(cli, /serviceType:\s*'gpu-rental'/);
  assert.match(cli, /--ack-postpay-vast-risk/);
  assert.match(setupSrc, /rentalAckPostpayVastRisk/);
  const apiStart = cli.indexOf(".command('api-setup <agent-id>')");
  const apiEnd = cli.indexOf('\n  .command(', apiStart + 1);
  const apiBlock = cli.slice(apiStart, apiEnd === -1 ? apiStart + 4000 : apiEnd);
  assert.match(apiBlock, /assertApiEligibleAgent/);
});
