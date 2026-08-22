'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreOffers } = require('../src/providers/vast-offers');

const OFFERS = [
  { id: 1, gpu_name: 'RTX 3090', num_gpus: 1, gpu_ram: 24576, dph_total: 0.22, rentable: true, rented: false, geolocation: 'US' },
  { id: 2, gpu_name: 'RTX 4090', num_gpus: 1, gpu_ram: 24576, dph_total: 0.35, rentable: true, rented: false, geolocation: 'DE' },
  { id: 3, gpu_name: 'A100', num_gpus: 1, gpu_ram: 81920, dph_total: 1.2, rentable: true, rented: true, geolocation: 'US' },
  { id: 4, gpu_name: 'GTX 1080', num_gpus: 1, gpu_ram: 8192, dph_total: 0.05, rentable: true, rented: false, geolocation: 'US' },
];

test('scoreOffers filters unrentable/rented/too-small and sorts cheapest-first', () => {
  const cands = scoreOffers(OFFERS, { minVramGb: 24, maxUsdPerHour: 0.5, minGpuCount: 1 });
  assert.equal(cands.length, 2);
  assert.equal(cands[0].meta.askId, 1);
  assert.equal(cands[0].usdPerHour, 0.22);
  assert.equal(cands[0].gpu.vramGb, 24);
  assert.equal(cands[1].meta.askId, 2);
});

test('scoreOffers excludes offers over the ceiling', () => {
  const cands = scoreOffers(OFFERS, { minVramGb: 24, maxUsdPerHour: 0.30, minGpuCount: 1 });
  assert.deepEqual(cands.map((c) => c.meta.askId), [1]);
});

test('scoreOffers returns [] when nothing qualifies', () => {
  assert.deepEqual(scoreOffers(OFFERS, { minVramGb: 100, maxUsdPerHour: 5, minGpuCount: 1 }), []);
});
