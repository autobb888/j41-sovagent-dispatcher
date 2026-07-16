/**
 * LocalLLM Executor — supports any OpenAI-compatible LLM API.
 * Set J41_LLM_PROVIDER (kimi, openai, claude, groq, deepseek, mistral, ollama)
 * or configure J41_LLM_BASE_URL + J41_LLM_API_KEY + J41_LLM_MODEL directly.
 * Falls back to KIMI_* env vars for backwards compatibility.
 */

const crypto = require('crypto');
const { Executor } = require('./base.js');
const log = require('../logger.js');
const { scanUntrusted } = require('../sovguard-context.js');

// ── LLM Provider Presets ──
const LLM_PRESETS = {
  // ── OpenAI ──
  'openai':         { baseUrl: 'https://api.openai.com/v1',              model: 'gpt-4.1',                   envKey: 'OPENAI_API_KEY' },
  'openai-mini':    { baseUrl: 'https://api.openai.com/v1',              model: 'gpt-4.1-mini',              envKey: 'OPENAI_API_KEY' },
  'openai-o3':      { baseUrl: 'https://api.openai.com/v1',              model: 'o3',                         envKey: 'OPENAI_API_KEY' },
  // ── Anthropic (use OpenRouter — native API is /messages not /chat/completions) ──
  'claude-opus':    { baseUrl: 'https://openrouter.ai/api/v1',           model: 'anthropic/claude-opus-4-6',  envKey: 'OPENROUTER_API_KEY' },
  'claude-sonnet':  { baseUrl: 'https://openrouter.ai/api/v1',           model: 'anthropic/claude-sonnet-4-6', envKey: 'OPENROUTER_API_KEY' },
  'claude-haiku':   { baseUrl: 'https://openrouter.ai/api/v1',           model: 'anthropic/claude-haiku-4-5', envKey: 'OPENROUTER_API_KEY' },
  // ── Google ──
  'gemini':         { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',  model: 'gemini-2.5-pro', envKey: 'GOOGLE_API_KEY' },
  'gemini-flash':   { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',  model: 'gemini-2.5-flash', envKey: 'GOOGLE_API_KEY' },
  // ── xAI ──
  'grok':           { baseUrl: 'https://api.x.ai/v1',                    model: 'grok-4',                    envKey: 'XAI_API_KEY' },
  // ── Other commercial ──
  'mistral':        { baseUrl: 'https://api.mistral.ai/v1',              model: 'mistral-large-latest',       envKey: 'MISTRAL_API_KEY' },
  'deepseek':       { baseUrl: 'https://api.deepseek.com/v1',            model: 'deepseek-chat',              envKey: 'DEEPSEEK_API_KEY' },
  'cohere':         { baseUrl: 'https://api.cohere.com/compatibility/v1', model: 'command-a-03-2025',         envKey: 'COHERE_API_KEY' },
  'perplexity':     { baseUrl: 'https://api.perplexity.ai',              model: 'sonar-pro',                  envKey: 'PERPLEXITY_API_KEY' },
  // ── Fast inference ──
  'groq':           { baseUrl: 'https://api.groq.com/openai/v1',         model: 'llama-3.3-70b-versatile',   envKey: 'GROQ_API_KEY' },
  'together':       { baseUrl: 'https://api.together.xyz/v1',            model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', envKey: 'TOGETHER_API_KEY' },
  'fireworks':      { baseUrl: 'https://api.fireworks.ai/inference/v1',   model: 'accounts/fireworks/models/llama-v3p3-70b-instruct', envKey: 'FIREWORKS_API_KEY' },
  // ── Enterprise / cloud ──
  'azure':          { baseUrl: '',                                         model: '',                          envKey: 'AZURE_OPENAI_API_KEY', headers: (key) => ({ 'api-key': key }) },
  'nvidia':         { baseUrl: 'https://integrate.api.nvidia.com/v1',     model: 'nvidia/llama-3.1-nemotron-70b-instruct', envKey: 'NVIDIA_API_KEY' },
  // ── Kimi / Moonshot ──
  'kimi':           { baseUrl: 'https://api.kimi.com/coding/v1',          model: 'kimi-k2.5',                 envKey: 'KIMI_API_KEY' },
  'kimi-nvidia':    { baseUrl: 'https://integrate.api.nvidia.com/v1',     model: 'moonshotai/kimi-k2.5',      envKey: 'KIMI_API_KEY' },
  // ── Routers (multi-provider) ──
  'openrouter':     { baseUrl: 'https://openrouter.ai/api/v1',           model: 'anthropic/claude-sonnet-4-6', envKey: 'OPENROUTER_API_KEY' },
  // ── Self-hosted / local ──
  'ollama':         { baseUrl: 'http://localhost:11434/v1',               model: 'llama3.3',                  envKey: '' },
  'lmstudio':       { baseUrl: 'http://localhost:1234/v1',                model: 'local-model',               envKey: '' },
  'vllm':           { baseUrl: 'http://localhost:8000/v1',                model: 'local-model',               envKey: '' },
  // ── Custom (configure via env vars) ──
  'custom':         { baseUrl: '', model: '', envKey: '' },
};

function resolveLLMConfig() {
  const provider = process.env.J41_LLM_PROVIDER || '';
  const preset = LLM_PRESETS[provider] || null;

  // If a preset is selected, use it as defaults but allow env overrides
  const baseUrl = process.env.J41_LLM_BASE_URL || process.env.KIMI_BASE_URL || preset?.baseUrl || '';
  const model = process.env.J41_LLM_MODEL || process.env.KIMI_MODEL || preset?.model || '';
  const apiKey = process.env.J41_LLM_API_KEY || process.env.KIMI_API_KEY || (preset?.envKey ? process.env[preset.envKey] : '') || '';
  const customHeaders = preset?.headers ? preset.headers(apiKey) : null;

  return { baseUrl, model, apiKey, customHeaders, provider: provider || 'custom' };
}

const LLM_CONFIG = resolveLLMConfig();
const MAX_CONVERSATION_LOG = parseInt(process.env.MAX_CONVERSATION_LOG || '50');
const MAX_TOOL_ROUNDS = parseInt(process.env.J41_MAX_TOOL_ROUNDS || '10');

if (LLM_CONFIG.apiKey) {
  console.log(`[LLM] Provider: ${LLM_CONFIG.provider}, Model: ${LLM_CONFIG.model}, Base: ${LLM_CONFIG.baseUrl}`);
} else {
  console.log(`[LLM] No API key — using template responses`);
}

class LocalLLMExecutor extends Executor {
  constructor() {
    super();
    this.conversationLog = [];
    this.systemPrompt = '';
    this.job = null;
    this.soulPrompt = '';
    this.llmBusy = false;
    this.workspaceTools = [];
    this.workspaceHandler = null;
  }

  async init(job, agent, soulPrompt, options = {}) {
    this.job = job;
    this.agent = agent;
    this.soulPrompt = soulPrompt;

    // HOLE 1: scan the untrusted job description before it enters the system prompt.
    const safeDescription = await scanUntrusted(job.description, 'job_description');
    this.safeDescription = safeDescription;
    // job.buyer is platform-supplied metadata — treat as untrusted.
    const safeBuyer = await scanUntrusted(job.buyer, 'job_description');

    this.systemPrompt = [
      soulPrompt,
      '',
      '--- Job Context ---',
      `Job: ${safeDescription}`,
      `Buyer: ${safeBuyer}`,
      `Payment: ${job.amount} ${job.currency}`,
      '',
      'You are in a live chat session. Respond helpfully and concisely.',
      'When you believe the work is complete, say so clearly.',
    ].join('\n');

    // Skip greeting on reconnect — buyer already got a greeting from a previous container.
    // Fetch and seed prior conversation history so the LLM has context on cold respawn.
    if (options.isReconnect) {
      console.log(`[CHAT] Skipping greeting (reconnect — job already in_progress)`);
      await this._seedHistoryFromPlatform(job.id, agent);
      return;
    }

    // Send greeting — use LLM if available, template fallback
    let greeting;
    if (LLM_CONFIG.apiKey) {
      try {
        const greetResult = await callLLM(this.systemPrompt, [
          { role: 'user', content: `[SYSTEM: The buyer just connected. Introduce yourself briefly and ask how you can help with this job. Keep it under 2 sentences.]` },
        ]);
        this._trackUsage(greetResult.usage);
        greeting = greetResult.content;
      } catch {
        greeting = null;
      }
    }
    if (!greeting) {
      greeting = `Hello! I'm your Verus agent. I've accepted your job: "${this.safeDescription.substring(0, 100)}". How can I help you?`;
    }
    agent.sendChatMessage(job.id, greeting);
    this.conversationLog.push({ role: 'assistant', content: greeting });
    console.log(`[CHAT] Sent greeting`);
  }

  /**
   * Seed conversationLog from a flat array of platform ChatMessage objects.
   * Called internally by _seedHistoryFromPlatform; also exported for unit tests.
   *
   * @param {Array<{senderVerusId: string, content: string, type?: string, createdAt?: string}>} messages
   *   Platform ChatMessage list. Sorted oldest-first defensively before seeding —
   *   the backend's ORDER BY for GET /v1/jobs/:id/messages is undocumented, so a
   *   newest-first response would otherwise invert the conversation.
   * @param {string} agentId  Agent's iAddress (identifies 'assistant' turns).
   * @param {string} [agentName] Agent's identityName (secondary match).
   */
  seedConversationLog(messages, agentId, agentName) {
    // Defensive oldest-first sort by createdAt (guarantees correct order
    // regardless of backend sort, for conversations up to the fetch limit).
    const ordered = (messages || []).slice()
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    let seeded = 0;
    for (const m of ordered) {
      // Skip platform system/notification and file messages — the former aren't
      // part of the conversation; the latter carry an opaque URL/ID, not text.
      if (m.type === 'system' || m.type === 'file') continue;
      const isAgent =
        (agentId && m.senderVerusId === agentId) ||
        (agentName && m.senderVerusId === agentName);
      this.conversationLog.push({ role: isAgent ? 'assistant' : 'user', content: m.content });
      seeded++;
    }
    return seeded;
  }

  /**
   * Fetch prior messages from the platform REST API and seed conversationLog.
   * Non-fatal: if the fetch fails, logs a warning and continues with empty context.
   */
  async _seedHistoryFromPlatform(jobId, agent) {
    try {
      const histRes = await agent.client.getChatMessages(jobId, { limit: 100 });
      const msgs = histRes.data || [];
      const seeded = this.seedConversationLog(msgs, agent.iAddress, agent.identityName);
      console.log(`[CHAT] Seeded ${seeded} prior message(s) into conversation context`);
    } catch (e) {
      console.warn(`[CHAT] Could not fetch message history (${e.message}) — continuing with empty context`);
      // Tell the buyer so a resumed agent doesn't appear to have silent amnesia.
      try {
        agent.sendChatMessage(jobId, 'Resuming this job — my earlier conversation history was temporarily unavailable, please recap if needed.');
      } catch {}
    }
  }

  async handleMessage(message, meta) {
    // HOLE 3 (post-2.6.0 review): scan the buyer's live chat message before
    // pushing it into conversationLog. Default-on; operators running a
    // seller agent who trust their specific buyer population can set
    // J41_SCAN_BUYER_CHAT=0 to opt out. The SDK exposes no dedicated
    // 'buyer_chat' source yet — 'other_agent' is the closest untrusted
    // bucket and produces identical scanner behavior; the label appears in
    // audit log/notify only, not in any trust decision.
    // default-on; opt out with J41_SCAN_BUYER_CHAT=0
    if (process.env.J41_SCAN_BUYER_CHAT !== '0') {
      message = await scanUntrusted(message, 'other_agent');
    }
    this.conversationLog.push({ role: 'user', content: message });

    if (this.conversationLog.length > MAX_CONVERSATION_LOG) {
      const first = this.conversationLog[0];
      this.conversationLog.splice(0, this.conversationLog.length - MAX_CONVERSATION_LOG + 1, first);
    }

    if (LLM_CONFIG.apiKey && this.llmBusy) {
      console.log(`[CHAT] LLM busy, queuing acknowledgment`);
      return 'I received your message — one moment while I finish my current thought.';
    }

    let response;
    if (LLM_CONFIG.apiKey) {
      // Budget gate (audit fix #1): no LLM call ever goes out over budget.
      // The extension ask is handled by the setBudget warning callback;
      // here we pause generation and tell the buyer honestly.
      // Do NOT push the status line to conversationLog — finalize() must deliver
      // the real accumulated work, not a repeated canned budget message.
      if (this.isBudgetExhausted()) {
        console.log(`[BUDGET] Generation paused — token budget exhausted (${this.getTokenUsage().totalTokens} tokens)`);
        return this.budgetExhaustedMessage();
      }
      this.llmBusy = true;
      try {
        if (this.workspaceTools.length > 0 && this.workspaceHandler) {
          response = await this._agentLoop();
          // If _agentLoop hit a budget gate it set _budgetGateHit. Return the
          // status string without appending it to conversationLog so finalize()
          // delivers only real accumulated work, not repeated canned lines.
          if (this._budgetGateHit) {
            return response;
          }
        } else {
          const result = await callLLM(this.systemPrompt, this.conversationLog);
          this._trackUsage(result.usage);
          response = result.content;
        }
      } finally {
        this.llmBusy = false;
      }
    } else {
      response = generateTemplateResponse(message, this.job, this.soulPrompt);
    }

    this.conversationLog.push({ role: 'assistant', content: response });
    return response;
  }

  async finalize() {
    const fullContent = this.conversationLog
      .map(m => `${m.role}: ${m.content}`)
      .join('\n\n');
    const hash = crypto.createHash('sha256').update(fullContent).digest('hex');
    return { content: fullContent, hash };
  }

  setWorkspaceTools(tools, handler) {
    this.workspaceTools = tools;
    this.workspaceHandler = handler;
    if (tools.length > 0 && this.job) {
      this.systemPrompt += '\n\nYou have access to the buyer\'s project files via workspace tools. Available tools: workspace_list_directory, workspace_read_file, workspace_write_file.\n\nIMPORTANT RULES:\n- ONLY read files that appear in directory listings. Never guess filenames.\n- If a file read returns BLOCKED or error, do NOT retry that file. Move on to other files.\n- Use workspace_list_directory first to discover what files exist before reading them.\n- Some files are excluded by SovGuard security scanning (e.g. .env, shell scripts) — respect this.';
    }
  }

  clearWorkspaceTools() {
    this.workspaceTools = [];
    this.workspaceHandler = null;
  }

  async _agentLoop() {
    const messages = [...this.conversationLog];
    let totalToolCalls = 0;
    const MAX_TOTAL_CALLS = 15;
    // Reset per-invocation flag so handleMessage can detect a budget gate return
    // without falsely skipping a real last-round LLM response.
    this._budgetGateHit = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Budget gate (audit fix #1): re-checked before every LLM round, so a
      // long tool loop can't keep burning past exhaustion mid-message.
      // Set _budgetGateHit so handleMessage skips the conversationLog push.
      if (this.isBudgetExhausted()) {
        console.log(`[BUDGET] Agent loop paused mid-task — token budget exhausted`);
        this._budgetGateHit = true;
        return 'I had to pause mid-task: the token budget for this job is exhausted and an ' +
          'extension has been requested. Here is my progress so far — I\'ll continue once ' +
          'the extension is approved.';
      }
      const llmResponse = await callLLMWithTools(this.systemPrompt, messages, this.workspaceTools);
      this._trackUsage(llmResponse._usage);

      if (!llmResponse.tool_calls || llmResponse.tool_calls.length === 0) {
        return llmResponse.content || 'I could not generate a response.';
      }

      messages.push({
        role: 'assistant',
        content: llmResponse.content || null,
        tool_calls: llmResponse.tool_calls,
      });

      for (const toolCall of llmResponse.tool_calls) {
        totalToolCalls++;
        if (totalToolCalls > MAX_TOTAL_CALLS) {
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: 'Tool call limit reached — summarize your findings and respond to the user now.' });
          continue;
        }

        const toolName = toolCall.function.name;
        let args;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          args = {};
        }

        console.log(`[WORKSPACE] Tool call: ${toolName}(${JSON.stringify(args).substring(0, 60)})`);
        if (!this.workspaceHandler) {
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: 'Workspace disconnected — tool no longer available.' });
          continue;
        }
        const toolResult = await this.workspaceHandler(toolName, args);
        const rawToolContent = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
        // HOLE 2: scan untrusted tool output before it re-enters the LLM context (indirect injection).
        const toolSource = toolName.startsWith('workspace_') ? 'workspace_file' : 'mcp_result';
        const safeToolContent = await scanUntrusted(rawToolContent, toolSource);

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: safeToolContent,
        });
      }

      // If we hit the total call limit, force one more LLM round to get a text response
      if (totalToolCalls >= MAX_TOTAL_CALLS) {
        if (this.isBudgetExhausted()) {
          // Set flag so handleMessage skips the conversationLog push (canned line)
          this._budgetGateHit = true;
          return 'I reached the tool-call limit and the token budget is exhausted. ' +
            'I\'ve requested a budget extension and will summarize my findings once it\'s approved.';
        }
        const finalResponse = await callLLMWithTools(this.systemPrompt, messages, []);
        this._trackUsage(finalResponse._usage);
        return finalResponse.content || 'I explored the project structure. What would you like me to focus on?';
      }
    }

    return 'I reached the maximum number of tool-calling rounds. Here is what I found so far — please ask a more specific question.';
  }
}

