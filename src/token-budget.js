/**
 * Token budget math — the single VRSC↔USD↔tokens conversion point (WP-D4).
 *
 * Every conversion the dispatcher makes between job payment (VRSC), LLM cost
 * (USD) and token budgets goes through this module. All paths fail closed:
 * a missing/stale exchange rate, an unknown model, or invalid input produces
 * the most conservative answer (smallest budget, no auto-priced money
 * request) — never an unlimited session and never a made-up price.
 *
 * Rate source: the dispatcher host stamps J41_VRSC_USD_RATE (USD per VRSC,
 * from config.toml [budget].vrsc_usd_rate) and J41_VRSC_USD_RATE_AT (ms
 * epoch, set at container start) into the job environment. A rate older
 * than J41_VRSC_RATE_MAX_AGE_MS is treated as missing. When the platform
 * grows a live rate endpoint, only this module needs to learn about it.
 */

'use strict';

// Floor for any computed budget — enough for a greeting + a couple of
// exchanges, so a mispriced tiny job degrades to "asks for an extension
// early" instead of "cannot respond at all".
const MIN_TOKEN_BUDGET = 1000;

// Minimum VRSC amount that earns the full DEFAULT_FALLBACK_TOKEN_BUDGET when
// the exchange rate is unavailable. Jobs paid below this floor receive a
// proportionally smaller fallback budget so that a near-zero payment cannot
// silently claim the same session capacity as a normally-priced job (M3 cap).
// This is purely a safety proportionality floor — it does NOT set a price
// floor for the marketplace; live-rate jobs are priced via vrscToUsd as usual.
const FALLBACK_MIN_VRSC = 0.01;

// Defaults for the env-tunable knobs (host forwards config.toml [budget]
// values as these env vars; see buildContainerEnv in cli.js).
const DEFAULT_RATE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_SPEND_FRACTION = 0.6;   // share of job value spendable on LLM cost
const DEFAULT_FALLBACK_TOKEN_BUDGET = 50000; // used when budget can't be derived

// SDK pricing validation bounds (calculateListedPrice throws outside [1,50]).
const MIN_MARKUP_PERCENT = 1;
const MAX_MARKUP_PERCENT = 50;
const DEFAULT_MARKUP_PERCENT = 15;

// Provider-prefixed or vendor-specific model ids → SDK pricing-table ids.
// Prefixes (anthropic/, moonshotai/, …) are stripped before lookup, so only
// the bare id needs an entry here. Unknown ids fall back to the most
// expensive table entry (conservative: grants the fewest tokens).
const MODEL_ALIASES = {
  'claude-opus-4-6': 'claude-opus-4.6',
  'claude-sonnet-4-6': 'claude-sonnet-4.6',
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'kimi-k2.5': 'kimi-k2',
  'deepseek-chat': 'deepseek-v3',
  'deepseek-reasoner': 'deepseek-r1',
  'mistral-large-latest': 'mistral-large-3',
  'grok-4': 'grok-4.20',
};

function loadCostTable() {
  // Lazy require — SDK import pattern used across this codebase.
  const { LLM_COSTS } = require('@junction41/sovagent-sdk/dist/pricing/tables.js');
  return LLM_COSTS;
}

/**
 * Map a configured model id (possibly provider-prefixed, e.g.
 * "anthropic/claude-sonnet-4-6") to an SDK pricing-table id.
 * Returns null when the model is not in the table.
 */
function normalizeModelId(model) {
  if (!model || typeof model !== 'string') return null;
  const bare = model.trim().toLowerCase().split('/').pop();
  if (!bare) return null;
  const candidate = MODEL_ALIASES[bare] || bare;
  const table = loadCostTable();
  return table.some(m => m.model === candidate) ? candidate : null;
}

/** Cost-table entry for a model, or null when unknown. */
function getModelCost(model) {
  const id = normalizeModelId(model);
  if (!id) return null;
  return loadCostTable().find(m => m.model === id) || null;
}

