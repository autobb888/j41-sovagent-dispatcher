/**
 * WP-D4 fail-closed discipline: invalid input must produce the most
 * conservative answer (smallest budget, null price) — never unlimited,
 * never free, never a made-up number.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeModelId,
  getModelCost,
  mostExpensiveModelCost,
  getVrscUsdRate,
  vrscToUsd,
  initialTokenBudget,
  priceExtension,
  MIN_TOKEN_BUDGET,
  DEFAULT_FALLBACK_TOKEN_BUDGET,
} = require('../src/token-budget');

// A fresh env per test — the helpers read env explicitly so tests don't
// leak through process.env.
function envWithRate(rate, ageMs = 0, extra = {}) {
  return {
    J41_VRSC_USD_RATE: String(rate),
    J41_VRSC_USD_RATE_AT: String(Date.now() - ageMs),
    ...extra,
  };
}

// ── normalizeModelId ──

test('normalizeModelId strips provider prefixes and maps aliases', () => {
  assert.equal(normalizeModelId('anthropic/claude-sonnet-4-6'), 'claude-sonnet-4.6');
  assert.equal(normalizeModelId('anthropic/claude-opus-4-6'), 'claude-opus-4.6');
  assert.equal(normalizeModelId('moonshotai/kimi-k2.5'), 'kimi-k2');
  assert.equal(normalizeModelId('deepseek-chat'), 'deepseek-v3');
  assert.equal(normalizeModelId('mistral-large-latest'), 'mistral-large-3');
  assert.equal(normalizeModelId('grok-4'), 'grok-4.20');
});

test('normalizeModelId passes through exact table ids', () => {
  assert.equal(normalizeModelId('gpt-4.1'), 'gpt-4.1');
  assert.equal(normalizeModelId('gemini-2.5-flash'), 'gemini-2.5-flash');
});

test('normalizeModelId returns null for unknown or invalid models', () => {
  assert.equal(normalizeModelId('llama-3.3-70b-versatile'), null);
  assert.equal(normalizeModelId('claude-sonnet-4'), null); // the old fake id
  assert.equal(normalizeModelId(''), null);
  assert.equal(normalizeModelId(null), null);
  assert.equal(normalizeModelId(undefined), null);
  assert.equal(normalizeModelId(42), null);
});

// ── getVrscUsdRate / vrscToUsd ──

test('getVrscUsdRate returns the rate when fresh and positive', () => {
  const r = getVrscUsdRate(envWithRate(0.42));
  assert.ok(r);
  assert.equal(r.rate, 0.42);
});

test('getVrscUsdRate fails closed on missing/zero/negative/garbage rates', () => {
  assert.equal(getVrscUsdRate({}), null);
  assert.equal(getVrscUsdRate(envWithRate(0)), null);
  assert.equal(getVrscUsdRate(envWithRate(-1)), null);
  assert.equal(getVrscUsdRate(envWithRate('not-a-number')), null);
  assert.equal(getVrscUsdRate(envWithRate('Infinity')), null);
});

test('getVrscUsdRate fails closed on stale or untimestamped rates', () => {
  const dayAndMore = 25 * 60 * 60 * 1000;
  assert.equal(getVrscUsdRate(envWithRate(0.5, dayAndMore)), null);
  // No timestamp at all — unverifiable, treated as stale
  assert.equal(getVrscUsdRate({ J41_VRSC_USD_RATE: '0.5' }), null);
  // Custom max age is honored
  const e = envWithRate(0.5, 2000, { J41_VRSC_RATE_MAX_AGE_MS: '1000' });
  assert.equal(getVrscUsdRate(e), null);
});

test('vrscToUsd converts with the rate, fails closed without it', () => {
  assert.equal(vrscToUsd(10, envWithRate(0.5)), 5);
  assert.equal(vrscToUsd(10, {}), null);
  assert.equal(vrscToUsd('garbage', envWithRate(0.5)), null);
  assert.equal(vrscToUsd(-1, envWithRate(0.5)), null);
});

// ── initialTokenBudget ──

test('initialTokenBudget prices from job value, rate, and model', () => {
  // 10 VRSC @ $0.50 = $5; spend fraction 0.6 → $3 spendable.
  // gpt-4.1 blended = (0.002+0.008)/2 = $0.005/1k → 600k tokens.
  const { tokens, basis } = initialTokenBudget(
    { model: 'gpt-4.1', amountVrsc: 10 },
    envWithRate(0.5)
  );
  assert.equal(tokens, 600000);
  assert.equal(basis, 'priced:gpt-4.1');
});

test('initialTokenBudget is always finite — no rate means fallback, never unlimited', () => {
  const { tokens, basis } = initialTokenBudget({ model: 'gpt-4.1', amountVrsc: 10 }, {});
  assert.equal(tokens, DEFAULT_FALLBACK_TOKEN_BUDGET);
  assert.match(basis, /fallback/);
  assert.ok(Number.isFinite(tokens));
});

test('initialTokenBudget treats unknown models as the most expensive (fewest tokens)', () => {
  const env = envWithRate(0.5);
  const unknown = initialTokenBudget({ model: 'mystery-model-9000', amountVrsc: 10 }, env);
  const expensive = mostExpensiveModelCost();
  const priced = initialTokenBudget({ model: expensive.model, amountVrsc: 10 }, env);
  assert.equal(unknown.tokens, priced.tokens);
  assert.match(unknown.basis, /conservative/);
});

test('initialTokenBudget never goes below the floor or above on garbage input', () => {
  const tiny = initialTokenBudget({ model: 'o3', amountVrsc: 0.000001 }, envWithRate(0.5));
  assert.ok(tiny.tokens >= MIN_TOKEN_BUDGET);
  const garbage = initialTokenBudget({ model: 'gpt-4.1', amountVrsc: 'NaN-city' }, envWithRate(0.5));
  assert.equal(garbage.tokens, DEFAULT_FALLBACK_TOKEN_BUDGET);
});

test('initialTokenBudget honors explicit spendFraction and rejects invalid env fractions', () => {
  const full = initialTokenBudget(
    { model: 'gpt-4.1', amountVrsc: 10, spendFraction: 1 },
    envWithRate(0.5)
  );
  assert.equal(full.tokens, 1000000); // $5 / $0.005 per 1k
  const bad = initialTokenBudget(
    { model: 'gpt-4.1', amountVrsc: 10 },
    envWithRate(0.5, 0, { J41_BUDGET_SPEND_FRACTION: '7' }) // >1 → default 0.6
  );
  assert.equal(bad.tokens, 600000);
});

test('initialTokenBudget fallback is configurable but floored', () => {
  const { tokens } = initialTokenBudget(
    { model: 'gpt-4.1', amountVrsc: 10 },
    { J41_FALLBACK_TOKEN_BUDGET: '10' } // below floor, no rate
  );
  assert.equal(tokens, MIN_TOKEN_BUDGET);
});

// ── priceExtension ──

test('priceExtension uses the observed input:output ratio, not 50/50', () => {
  const env = envWithRate(0.5);
  // 90% input history → 90/10 split on the extension
  const skewed = priceExtension({
    model: 'gpt-4.1',
    usage: { promptTokens: 9000, completionTokens: 1000 },
    additionalTokens: 10000,
    markupPercent: 15,
  }, env);
  assert.equal(skewed.inputShare, 0.9);
  // gpt-4.1: 9k input × $0.002 + 1k output × $0.008 = $0.026 → ×1.15 = $0.0299
  assert.ok(Math.abs(skewed.amountUsd - 0.0299) < 1e-9);
  assert.ok(Math.abs(skewed.amountVrsc - 0.0598) < 1e-9);

  // No usage yet → even split
  const even = priceExtension({
    model: 'gpt-4.1', usage: {}, additionalTokens: 10000, markupPercent: 15,
  }, env);
  assert.equal(even.inputShare, 0.5);
});

test('priceExtension fails closed: no rate → amountVrsc null (no money ask)', () => {
  const p = priceExtension({
    model: 'gpt-4.1',
    usage: { promptTokens: 100, completionTokens: 100 },
    additionalTokens: 1000,
    markupPercent: 15,
  }, {});
  assert.ok(p);
  assert.equal(p.amountVrsc, null);
  assert.ok(p.amountUsd > 0);
});

test('priceExtension clamps markup into the SDK-valid range and flags assumed models', () => {
  const env = envWithRate(0.5);
  const clampedHigh = priceExtension({
    model: 'gpt-4.1', usage: {}, additionalTokens: 1000, markupPercent: 500,
  }, env);
  assert.equal(clampedHigh.markupPercent, 50);
  const clampedLow = priceExtension({
    model: 'gpt-4.1', usage: {}, additionalTokens: 1000, markupPercent: -3,
  }, env);
  assert.equal(clampedLow.markupPercent, 1);

  const assumed = priceExtension({
    model: 'mystery-model-9000', usage: {}, additionalTokens: 1000, markupPercent: 15,
  }, env);
  assert.equal(assumed.assumedModel, true);
  assert.equal(assumed.model, mostExpensiveModelCost().model);
});

test('priceExtension rejects nonsense token counts', () => {
  const env = envWithRate(0.5);
  assert.equal(priceExtension({ model: 'gpt-4.1', usage: {}, additionalTokens: 0, markupPercent: 15 }, env), null);
  assert.equal(priceExtension({ model: 'gpt-4.1', usage: {}, additionalTokens: -50, markupPercent: 15 }, env), null);
  assert.equal(priceExtension({ model: 'gpt-4.1', usage: {}, additionalTokens: 'lots', markupPercent: 15 }, env), null);
});

// ── getModelCost sanity ──

test('getModelCost returns table entries for known models, null for unknown', () => {
  const c = getModelCost('anthropic/claude-haiku-4-5');
  assert.ok(c);
  assert.equal(c.model, 'claude-haiku-4.5');
  assert.equal(getModelCost('claude-sonnet-4'), null);
});