// ─────────────────────────────────────────
// LLM: OpenAI-compatible API (any provider)
// ─────────────────────────────────────────

function buildHeaders() {
  const h = { 'Content-Type': 'application/json', 'User-Agent': 'j41-agent/1.0' };
  if (LLM_CONFIG.customHeaders) Object.assign(h, LLM_CONFIG.customHeaders);
  else h['Authorization'] = `Bearer ${LLM_CONFIG.apiKey}`;
  return h;
}

async function callLLM(systemPrompt, messages) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);

    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];

    const res = await fetch(`${LLM_CONFIG.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(),
      signal: controller.signal,
      body: JSON.stringify({
        model: LLM_CONFIG.model,
        messages: apiMessages,
        temperature: 0.6,
        max_tokens: 8192,
      }),
    });

    clearTimeout(timer);

    if (!res.ok) {
      const err = await res.text();
      log.error('LLM API error', { status: res.status, error: err.substring(0, 200) });
      log.error('[LLM-OUTAGE] shipping canned fallback', { model: LLM_CONFIG.model, base: LLM_CONFIG.baseUrl, error: `${res.status}: ${err.substring(0, 200)}` });
      return { content: 'I encountered an issue generating a response. Let me try to help directly — could you rephrase your question?', usage: null };
    }

    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    return {
      content: msg?.content || msg?.reasoning_content || msg?.reasoning || 'I could not generate a response.',
      usage: data.usage || null,
    };
  } catch (e) {
    log.error('LLM call failed', { error: e.message });
    log.error('[LLM-OUTAGE] shipping canned fallback', { model: LLM_CONFIG.model, base: LLM_CONFIG.baseUrl, error: e.message });
    return { content: 'I experienced a temporary issue. Please try sending your message again.', usage: null };
  }
}

async function callLLMWithTools(systemPrompt, messages, tools) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);

    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => {
        if (m.role === 'tool') {
          return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
        }
        if (m.tool_calls) {
          return { role: 'assistant', content: m.content || null, tool_calls: m.tool_calls };
        }
        return { role: m.role, content: m.content };
      }),
    ];

    const body = {
      model: LLM_CONFIG.model,
      messages: apiMessages,
      temperature: 0.6,
      max_tokens: 8192,
    };
    if (tools.length > 0) {
      body.tools = tools;
    }

    const res = await fetch(`${LLM_CONFIG.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(),
      signal: controller.signal,
      body: JSON.stringify(body),
    });

    clearTimeout(timer);

    if (!res.ok) {
      const err = await res.text();
      log.error('LLM API error', { status: res.status, error: err.substring(0, 200) });
      log.error('[LLM-OUTAGE] shipping canned fallback', { model: LLM_CONFIG.model, base: LLM_CONFIG.baseUrl, error: `${res.status}: ${err.substring(0, 200)}` });
      return { content: 'I encountered an issue processing your request. Please try again.' };
    }

    const data = await res.json();
    const msg = data.choices?.[0]?.message || { content: 'No response generated.' };
    // Kimi K2.5 via NVIDIA returns content=null with text in reasoning field
    if (!msg.content && (msg.reasoning_content || msg.reasoning)) {
      msg.content = msg.reasoning_content || msg.reasoning;
    }
    // Kimi K2.5 emits tool calls as raw markup in content instead of tool_calls array
    // Parse <|tool_calls_section_begin|> ... <|tool_calls_section_end|> into proper tool_calls
    if (msg.content && msg.content.includes('<|tool_calls_section_begin|>') && (!msg.tool_calls || msg.tool_calls.length === 0)) {
      const parsed = parseInlineToolCalls(msg.content);
      if (parsed.length > 0) {
        msg.tool_calls = parsed;
        // Strip tool call markup from content, keep any text before it
        msg.content = msg.content.replace(/<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/, '').trim() || null;
      }
    }
    msg._usage = data.usage || null;
    return msg;
  } catch (e) {
    log.error('LLM call failed', { error: e.message });
    log.error('[LLM-OUTAGE] shipping canned fallback', { model: LLM_CONFIG.model, base: LLM_CONFIG.baseUrl, error: e.message });
    return { content: 'I experienced a temporary issue. Please try again.', _usage: null };
  }
}

