'use strict';
/**
 * Task 1 — 6.1 loud LLM-outage logging
 *
 * Verifies that the !res.ok fallback path in LocalLLMExecutor emits a
 * [LLM-OUTAGE] marker to console.error before returning the canned string.
 *
 * Strategy: set env vars BEFORE requiring local-llm so that LLM_CONFIG.apiKey
 * is truthy, monkeypatch globalThis.fetch to return a 404, drive
 * handleMessage and assert (a) canned fallback content and (b) [LLM-OUTAGE]
 * in console.error output.
 */
const test = require('node:test');
const assert = require('node:assert');

// Set env vars BEFORE requiring the executor so LLM_CONFIG.apiKey is set
// and handleMessage takes the LLM path instead of template-response path.
process.env.J41_LLM_API_KEY = 'test-key-outage';
process.env.J41_LLM_BASE_URL = 'http://localhost:19999';
process.env.J41_LLM_MODEL = 'test-model';

const { LocalLLMExecutor } = require('../src/executors/local-llm.js');

test('[LLM-OUTAGE] marker emitted and canned fallback returned on !res.ok path', async () => {
  // Capture console.error (logger.js routes log.error → console.error)
  const captured = [];
  const origConsoleError = console.error;
  console.error = (...args) => {
    origConsoleError(...args);
    captured.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };

  // Monkeypatch globalThis.fetch to simulate a 404 error response
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, _opts) => ({
    ok: false,
    status: 404,
    text: async () => 'Function not found for account',
  });

  try {
    const ex = new LocalLLMExecutor();
    // Minimal state — no init() needed; handleMessage only needs these fields.
    ex.systemPrompt = 'You are a test agent.';
    ex.job = { id: 'job-1', description: 'test', buyer: 'buyer@', amount: 1, currency: 'VRSC' };

    const result = await ex.handleMessage('hi', {});

    // (a) returns the canned fallback string (not a template response)
    assert.ok(
      typeof result === 'string' && result.includes('I encountered an issue'),
      `Expected canned fallback string, got: ${result}`
    );

    // (b) a captured console.error line contains [LLM-OUTAGE]
    const hasOutageMarker = captured.some(line => /\[LLM-OUTAGE\]/.test(line));
    assert.ok(
      hasOutageMarker,
      `Expected [LLM-OUTAGE] in console.error output.\nCaptured lines:\n${captured.join('\n')}`
    );
  } finally {
    globalThis.fetch = origFetch;
    console.error = origConsoleError;
  }
});
