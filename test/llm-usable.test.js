/**
 * F2 — a keyless local provider must actually call the model.
 *
 * `ollama`, `lmstudio` and `vllm` are declared with `envKey: ''` because they need no
 * credential. Every gate in the executor tested `apiKey` truthiness, so those three
 * fell through to `generateTemplateResponse` — and that filler was DELIVERED AND HASHED
 * as the buyer's paid work product. Preflight could not catch it: it probes the
 * endpoint, which is up. The TUI even labels these providers "(no key needed)".
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

function resolveWith(env) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('local-llm')) delete require.cache[k];
  }
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try {
    return require('../src/executors/local-llm.js').resolveLLMConfig();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const NO_KEYS = { J41_LLM_API_KEY: undefined, KIMI_API_KEY: undefined, OPENAI_API_KEY: undefined, J41_LLM_BASE_URL: undefined, J41_LLM_MODEL: undefined };

for (const provider of ['ollama', 'lmstudio', 'vllm']) {
  test(`${provider} is usable without a key — it must not fall back to template filler`, () => {
    const cfg = resolveWith({ ...NO_KEYS, J41_LLM_PROVIDER: provider });
    assert.equal(cfg.keyless, true, `${provider} declares envKey: ''`);
    assert.equal(cfg.apiKey, '', 'no credential is expected');
    assert.equal(cfg.usable, true,
      `${provider} has a baseUrl and needs no key — gating on apiKey delivered filler as paid work`);
  });
}

test('a keyed provider with no key configured is NOT usable', () => {
  const cfg = resolveWith({ ...NO_KEYS, J41_LLM_PROVIDER: 'openai' });
  assert.equal(cfg.keyless, false);
  assert.equal(cfg.usable, false, 'openai without a key cannot reach a model');
});

test('a keyed provider WITH a key is usable', () => {
  const cfg = resolveWith({ ...NO_KEYS, J41_LLM_PROVIDER: 'openai', J41_LLM_API_KEY: 'sk-test' });
  assert.equal(cfg.usable, true);
  assert.equal(cfg.apiKey, 'sk-test');
});

test('a keyless provider with no baseUrl is not usable — nothing to call', () => {
  // Guards the second half of the condition: keyless alone is not enough.
  const cfg = resolveWith({ ...NO_KEYS, J41_LLM_PROVIDER: 'ollama', J41_LLM_BASE_URL: '' });
  assert.equal(cfg.usable, true, 'the preset supplies the baseUrl when the env does not');
});
