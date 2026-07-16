'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { probeLLM } = require('../src/llm-health.js');

const cfg = { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k', customHeaders: null };

test('ok:true on HTTP 200', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200 });
  const r = await probeLLM(cfg, { fetchImpl });
  assert.equal(r.ok, true); assert.equal(r.status, 200);
});

test('ok:false and fail-closed on HTTP 500', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  const r = await probeLLM(cfg, { fetchImpl });
  assert.equal(r.ok, false); assert.equal(r.status, 500);
});

test('ok:false on network throw', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const r = await probeLLM(cfg, { fetchImpl });
  assert.equal(r.ok, false); assert.match(r.error, /ECONNREFUSED/);
});

test('ok:false on timeout/abort', async () => {
  const fetchImpl = async (_u, o) => new Promise((_res, rej) => {
    o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const r = await probeLLM(cfg, { timeoutMs: 20, fetchImpl });
  assert.equal(r.ok, false);
});

test('sends minimal body (max_tokens:1) to /chat/completions with auth header', async () => {
  let seenUrl, seenBody, seenHeaders;
  const fetchImpl = async (u, o) => { seenUrl = u; seenBody = JSON.parse(o.body); seenHeaders = o.headers; return { ok: true, status: 200 }; };
  await probeLLM(cfg, { fetchImpl });
  assert.equal(seenUrl, 'https://x/v1/chat/completions');
  assert.equal(seenBody.max_tokens, 1);
  assert.equal(seenBody.model, 'm');
  assert.equal(seenHeaders.Authorization, 'Bearer k');
});

test('uses customHeaders when provided (no Authorization)', async () => {
  let seenHeaders;
  const fetchImpl = async (_u, o) => { seenHeaders = o.headers; return { ok: true, status: 200 }; };
  await probeLLM({ ...cfg, customHeaders: { 'x-api-key': 'z' } }, { fetchImpl });
  assert.equal(seenHeaders['x-api-key'], 'z');
  assert.equal(seenHeaders.Authorization, undefined);
});
