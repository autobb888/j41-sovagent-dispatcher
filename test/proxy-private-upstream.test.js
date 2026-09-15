'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkUpstreamHostSafe, makePinnedLookup, applyUpstreamModelAlias, applyUpstreamThinkingDefault } = require('../src/proxy-handler');

const cfgGuardOn = { runtime: { allow_local_upstream: false } };

test('private IP is rejected by default (guard intact)', async () => {
  const r = await checkUpstreamHostSafe('192.168.1.50', cfgGuardOn);
  assert.equal(r.safe, false);
});

test('private IP is permitted with per-lease allowPrivate, WITHOUT the global flag', async () => {
  const r = await checkUpstreamHostSafe('192.168.1.50', cfgGuardOn, true);
  assert.equal(r.safe, true);
});

test('public IP is unaffected by allowPrivate=false', async () => {
  const r = await checkUpstreamHostSafe('1.1.1.1', cfgGuardOn, false);
  assert.equal(r.safe, true);
});

test('the global flag still opens the guard (unchanged)', async () => {
  const r = await checkUpstreamHostSafe('192.168.1.50', { runtime: { allow_local_upstream: true } });
  assert.equal(r.safe, true);
});

test('makePinnedLookup honors { all: true } with address objects (Node 22)', () => {
  const lookup = makePinnedLookup('1.2.3.4');
  let got;
  lookup('example.com', { all: true }, (err, addrs) => {
    assert.equal(err, null);
    got = addrs;
  });
  assert.deepEqual(got, [{ address: '1.2.3.4', family: 4 }]);
  lookup('example.com', {}, (err, addr, family) => {
    assert.equal(err, null);
    assert.equal(addr, '1.2.3.4');
    assert.equal(family, 4);
  });
});

test('proxy chat completions uses undici HTTP/1.1 (NVIDIA hangs Node https/h2)', () => {
  const src = require('fs').readFileSync(require.resolve('../src/proxy-handler.js'), 'utf8');
  assert.match(src, /allowH2:\s*false/);
  assert.match(src, /http1Fetch/);
  assert.doesNotMatch(src, /transport\.request/);
});

test('applyUpstreamModelAlias rewrites grant Pro to Flash before forward', () => {
  const body = { model: 'deepseek-ai/deepseek-v4-pro-0813', messages: [] };
  applyUpstreamModelAlias(body, {
    upstreamModelAlias: {
      'deepseek-ai/deepseek-v4-pro-0813': 'deepseek-ai/deepseek-v4-flash-0731',
    },
  });
  assert.equal(body.model, 'deepseek-ai/deepseek-v4-flash-0731');
});

test('NVIDIA integrate injects thinking:false when the buyer omitted it', () => {
  const body = { model: 'deepseek-ai/deepseek-v4-flash-0731', messages: [] };
  applyUpstreamThinkingDefault(body, { endpointUrl: 'https://integrate.api.nvidia.com/v1' });
  assert.equal(body.chat_template_kwargs.thinking, false);
  assert.equal(body.chat_template_kwargs.reasoning_effort, 'low');
});

test('NVIDIA thinking default does not override a buyer who opted in', () => {
  const body = {
    model: 'deepseek-ai/deepseek-v4-flash-0731',
    chat_template_kwargs: { thinking: true, reasoning_effort: 'high' },
  };
  applyUpstreamThinkingDefault(body, { endpointUrl: 'https://integrate.api.nvidia.com/v1' });
  assert.equal(body.chat_template_kwargs.thinking, true);
  assert.equal(body.chat_template_kwargs.reasoning_effort, 'high');
});

test('loopback sellers do not get NVIDIA thinking kwargs', () => {
  const body = { model: 'gpt-4', messages: [] };
  applyUpstreamThinkingDefault(body, { endpointUrl: 'http://127.0.0.1:9/v1' });
  assert.equal(body.chat_template_kwargs, undefined);
});