/**
 * Parse Kimi K2.5 inline tool call markup into OpenAI-compatible tool_calls array.
 * Format: <|tool_call_begin|> functions.name:id <|tool_call_argument_begin|> {json} <|tool_call_end|>
 */
function parseInlineToolCalls(content) {
  const calls = [];
  const regex = /<\|tool_call_begin\|>\s*functions\.(\w+):(\S+)\s*<\|tool_call_argument_begin\|>\s*(\{[\s\S]*?\})\s*<\|tool_call_end\|>/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    calls.push({
      id: `call_${match[2] || calls.length}`,
      type: 'function',
      function: {
        name: match[1],
        arguments: match[3],
      },
    });
  }
  return calls;
}

// ─────────────────────────────────────────
// Fallback: Template responses (no API key)
// ─────────────────────────────────────────

function generateTemplateResponse(message, job, soulPrompt) {
  const lower = message.toLowerCase();

  if (lower.includes('hello') || lower.includes('hi ') || lower.includes('hey')) {
    return `Hello! I'm working on your request: "${job.description.substring(0, 80)}". What would you like to know?`;
  }

  if (lower.includes('status') || lower.includes('progress') || lower.includes('update')) {
    return `I'm actively working on: "${job.description.substring(0, 80)}". I'll let you know when it's ready.`;
  }

  if (lower.includes('done') || lower.includes('finish') || lower.includes('complete') || lower.includes('deliver')) {
    return `Understood — I'll wrap up and deliver the results now. Thank you for using the Junction41!`;
  }

  if (lower.includes('help') || lower.includes('what can you do')) {
    return `I'm a Verus agent specializing in the areas described in my profile. For this job, I'm working on: "${job.description.substring(0, 80)}". Feel free to ask me anything related!`;
  }

  return `Thanks for your message. I'm processing your request regarding: "${job.description.substring(0, 60)}". Is there anything specific you'd like me to focus on?`;
}

module.exports = { LocalLLMExecutor, LLM_PRESETS, LLM_CONFIG, resolveLLMConfig };
