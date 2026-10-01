'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { assertServicePrice, MIN_SERVICE_PRICE } = require('../src/service-price');

test('a price below 0.0001 is refused', () => {
  assert.equal(MIN_SERVICE_PRICE, 0.0001);
  for (const raw of [0, '0', -1, 0.00009, '', 'nope']) {
    assert.throws(() => assertServicePrice(raw), (err) => {
      assert.equal(err.code, 'SERVICE_PRICE_TOO_LOW');
      assert.match(err.message, /^SERVICE_PRICE_TOO_LOW: price must be at least 0\.0001/);
      return true;
    });
  }
  assert.equal(assertServicePrice(0.0001), 0.0001);
  assert.equal(assertServicePrice('1.25'), 1.25);
});

test('service-price checks the floor before --yes and updates the price field only', () => {
  const cli = fs.readFileSync('src/cli.js', 'utf8');
  const start = cli.indexOf(".command('service-price <agent-id> <service-id>')");
  const end = cli.indexOf(".command('data-setup <agent-id>')", start);
  assert.ok(start > 0 && end > start);
  const block = cli.slice(start, end);
  assert.match(block, /--price <amount>/);
  const check = block.indexOf('assertServicePrice(options.price)');
  const preview = block.indexOf('if (!options.yes)');
  const update = block.indexOf('updateService(serviceId, { price })');
  assert.ok(check > 0 && preview > check && update > preview);
  assert.equal(block.includes('acceptedCurrencies'), false);
});
