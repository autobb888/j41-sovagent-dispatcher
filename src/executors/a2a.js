/**
 * A2A Executor — Google's Agent-to-Agent protocol.
 * JSON-RPC 2.0 over HTTP with tasks/send for multi-turn interactions.
 *
 * Lifecycle mapping:
 *   J41 accepted  → A2A working
 *   J41 delivered  → A2A completed
 *   J41 cancelled  → A2A canceled
 *   J41 disputed   → A2A failed
 *
 * Config env vars:
 *   J41_EXECUTOR_URL      - A2A agent endpoint URL
 *   J41_EXECUTOR_AUTH     - Authorization header
 *   J41_EXECUTOR_TIMEOUT  - Request timeout in ms (default: 120000)
 */

const crypto = require('crypto');
const { Executor } = require('./base.js');

const EXECUTOR_URL = process.env.J41_EXECUTOR_URL;
const EXECUTOR_AUTH = process.env.J41_EXECUTOR_AUTH || '';
const EXECUTOR_TIMEOUT = parseInt(process.env.J41_EXECUTOR_TIMEOUT || '120000');
const MAX_CONVERSATION_LOG = parseInt(process.env.MAX_CONVERSATION_LOG || '50');

class A2AExecutor extends Executor {
  constructor() {
    super();
    this.job = null;
    this.taskId = null;
    this.sessionId = null;
    this.agentCard = null;
    this.conversationLog = [];
    this._rpcId = 0;
  }

  async init(job, agent, soulPrompt) {
    if (!EXECUTOR_URL) {
      throw new Error('J41_EXECUTOR_URL is required for a2a executor');
    }
    this.job = job;

    // Discover agent capabilities via Agent Card (with timeout)
    const cardController = new AbortController();
    const cardTimer = setTimeout(() => cardController.abort(), 10000);
    try {
      const cardUrl = new URL('/.well-known/agent.json', EXECUTOR_URL).href;
      const res = await fetch(cardUrl, {
        headers: { 'User-Agent': 'j41-agent/1.0' },
        signal: cardController.signal,
      });
      clearTimeout(cardTimer);
      if (res.ok) {
        this.agentCard = await res.json();
        console.log(`[A2A] Discovered agent: ${this.agentCard.name || 'unknown'}`);
      }
    } catch (e) {
      clearTimeout(cardTimer);
      console.log(`[A2A] No agent card found: ${e.message}`);
    }

    // Send initial task
    const result = await this._sendTask({
      role: 'user',
      parts: [{
        type: 'text',
        text: [
          `Job accepted.`,
          `Description: ${job.description}`,
          `Buyer: ${job.buyer}`,
          `Payment: ${job.amount} ${job.currency}`,
          ``,
          `Please greet the buyer and begin work.`,
        ].join('\n'),
      }],
    });

    const greeting = result.text || `Hello! I've accepted your job: "${job.description.substring(0, 100)}". How can I help you?`;
    agent.sendChatMessage(job.id, greeting);
    this.conversationLog.push({ role: 'assistant', content: greeting });
    console.log(`[A2A] Task created: ${this.taskId}, session: ${this.sessionId}`);
  }

  async handleMessage(message, meta) {
    this.conversationLog.push({ role: 'user', content: message });

    // Cap conversation log to prevent OOM
    if (this.conversationLog.length > MAX_CONVERSATION_LOG) {
      const first = this.conversationLog[0];
      this.conversationLog.splice(0, this.conversationLog.length - MAX_CONVERSATION_LOG + 1, first);
    }

    const result = await this._sendTask({
      role: 'user',
      parts: [{ type: 'text', text: message }],
    });

    const reply = result.text || 'I received your message and am processing it.';
    this.conversationLog.push({ role: 'assistant', content: reply });
    return reply;
  }

  async finalize() {
    // Try to retrieve final task state with artifacts
    let content;
    try {
      const task = await this._rpc('tasks/get', { id: this.taskId });
      const artifacts = task.artifacts || [];
      if (artifacts.length > 0) {
        content = artifacts
          .map(a => a.parts?.map(p => p.text || JSON.stringify(p)).join('\n'))
          .join('\n\n');
      }
    } catch {
      // Fall back to conversation log
    }

    if (!content) {
      content = this.conversationLog
        .map(m => `${m.role}: ${m.content}`)
        .join('\n\n');
    }

    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return { content, hash };
  }

  async cleanup() {
    if (this.taskId) {
      try {
        await this._rpc('tasks/cancel', { id: this.taskId });
        console.log(`[A2A] Cancelled task: ${this.taskId}`);
      } catch (e) {
        console.error(`[A2A] Task cancel failed: ${e.message}`);
      }
    }
  }

  async _sendTask(message) {
    const params = {
      message,
      ...(this.taskId ? { id: this.taskId } : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    };

    const task = await this._rpc('tasks/send', params);

    // Track task/session IDs for multi-turn
    if (!this.taskId) this.taskId = task.id;
    if (!this.sessionId) this.sessionId = task.sessionId;

    // Extract text from the last agent message in history
    const history = task.history || [];
    const lastAgent = [...history].reverse().find(m => m.role === 'agent');
    let text = lastAgent?.parts
      ?.filter(p => p.type === 'text')
      ?.map(p => p.text)
      ?.join('\n') || null;

    // Fall back to artifacts
    if (!text && task.artifacts?.length > 0) {
      text = task.artifacts
        .flatMap(a => a.parts?.filter(p => p.type === 'text').map(p => p.text) || [])
        .join('\n');
    }

    return { text };
  }

  async _rpc(method, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXECUTOR_TIMEOUT);

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'j41-agent/1.0',
    };
    if (EXECUTOR_AUTH) {
      headers['Authorization'] = EXECUTOR_AUTH;
    }

    const body = {
      jsonrpc: '2.0',
      id: ++this._rpcId,
      method,
      params,
    };

    try {
      const res = await fetch(EXECUTOR_URL, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify(body),
      });

      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error(`[A2A] ${method} ${res.status}: ${errText.substring(0, 200)}`);
        throw new Error(`A2A returned ${res.status}`);
      }

      let data;
      try {
        data = await res.json();
      } catch (parseErr) {
        throw new Error(`A2A returned non-JSON response: ${parseErr.message}`);
      }
      if (data.error) {
        throw new Error(`A2A RPC error ${data.error.code}: ${data.error.message}`);
      }
      if (data.result === undefined) {
        throw new Error(`A2A RPC returned no result for ${method}`);
      }
      return data.result;
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        throw new Error(`A2A request timed out after ${EXECUTOR_TIMEOUT}ms`);
      }
      throw e;
    }
  }
}

module.exports = { A2AExecutor };
