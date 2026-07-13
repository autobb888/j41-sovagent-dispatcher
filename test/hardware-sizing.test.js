'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { computeMaxAgents, capacityLine, resolveCapacity, DEFAULTS } = require('../src/hardware-sizing.js');

const GB = 1024 * 1024 * 1024;

test('memory is the binding constraint on a RAM-poor box', () => {
  // 8GB, 8 cores, 2GB/container, reserve = max(2GB, 15% of 8GB=1.2GB)=2GB
  // memBound = floor((8-2)/2) = 3 ; cpuBound = 8-1 = 7 ; min = 3
  assert.strictEqual(computeMaxAgents({ totalMemBytes: 8 * GB, cpuCount: 8 }), 3);
});

test('cpu is the binding constraint on a RAM-rich box', () => {
  // 128GB, 4 cores. memBound huge; cpuBound = 4-1 = 3
  assert.strictEqual(computeMaxAgents({ totalMemBytes: 128 * GB, cpuCount: 4 }), 3);
});

test('never returns below 1 even on a tiny box', () => {
  assert.strictEqual(computeMaxAgents({ totalMemBytes: 2 * GB, cpuCount: 1 }), 1);
});

test('conservative reserve is at least 15% of total on large boxes', () => {
  // 256GB, 64 cores: reserve=max(2GB, 38.4GB)=38.4GB; memBound=floor((256-38.4)/2)=108; cpuBound=63; min=63
  assert.strictEqual(computeMaxAgents({ totalMemBytes: 256 * GB, cpuCount: 64 }), 63);
});

test('explicit per-container size changes the memory bound', () => {
  // 8GB, 8 cores, 1GB/container: reserve 2GB; memBound=floor(6/1)=6; cpuBound=7; min=6
  assert.strictEqual(computeMaxAgents({ totalMemBytes: 8 * GB, cpuCount: 8, perContainerMemBytes: GB }), 6);
});

test('capacityLine is human-readable and states the override', () => {
  const line = capacityLine({ totalMemBytes: 8 * GB, cpuCount: 8, maxAgents: 3, perContainerMemBytes: 2 * GB, hostReserveBytes: 2 * GB });
  assert.match(line, /8 GB/);
  assert.match(line, /8 cores/);
  assert.match(line, /3 agents/);
  assert.match(line, /max_concurrent/);
});

test('resolveCapacity: unset config (0) auto-follows the hardware estimate', () => {
  const r = resolveCapacity({ configMax: 0, estimate: 7 });
  assert.strictEqual(r.maxAgents, 7);
  assert.strictEqual(r.auto, true);
  assert.strictEqual(r.overridden, false);
  assert.strictEqual(r.estimate, 7);
});

test('resolveCapacity: undefined/missing config is treated as auto (not an override)', () => {
  const r = resolveCapacity({ configMax: undefined, estimate: 5 });
  assert.strictEqual(r.maxAgents, 5);
  assert.strictEqual(r.auto, true);
  assert.strictEqual(r.overridden, false);
});

test('resolveCapacity: explicit owner override above the estimate is honored', () => {
  const r = resolveCapacity({ configMax: 9, estimate: 7 });
  assert.strictEqual(r.maxAgents, 9);
  assert.strictEqual(r.auto, false);
  assert.strictEqual(r.overridden, true);
  assert.strictEqual(r.estimate, 7);
});

test('resolveCapacity: explicit override equal to the estimate still counts as owner-set', () => {
  const r = resolveCapacity({ configMax: 7, estimate: 7 });
  assert.strictEqual(r.maxAgents, 7);
  assert.strictEqual(r.overridden, true);
  assert.strictEqual(r.auto, false);
});

test('resolveCapacity: a negative/garbage configMax falls back to auto (never below estimate)', () => {
  const r = resolveCapacity({ configMax: -3, estimate: 4 });
  assert.strictEqual(r.maxAgents, 4);
  assert.strictEqual(r.auto, true);
});
