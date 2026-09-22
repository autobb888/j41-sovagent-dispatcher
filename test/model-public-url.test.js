'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { listingPublicUrlStale, livePublicUrlFields } = require('../src/model-public-url');
const { CHAT_ABORT_MS } = require('../src/executors/local-llm');

test('listing is stale when website or endpoint host is not the live tunnel', () => {
  const live = 'https://cached-informational-abraham-proceeding.trycloudflare.com';
  assert.equal(listingPublicUrlStale({
    website: 'https://doctors-intake-speakers-light.trycloudflare.com',
    endpoints: [{ url: 'https://doctors-intake-speakers-light.trycloudflare.com' }],
  }, live), true);
  assert.equal(listingPublicUrlStale({
    website: live,
    endpoints: [{ url: live + '/j41/proxy/v1' }],
  }, live), false);
  assert.equal(listingPublicUrlStale({}, live), true);
});

test('live public URL fields replace website and network endpoints together', () => {
  const fields = livePublicUrlFields('https://live.example/');
  assert.equal(fields.profileWebsite, 'https://live.example');
  assert.deepEqual(JSON.parse(fields.networkEndpoints), ['https://live.example']);
});

test('start publishes a model listing when the chain host is not the live tunnel', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  assert.match(src, /a\.kind === 'model'/);
  assert.match(src, /listingPublicUrlStale\(published, webhookUrl\)/);
  assert.match(src, /livePublicUrlFields\(webhookUrl\)/);
});

test('labour NVIDIA abort waits past Kimi time-to-first-byte', () => {
  assert.equal(CHAT_ABORT_MS, 120000);
  const src = fs.readFileSync(path.join(__dirname, '../src/executors/local-llm.js'), 'utf8');
  assert.match(src, /setTimeout\(\(\) => controller\.abort\(\), CHAT_ABORT_MS\)/);
  assert.doesNotMatch(src, /controller\.abort\(\), 60000\)/);
});
