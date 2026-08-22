'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  tableNameForAgent,
  providerBoundToAgent,
  homeGpuProviderPartial,
  vastProviderPartial,
} = require('../src/compute-provider-write');

test('tableNameForAgent reuses the existing table for the same agent_id', () => {
  assert.equal(tableNameForAgent('gpu-1', { card0: { agent_id: 'gpu-1' } }), 'card0');
  assert.equal(tableNameForAgent('gpu-2', { gpu_1: { agent_id: 'gpu-1' } }), 'gpu_2');
});

test('home-gpu partial enables compute and refuses 0.0.0.0 / loopback', () => {
  const { tableName, partial } = homeGpuProviderPartial('gpu-1', {
    ssh_hostname: 'gpu.example.com',
    ssh_tunnel_port: 2222,
    memory_mb: 4096,
    disk_gb: 10,
    gpu: 'RTX 5090',
  }, {});
  assert.equal(tableName, 'gpu_1');
  assert.equal(partial.compute.enabled, true);
  assert.equal(partial.compute.providers.gpu_1.type, 'home-gpu');
  assert.equal(partial.compute.providers.gpu_1.agent_id, 'gpu-1');
  assert.equal(partial.compute.providers.gpu_1.ssh_hostname, 'gpu.example.com');
  assert.throws(
    () => homeGpuProviderPartial('gpu-1', { ssh_hostname: '0.0.0.0', ssh_tunnel_port: 2222, memory_mb: 4096, disk_gb: 10 }, {}),
    /HOME_GPU_NO_TUNNEL/,
  );
  assert.throws(
    () => homeGpuProviderPartial('gpu-1', { ssh_hostname: '127.0.0.1', ssh_tunnel_port: 2222, memory_mb: 4096, disk_gb: 10 }, {}),
    /HOME_GPU_NO_TUNNEL/,
  );
});

test('vast partial is Cat-1 (interruptible false) and requires api_key', () => {
  const { partial } = vastProviderPartial('gpu-1', { api_key: 'vast-x', min_vram_gb: 24, max_usd_per_hour: 2 }, {});
  assert.equal(partial.compute.providers.gpu_1.type, 'vast');
  assert.equal(partial.compute.providers.gpu_1.interruptible, false);
  assert.equal(partial.compute.max_usd_per_hour, 2);
  assert.throws(() => vastProviderPartial('gpu-1', { min_vram_gb: 24 }, {}), /VAST_NO_KEY/);
});

test('providerBoundToAgent finds the table', () => {
  const bound = providerBoundToAgent({ card0: { type: 'home-gpu', agent_id: 'gpu-1' } }, 'gpu-1');
  assert.equal(bound[0], 'card0');
  assert.equal(providerBoundToAgent({ card0: { agent_id: 'other' } }, 'gpu-1'), null);
});

test('TUI signup writes the provider instead of telling the operator to paste the recipe', () => {
  const dash = fs.readFileSync(path.join(__dirname, '../src/dashboard.js'), 'utf8');
  assert.match(dash, /computeProviderScreen/);
  assert.match(dash, /homeGpuProviderPartial/);
  assert.doesNotMatch(dash, /PASTE RECIPE/);
  assert.match(dash, /Do not reuse a working agent name for a GPU box/);
});
