'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseRentalPeriod,
  rentalPeriodMinOf,
  formatRentalPeriod,
  periodMinFromTurnaround,
  planRentalServiceWrite,
} = require('../src/rental-period');

test('4 hours on the listing is 240 minutes', () => {
  const parsed = parseRentalPeriod({ hours: '4' });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.minutes, 240);
  assert.equal(formatRentalPeriod(240), '4 hours');
  assert.equal(periodMinFromTurnaround('4 hours'), 240);
  assert.equal(periodMinFromTurnaround('4 hour'), 240);
});

test('minutes that are not a whole hour stay minutes', () => {
  assert.equal(parseRentalPeriod({ minutes: '90' }).minutes, 90);
  assert.equal(formatRentalPeriod(90), '90 minutes');
  assert.equal(periodMinFromTurnaround('90 minutes'), 90);
  assert.equal(formatRentalPeriod(60), '1 hour');
  assert.equal(periodMinFromTurnaround('1 hour'), 60);
  assert.equal(periodMinFromTurnaround('240'), 240);
});

test('a listing period refuses both units, zero, fractions, and a labour-timeout stand-in', () => {
  assert.equal(parseRentalPeriod({ hours: '4', minutes: '30' }).ok, false);
  assert.equal(parseRentalPeriod({}).ok, false);
  assert.equal(parseRentalPeriod({ hours: '0' }).ok, false);
  assert.equal(parseRentalPeriod({ hours: '4.5' }).ok, false);
  assert.equal(parseRentalPeriod({ minutes: '10081' }).ok, false);
  assert.equal(parseRentalPeriod({ hours: '169' }).ok, false);
  assert.equal(rentalPeriodMinOf({}), null);
  assert.equal(rentalPeriodMinOf({ rentalPeriodMin: 60 }), 60);
  assert.equal(rentalPeriodMinOf({ rentalPeriodMin: 60.5 }), null);
  assert.equal(periodMinFromTurnaround('soon'), null);
  assert.equal(periodMinFromTurnaround(''), null);
});

test('an existing GPU card is updated instead of registering a second one', () => {
  const update = planRentalServiceWrite({
    services: [{ id: 'svc-1', serviceType: 'gpu-rental', status: 'active' }],
    description: 'Runs up to 4 hours.',
    turnaround: '4 hours',
    price: 0.001,
  });
  assert.equal(update.action, 'update');
  assert.deepEqual(update.updates, [{
    id: 'svc-1',
    body: { description: 'Runs up to 4 hours.', turnaround: '4 hours', price: 0.001 },
  }]);
  const fresh = planRentalServiceWrite({
    services: [],
    description: 'Runs up to 4 hours.',
    turnaround: '4 hours',
    price: 0.001,
    paymentTerms: 'prepay',
  });
  assert.equal(fresh.action, 'register');
  assert.equal(fresh.body.serviceType, 'gpu-rental');
  assert.equal(fresh.body.turnaround, '4 hours');
});
