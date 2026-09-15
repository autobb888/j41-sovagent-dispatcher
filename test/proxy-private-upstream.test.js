'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkUpstreamHostSafe,
  makePinnedLookup,
  applyUpstreamModelAlias,
  applyUpstreamThinkingDefault,
  applyUpstreamNimStream,
  assembleSseChatCompletion,
} = require('../src/proxy-handler');

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

test('NVIDIA non-stream buyer is forwarded as SSE so headers are not held until CoT ends', () => {
  const body = { model: 'deepseek-ai/deepseek-v4-flash-0731', messages: [] };
  applyUpstreamNimStream(body, { endpointUrl: 'https://integrate.api.nvidia.com/v1' }, false);
  assert.equal(body.stream, true);
  assert.equal(body.stream_options.include_usage, true);
});

test('buyer who asked to stream is not rewritten by NVIDIA SSE inject', () => {
  const body = { model: 'deepseek-ai/deepseek-v4-flash-0731', stream: false };
  applyUpstreamNimStream(body, { endpointUrl: 'https://integrate.api.nvidia.com/v1' }, true);
  assert.equal(body.stream, false);
});

test('assembleSseChatCompletion promotes reasoning_content when content is empty', () => {
  const raw = [
    'data: {"id":"chatcmpl-x","model":"moonshotai/kimi-k3","choices":[{"delta":{"reasoning_content":"Ping"}}]}',
    'data: {"usage":{"prompt_tokens":2,"completion_tokens":1}}',
    'data: [DONE]',
  ].join('\n');
  const out = assembleSseChatCompletion(raw);
  assert.equal(out.choices[0].message.content, 'Ping');
  assert.equal(out.choices[0].message.reasoning_content, 'Ping');
  assert.equal(out.usage.completion_tokens, 1);
});