/**
 * The most expensive model in the table by blended per-token rate.
 * Used as the fail-closed stand-in for unknown models: assuming the
 * priciest model grants the fewest tokens per VRSC.
 */
function mostExpensiveModelCost() {
  const table = loadCostTable();
  return table.reduce((max, m) =>
    (m.inputPer1k + m.outputPer1k) > (max.inputPer1k + max.outputPer1k) ? m : max
  );
}

/**
 * Set of provider names that are self-hosted class (not metered/SaaS).
 * These providers get a generous fallback budget (self-hosted-70b) for
 * unknown models instead of the conservative most-expensive fallback.
 */
const SELF_HOSTED_CLASS_PROVIDERS = new Set([
  'kimi-nvidia', 'ollama', 'vllm', 'localai', 'lmstudio', 'text-generation-webui', 'self-hosted',
]);

/**
 * Check if a provider is in the self-hosted class.
 * Reads J41_SELF_HOSTED_PROVIDERS env for comma-separated additions.
 */
function isSelfHostedProvider(providerRaw, env = process.env) {
  const p = String(providerRaw || '').trim().toLowerCase();
  if (!p) return false;
  if (SELF_HOSTED_CLASS_PROVIDERS.has(p)) return true;
  const extra = String(env.J41_SELF_HOSTED_PROVIDERS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  return extra.includes(p);
}

/**
 * Cost entry for unknown models, chosen by provider class.
 * Self-hosted providers get self-hosted-70b (generous); metered providers
 * get the most expensive model (fail-closed, conservative).
 */
function unknownModelCost(env = process.env) {
  if (isSelfHostedProvider(env.J41_LLM_PROVIDER, env)) {
    const table = loadCostTable();
    const sh = table.find(m => m.model === 'self-hosted-70b');
    if (sh) return sh;
  }
  return mostExpensiveModelCost();
}

/**
 * Current VRSC→USD rate from the environment, or null when missing,
 * non-positive, non-finite, or stale. Null means "cannot price" — callers
 * must fail closed, never substitute a constant.
 */
function getVrscUsdRate(env = process.env) {
  const rate = parseFloat(env.J41_VRSC_USD_RATE);
  if (!Number.isFinite(rate) || rate <= 0) return null;

  const maxAgeMs = parseInt(env.J41_VRSC_RATE_MAX_AGE_MS) || DEFAULT_RATE_MAX_AGE_MS;
  const stampedAt = parseInt(env.J41_VRSC_USD_RATE_AT);
  // A rate without a timestamp is unverifiable — treat as stale.
  if (!Number.isFinite(stampedAt) || stampedAt <= 0) return null;
  const ageMs = Date.now() - stampedAt;
  if (ageMs > maxAgeMs) return null;

  return { rate, ageMs };
}

/** Convert a VRSC amount to USD, or null when the rate is unavailable. */
function vrscToUsd(amountVrsc, env = process.env) {
  const vrsc = parseFloat(amountVrsc);
  if (!Number.isFinite(vrsc) || vrsc < 0) return null;
  const r = getVrscUsdRate(env);
  if (!r) return null;
  return vrsc * r.rate;
}

/**
 * Derive the initial token budget for a job from its payment.
 *
 * Always returns a finite integer ≥ MIN_TOKEN_BUDGET — when the rate or
 * model is unavailable the configurable fallback budget applies, so a job
 * can never run unmetered (audit fix #2).
 */
function initialTokenBudget({ model, amountVrsc, spendFraction }, env = process.env) {
  const fullFallback = Math.max(
    parseInt(env.J41_FALLBACK_TOKEN_BUDGET) || DEFAULT_FALLBACK_TOKEN_BUDGET,
    MIN_TOKEN_BUDGET
  );

  const usd = vrscToUsd(amountVrsc, env);
  if (usd == null) {
    // Cap the fallback proportionally to the job's payment amount so a
    // near-zero payment cannot claim the same session capacity as a
    // normally-priced job when no exchange rate is available (M3 cap).
    // At or above FALLBACK_MIN_VRSC → full budget; below → scaled down,
    // never below MIN_TOKEN_BUDGET and never unlimited.
    const vrsc = parseFloat(amountVrsc);
    let fallback = fullFallback;
    if (Number.isFinite(vrsc) && vrsc >= 0 && vrsc < FALLBACK_MIN_VRSC) {
      fallback = Math.max(Math.floor(fullFallback * vrsc / FALLBACK_MIN_VRSC), MIN_TOKEN_BUDGET);
    }
    return { tokens: fallback, basis: 'fallback:no-rate' };
  }

  // Explicit caller fraction (e.g. rework budgets pass 1.0 — the dispute
  // policy already sized the share) wins over the env knob.
  let fraction = spendFraction != null ? parseFloat(spendFraction) : parseFloat(env.J41_BUDGET_SPEND_FRACTION);
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    fraction = DEFAULT_SPEND_FRACTION;
  }
  const spendUsd = usd * fraction;

  const entry = getModelCost(model) || unknownModelCost(env);
  const knownModel = !!getModelCost(model);
  const selfHosted = !knownModel && isSelfHostedProvider(env.J41_LLM_PROVIDER, env);
  const blendedPer1k = (entry.inputPer1k + entry.outputPer1k) / 2;
  if (!(blendedPer1k > 0)) return { tokens: fullFallback, basis: 'fallback:zero-cost-model' };

  const tokens = Math.max(Math.floor((spendUsd / blendedPer1k) * 1000), MIN_TOKEN_BUDGET);
  return {
    tokens,
    basis: knownModel ? `priced:${entry.model}` : (selfHosted ? `priced-selfhosted:${entry.model}` : `priced-conservative:${entry.model}`),
    spendUsd,
  };
}

