/**
 * LangServe Executor — POST to LangServe /invoke endpoint.
 * Wraps any LangChain Runnable exposed via FastAPI.
 * Stateless — full conversation history sent each call.
 *
 * Config env vars:
 *   J41_EXECUTOR_URL     - LangServe endpoint URL (e.g. https://host/agent)
 *   J41_EXECUTOR_AUTH    - Authorization header
 *   J41_EXECUTOR_TIMEOUT - Request timeout in ms (default: 60000)
 */

const crypto = require('crypto');
const { Executor } = require('./base.js');

const EXECUTOR_URL = process.env.J41_EXECUTOR_URL;
const EXECUTOR_AUTH = process.env.J41_EXECUTOR_AUTH || '';
const EXECUTOR_TIMEOUT = parseInt(process.env.J41_EXECUTOR_TIMEOUT || '60000');
const MAX_CONVERSATION_LOG = parseInt(process.env.MAX_CONVERSATION_LOG || '50');

class LangServeExecutor extends Executor {
  constructor() {
    super();
    this.job = null;
    this.conversationLog = [];
  }

  async init(job, agent, soulPrompt) {
    if (!EXECUTOR_URL) {
      throw new Error('J41_EXECUTOR_URL is required for langserve executor');
    }
    this.job = job;

    const response = await this._invoke({
      task: job.description,
      messages: [
        { role: 'system', content: soulPrompt },
        {
          role: 'user',
          content: `New job accepted. Description: ${job.description}\nBuyer: ${job.buyer}\nPayment: ${job.amount} ${job.currency}\n\nPlease greet the buyer and confirm acceptance.`,
        },
      ],
    });

    const greeting = response || `Hello! I've accepted your job: "${job.description.substring(0, 100)}". How can I help you?`;
    agent.sendChatMessage(job.id, greeting);
    this.conversationLog.push({ role: 'assistant', content: greeting });
    console.log(`[LANGSERVE] Sent greeting`);
  }

  async handleMessage(message, meta) {
    this.conversationLog.push({ role: 'user', content: message });

    // Cap conversation log to prevent OOM
    if (this.conversationLog.length > MAX_CONVERSATION_LOG) {
      const first = this.conversationLog[0];
      this.conversationLog.splice(0, this.conversationLog.length - MAX_CONVERSATION_LOG + 1, first);
    }

    const response = await this._invoke({
      task: this.job.description,
      messages: this.conversationLog,
    });

    const reply = response || 'I received your message and am processing it.';
    this.conversationLog.push({ role: 'assistant', content: reply });
    return reply;
  }

  async finalize() {
    const content = this.conversationLog
      .map(m => `${m.role}: ${m.content}`)
      .join('\n\n');
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return { content, hash };
  }

  async _invoke(input) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXECUTOR_TIMEOUT);

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'j41-agent/1.0',
    };
    if (EXECUTOR_AUTH) {
      headers['Authorization'] = EXECUTOR_AUTH;
    }

    try {
      const url = EXECUTOR_URL.replace(/\/$/, '');
      const res = await fetch(`${url}/invoke`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({ input }),
      });

      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error(`[LANGSERVE] ${res.status}: ${errText.substring(0, 200)}`);
        throw new Error(`LangServe returned ${res.status}`);
      }

      let data;
      try {
        data = await res.json();
      } catch (parseErr) {
        throw new Error(`LangServe returned non-JSON response: ${parseErr.message}`);
      }
      // LangServe returns { output: ... } where output is the Runnable's result
      if (typeof data.output === 'string') return data.output;
      return data.output?.content || JSON.stringify(data.output);
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        throw new Error(`LangServe request timed out after ${EXECUTOR_TIMEOUT}ms`);
      }
      throw e;
    }
  }
}

module.exports = { LangServeExecutor };
