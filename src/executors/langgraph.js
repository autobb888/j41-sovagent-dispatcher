/**
 * LangGraph Executor — Create threads and runs on LangGraph Platform.
 * Persistent conversation state via LangGraph threads (Postgres-backed).
 *
 * Config env vars:
 *   J41_EXECUTOR_URL       - LangGraph Platform URL
 *   J41_EXECUTOR_AUTH      - Authorization header (e.g. "Bearer xxx")
 *   J41_EXECUTOR_ASSISTANT - Assistant ID (default: "agent")
 *   J41_EXECUTOR_TIMEOUT   - Request timeout in ms (default: 120000)
 */

const crypto = require('crypto');
const { Executor } = require('./base.js');

const EXECUTOR_URL = process.env.J41_EXECUTOR_URL;
const EXECUTOR_AUTH = process.env.J41_EXECUTOR_AUTH || '';
const EXECUTOR_ASSISTANT = process.env.J41_EXECUTOR_ASSISTANT || 'agent';
const EXECUTOR_TIMEOUT = parseInt(process.env.J41_EXECUTOR_TIMEOUT || '120000');
const MAX_CONVERSATION_LOG = parseInt(process.env.MAX_CONVERSATION_LOG || '50');

class LangGraphExecutor extends Executor {
  constructor() {
    super();
    this.job = null;
    this.threadId = null;
    this.conversationLog = [];
  }

  async init(job, agent, soulPrompt) {
    if (!EXECUTOR_URL) {
      throw new Error('J41_EXECUTOR_URL is required for langgraph executor');
    }
    this.job = job;

    // Create a thread
    const thread = await this._request('POST', '/threads', {
      metadata: { jobId: job.id, buyer: job.buyer },
    });
    this.threadId = thread.thread_id;
    console.log(`[LANGGRAPH] Created thread: ${this.threadId}`);

    // Run initial message
    const initMessage = [
      `New job accepted.`,
      `Description: ${job.description}`,
      `Buyer: ${job.buyer}`,
      `Payment: ${job.amount} ${job.currency}`,
      ``,
      `Please greet the buyer and confirm acceptance.`,
    ].join('\n');

    const result = await this._runAndWait({
      messages: [{ role: 'user', content: initMessage }],
      system: soulPrompt,
    });

    const greeting = result || `Hello! I've accepted your job: "${job.description.substring(0, 100)}". How can I help you?`;
    agent.sendChatMessage(job.id, greeting);
    this.conversationLog.push({ role: 'assistant', content: greeting });
    console.log(`[LANGGRAPH] Sent greeting`);
  }

  async handleMessage(message, meta) {
    this.conversationLog.push({ role: 'user', content: message });

    // Cap conversation log to prevent OOM
    if (this.conversationLog.length > MAX_CONVERSATION_LOG) {
      const first = this.conversationLog[0];
      this.conversationLog.splice(0, this.conversationLog.length - MAX_CONVERSATION_LOG + 1, first);
    }

    const result = await this._runAndWait({
      messages: [{ role: 'user', content: message }],
    });

    const reply = result || 'I received your message and am processing it.';
    this.conversationLog.push({ role: 'assistant', content: reply });
    return reply;
  }

  async finalize() {
    // Retrieve final thread state
    let content;
    try {
      const state = await this._request('GET', `/threads/${this.threadId}/state`);
      const messages = state.values?.messages || [];
      content = messages
        .map(m => `${m.type || m.role}: ${m.content}`)
        .join('\n\n');
    } catch {
      content = this.conversationLog
        .map(m => `${m.role}: ${m.content}`)
        .join('\n\n');
    }

    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return { content, hash };
  }

  async cleanup() {
    if (this.threadId) {
      try {
        await this._request('DELETE', `/threads/${this.threadId}`);
        console.log(`[LANGGRAPH] Deleted thread: ${this.threadId}`);
      } catch (e) {
        console.error(`[LANGGRAPH] Thread cleanup failed: ${e.message}`);
      }
    }
  }

  async _runAndWait(input) {
    // POST to /runs/wait blocks until the run completes
    const run = await this._request('POST', `/threads/${this.threadId}/runs/wait`, {
      assistant_id: EXECUTOR_ASSISTANT,
      input,
    });

    // Extract the last assistant message from the run result
    const messages = run.values?.messages || run.messages || [];
    const lastAssistant = [...messages].reverse().find(m =>
      m.type === 'ai' || m.role === 'assistant'
    );
    return lastAssistant?.content || null;
  }

  async _request(method, endpoint, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXECUTOR_TIMEOUT);

    const url = `${EXECUTOR_URL.replace(/\/$/, '')}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'j41-agent/1.0',
    };
    if (EXECUTOR_AUTH) {
      headers['Authorization'] = EXECUTOR_AUTH;
    }

    const opts = { method, headers, signal: controller.signal };
    if (body && method !== 'GET') {
      opts.body = JSON.stringify(body);
    }

    try {
      const res = await fetch(url, opts);
      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error(`[LANGGRAPH] ${method} ${endpoint} ${res.status}: ${errText.substring(0, 200)}`);
        throw new Error(`LangGraph returned ${res.status}`);
      }

      if (method === 'DELETE') return {};
      try {
        return await res.json();
      } catch (parseErr) {
        throw new Error(`LangGraph returned non-JSON response: ${parseErr.message}`);
      }
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        throw new Error(`LangGraph request timed out after ${EXECUTOR_TIMEOUT}ms`);
      }
      throw e;
    }
  }
}

module.exports = { LangGraphExecutor };
