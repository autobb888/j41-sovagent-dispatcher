/**
 * LocalLLM Executor — current behavior, zero regression.
 * Uses KIMI_API_KEY / KIMI_BASE_URL / KIMI_MODEL for LLM,
 * falls back to template responses without API key.
 */

const crypto = require('crypto');
const { Executor } = require('./base.js');

const KIMI_API_KEY = process.env.KIMI_API_KEY || '';
const KIMI_BASE_URL = process.env.KIMI_BASE_URL || 'https://api.kimi.com/coding/v1';
const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k2.5';
const MAX_CONVERSATION_LOG = parseInt(process.env.MAX_CONVERSATION_LOG || '50');
const MAX_TOOL_ROUNDS = parseInt(process.env.J41_MAX_TOOL_ROUNDS || '10');

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

  async init(job, agent, soulPrompt) {
    this.job = job;
    this.soulPrompt = soulPrompt;

    this.systemPrompt = [
      soulPrompt,
      '',
      '--- Job Context ---',
      `Job: ${job.description}`,
      `Buyer: ${job.buyer}`,
      `Payment: ${job.amount} ${job.currency}`,
      '',
      'You are in a live chat session. Respond helpfully and concisely.',
      'When you believe the work is complete, say so clearly.',
    ].join('\n');

    // Send greeting
    const greeting = `Hello! I'm your Verus agent. I've accepted your job: "${job.description.substring(0, 100)}". How can I help you?`;
    agent.sendChatMessage(job.id, greeting);
    this.conversationLog.push({ role: 'assistant', content: greeting });
    console.log(`[CHAT] Sent greeting`);
  }

  async handleMessage(message, meta) {
    this.conversationLog.push({ role: 'user', content: message });

    if (this.conversationLog.length > MAX_CONVERSATION_LOG) {
      const first = this.conversationLog[0];
      this.conversationLog.splice(0, this.conversationLog.length - MAX_CONVERSATION_LOG + 1, first);
    }

    if (KIMI_API_KEY && this.llmBusy) {
      console.log(`[CHAT] LLM busy, queuing acknowledgment`);
      return 'I received your message — one moment while I finish my current thought.';
    }

    let response;
    if (KIMI_API_KEY) {
      this.llmBusy = true;
      try {
        if (this.workspaceTools.length > 0 && this.workspaceHandler) {
          response = await this._agentLoop();
        } else {
          response = await callLLM(this.systemPrompt, this.conversationLog);
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
      this.systemPrompt += '\n\nYou have access to the buyer\'s project files via workspace tools. Use them when the buyer asks you to read, write, or explore their code. Available tools: workspace_list_directory, workspace_read_file, workspace_write_file.';
    }
  }

  clearWorkspaceTools() {
    this.workspaceTools = [];
    this.workspaceHandler = null;
  }

  async _agentLoop() {
    const messages = [...this.conversationLog];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const llmResponse = await callLLMWithTools(this.systemPrompt, messages, this.workspaceTools);

      if (!llmResponse.tool_calls || llmResponse.tool_calls.length === 0) {
        return llmResponse.content || 'I could not generate a response.';
      }

      messages.push({
        role: 'assistant',
        content: llmResponse.content || null,
        tool_calls: llmResponse.tool_calls,
      });

      for (const toolCall of llmResponse.tool_calls) {
        const toolName = toolCall.function.name;
        let args;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          args = {};
        }

        console.log(`[WORKSPACE] Tool call: ${toolName}`);
        const toolResult = await this.workspaceHandler(toolName, args);

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
        });
      }
    }

    return 'I reached the maximum number of tool-calling rounds. Please try rephrasing your request.';
  }
}

// ─────────────────────────────────────────
// LLM: Kimi K2.5 (OpenAI-compatible API)
// ─────────────────────────────────────────

async function callLLM(systemPrompt, messages) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);

    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];

    const res = await fetch(`${KIMI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${KIMI_API_KEY}`,
        'User-Agent': 'j41-agent/1.0',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: KIMI_MODEL,
        messages: apiMessages,
        temperature: 0.6,
        max_tokens: 8192,
      }),
    });

    clearTimeout(timer);

    if (!res.ok) {
      const err = await res.text();
      console.error(`[LLM] Kimi API error ${res.status}: ${err.substring(0, 200)}`);
      return 'I encountered an issue generating a response. Let me try to help directly — could you rephrase your question?';
    }

    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    return msg?.content || msg?.reasoning_content || 'I could not generate a response.';
  } catch (e) {
    console.error(`[LLM] Kimi call failed: ${e.message}`);
    return 'I experienced a temporary issue. Please try sending your message again.';
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
      model: KIMI_MODEL,
      messages: apiMessages,
      temperature: 0.6,
      max_tokens: 8192,
    };
    if (tools.length > 0) {
      body.tools = tools;
    }

    const res = await fetch(`${KIMI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${KIMI_API_KEY}`,
        'User-Agent': 'j41-agent/1.0',
      },
      signal: controller.signal,
      body: JSON.stringify(body),
    });

    clearTimeout(timer);

    if (!res.ok) {
      const err = await res.text();
      console.error(`[LLM] Kimi API error ${res.status}: ${err.substring(0, 200)}`);
      return { content: 'I encountered an issue processing your request. Please try again.' };
    }

    const data = await res.json();
    return data.choices?.[0]?.message || { content: 'No response generated.' };
  } catch (e) {
    console.error(`[LLM] Kimi call failed: ${e.message}`);
    return { content: 'I experienced a temporary issue. Please try again.' };
  }
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

module.exports = { LocalLLMExecutor };
