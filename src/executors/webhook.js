/**
 * Webhook Executor — POST job/messages to external URL, get responses back.
 * Covers n8n, any REST service, custom agent backends.
 *
 * Config env vars:
 *   J41_EXECUTOR_URL   - Webhook endpoint URL
 *   J41_EXECUTOR_AUTH  - Authorization header (e.g. "Bearer xxx")
 *   J41_EXECUTOR_TIMEOUT - Request timeout in ms (default: 60000)
 */

const crypto = require('crypto');
const { Executor } = require('./base.js');

const EXECUTOR_URL = process.env.J41_EXECUTOR_URL;
const EXECUTOR_AUTH = process.env.J41_EXECUTOR_AUTH || '';
const EXECUTOR_TIMEOUT = parseInt(process.env.J41_EXECUTOR_TIMEOUT || '60000');
const MAX_CONVERSATION_LOG = parseInt(process.env.MAX_CONVERSATION_LOG || '50');

class WebhookExecutor extends Executor {
  constructor() {
    super();
    this.job = null;
    this.conversationLog = [];
    this.sessionId = null;
  }

  async init(job, agent, soulPrompt) {
    if (!EXECUTOR_URL) {
      throw new Error('J41_EXECUTOR_URL is required for webhook executor');
    }

    this.job = job;

    // POST job init to webhook
    const initPayload = {
      event: 'job_started',
      job: {
        id: job.id,
        description: job.description,
        buyer: job.buyer,
        amount: job.amount,
        currency: job.currency,
      },
      soulPrompt,
    };

    const response = await this._post(initPayload);

    // Webhook can return a sessionId for stateful conversations
    this.sessionId = response?.sessionId || job.id;

    // If webhook returns a greeting, use it
    if (response?.message) {
      agent.sendChatMessage(job.id, response.message);
      this.conversationLog.push({ role: 'assistant', content: response.message });
      console.log(`[WEBHOOK] Sent greeting from webhook`);
    } else {
      const greeting = `Hello! I've accepted your job: "${job.description.substring(0, 100)}". How can I help you?`;
      agent.sendChatMessage(job.id, greeting);
      this.conversationLog.push({ role: 'assistant', content: greeting });
      console.log(`[WEBHOOK] Sent default greeting`);
    }
  }

  async handleMessage(message, meta) {
    this.conversationLog.push({ role: 'user', content: message });

    // Cap conversation log to prevent OOM
    if (this.conversationLog.length > MAX_CONVERSATION_LOG) {
      const first = this.conversationLog[0];
      this.conversationLog.splice(0, this.conversationLog.length - MAX_CONVERSATION_LOG + 1, first);
    }

    const payload = {
      event: 'message',
      sessionId: this.sessionId,
      job: { id: this.job.id },
      message: {
        content: message,
        senderVerusId: meta.senderVerusId,
      },
      conversationLog: this.conversationLog,
    };

    const response = await this._post(payload);
    const reply = response?.message || response?.content || 'I received your message and am processing it.';

    this.conversationLog.push({ role: 'assistant', content: reply });
    return reply;
  }

  async finalize() {
    const payload = {
      event: 'job_complete',
      sessionId: this.sessionId,
      job: { id: this.job.id },
      conversationLog: this.conversationLog,
    };

    const response = await this._post(payload);

    // Webhook can return structured deliverable
    const content = response?.deliverable || response?.content ||
      this.conversationLog.map(m => `${m.role}: ${m.content}`).join('\n\n');
    const hash = response?.hash ||
      crypto.createHash('sha256').update(content).digest('hex');

    return { content, hash };
  }

  async cleanup() {
    try {
      await this._post({
        event: 'job_cleanup',
        sessionId: this.sessionId,
        job: { id: this.job?.id },
      });
    } catch (e) {
      console.error(`[WEBHOOK] Cleanup notification failed: ${e.message}`);
    }
  }

  async _post(payload) {
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
      const res = await fetch(EXECUTOR_URL, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify(payload),
      });

      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error(`[WEBHOOK] ${res.status}: ${errText.substring(0, 200)}`);
        throw new Error(`Webhook returned ${res.status}`);
      }

      try {
        return await res.json();
      } catch (parseErr) {
        throw new Error(`Webhook returned non-JSON response: ${parseErr.message}`);
      }
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        throw new Error(`Webhook request timed out after ${EXECUTOR_TIMEOUT}ms`);
      }
      throw e;
    }
  }
}

module.exports = { WebhookExecutor };
