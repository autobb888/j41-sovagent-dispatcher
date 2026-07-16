'use strict';
/**
 * Minimal liveness probe for an OpenAI-compatible LLM endpoint. Fail-closed:
 * any non-2xx, network error, or timeout returns ok:false. Mirrors the
 * executor's fetch shape (local-llm.js:345/362) so "probe ok" ⇒ "executor can call".
 */
async function probeLLM(llmConfig, opts = {}) {
  const { baseUrl, model, apiKey, customHeaders } = llmConfig || {};
  const timeoutMs = opts.timeoutMs ?? 5000;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (!baseUrl || !model) return { ok: false, latencyMs: 0, status: null, error: 'missing baseUrl/model' };
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'j41-agent/1.0' };
  if (customHeaders) Object.assign(headers, customHeaders);
  else headers['Authorization'] = `Bearer ${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, temperature: 0 }),
    });
    return { ok: !!res.ok, latencyMs: Date.now() - start, status: res.status ?? null, error: res.ok ? null : `http ${res.status}` };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, status: null, error: e && e.message ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
module.exports = { probeLLM };