/**
 * Price a budget extension from the job's ACTUAL model and the session's
 * OBSERVED input:output token ratio (audit fix #4 — no assumed 50/50 split,
 * no fake model ids, no hardcoded exchange rate).
 *
 * Returns { amountUsd, amountVrsc, model, assumedModel, inputShare } —
 * amountVrsc is null when no exchange rate is available, in which case the
 * caller must NOT auto-request money (fail closed).
 */
function priceExtension({ model, usage, additionalTokens, markupPercent }, env = process.env) {
  const tokens = parseInt(additionalTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return null;

  let markup = parseFloat(markupPercent);
  if (!Number.isFinite(markup)) markup = DEFAULT_MARKUP_PERCENT;
  markup = Math.min(Math.max(markup, MIN_MARKUP_PERCENT), MAX_MARKUP_PERCENT);

  // Observed ratio; before any usage exists, assume an even split.
  const pt = usage?.promptTokens || 0;
  const ct = usage?.completionTokens || 0;
  const inputShare = (pt + ct) > 0 ? pt / (pt + ct) : 0.5;
  const inputTokens = Math.round(tokens * inputShare);
  const outputTokens = tokens - inputTokens;

  const entry = getModelCost(model) || unknownModelCost(env);
  const assumedModel = !getModelCost(model);

  const { calculateListedPrice } = require('@junction41/sovagent-sdk/dist/pricing/calculator.js');
  const pricing = calculateListedPrice({
    model: entry.model,
    inputTokens,
    outputTokens,
    markupPercent: markup,
  });

  const r = getVrscUsdRate(env);
  return {
    amountUsd: pricing.listedPrice,
    amountVrsc: r ? round6(pricing.listedPrice / r.rate) : null,
    model: entry.model,
    assumedModel,
    inputShare: round6(inputShare),
    markupPercent: markup,
  };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

module.exports = {
  normalizeModelId,
  getModelCost,
  mostExpensiveModelCost,
  isSelfHostedProvider,
  unknownModelCost,
  SELF_HOSTED_CLASS_PROVIDERS,
  getVrscUsdRate,
  vrscToUsd,
  initialTokenBudget,
  priceExtension,
  MIN_TOKEN_BUDGET,
  DEFAULT_FALLBACK_TOKEN_BUDGET,
  DEFAULT_SPEND_FRACTION,
  FALLBACK_MIN_VRSC,
};
