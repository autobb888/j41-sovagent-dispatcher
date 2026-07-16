'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const tb = require('../src/token-budget.js');

// isSelfHostedProvider
test('kimi-nvidia is self-hosted class', () => {
  assert.equal(tb.isSelfHostedProvider('kimi-nvidia', {}), true);
});
test('openai is NOT self-hosted class', () => {
  assert.equal(tb.isSelfHostedProvider('openai', {}), false);
});
test('J41_SELF_HOSTED_PROVIDERS env override adds a provider', () => {
  assert.equal(tb.isSelfHostedProvider('mycloud', { J41_SELF_HOSTED_PROVIDERS: 'mycloud,foo' }), true);
});

// unknownModelCost picks self-hosted-70b for a self-hosted provider, o3 otherwise
test('unknownModelCost → self-hosted-70b for kimi-nvidia', () => {
  const c = tb.unknownModelCost({ J41_LLM_PROVIDER: 'kimi-nvidia' });
  assert.equal(c.model, 'self-hosted-70b');
});
test('unknownModelCost → most-expensive (o3) for openai', () => {
  const c = tb.unknownModelCost({ J41_LLM_PROVIDER: 'openai' });
  assert.equal(c.model, 'o3');
});

// initialTokenBudget: unknown model + self-hosted provider ≫ conservative
test('unknown model on kimi-nvidia yields a much larger budget than on openai', () => {
  const args = { model: 'openai/gpt-oss-120b', amountVrsc: 100, spendFraction: 0.5 };
  const baseEnv = { J41_VRSC_USD_RATE: '0.01', J41_VRSC_USD_RATE_AT: Date.now().toString() };
  const selfHosted = tb.initialTokenBudget(args, { ...baseEnv, J41_LLM_PROVIDER: 'kimi-nvidia' });
  const metered   = tb.initialTokenBudget(args, { ...baseEnv, J41_LLM_PROVIDER: 'openai' });
  assert.match(selfHosted.basis, /priced-selfhosted:self-hosted-70b/);
  assert.match(metered.basis, /priced-conservative:o3/);
  assert.ok(selfHosted.tokens > metered.tokens * 5, `expected ≫ budget: ${selfHosted.tokens} vs ${metered.tokens}`);
});

// priceExtension basis parity (Task 1 review, Minor)
test('priceExtension basis: self-hosted vs conservative vs known', () => {
  const base = { model: 'openai/gpt-oss-120b', additionalTokens: 5000, markupPercent: 100 };
  const sh = tb.priceExtension(base, { J41_LLM_PROVIDER: 'kimi-nvidia' });
  assert.match(sh.basis, /priced-selfhosted:self-hosted-70b/);
  const met = tb.priceExtension(base, { J41_LLM_PROVIDER: 'openai' });
  assert.match(met.basis, /priced-conservative:o3/);
  const known = tb.priceExtension({ ...base, model: 'gpt-4.1' }, {});
  assert.match(known.basis, /^priced:gpt-4\.1/);
});
