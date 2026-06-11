/**
 * Executor base class — defines the interface for job processing.
 * Each executor implements init/handleMessage/finalize/cleanup.
 *
 * @abstract
 */
class Executor {
  constructor() {
    this._tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, llmCalls: 0 };
    this._budgetTokens = null;        // null = unlimited
    this._budgetWarningPercent = 80;
    this._budgetWarningFired = false;
    this._onBudgetWarning = null;     // callback(usage, budget)
    this._exhaustedAt = null;         // ms epoch of crossing into exhaustion
    this._extensionRequested = false; // an extension ask is in flight (re-armed by increaseBudget)
  }

  /** Accumulate token usage from an LLM API response's usage object */
  _trackUsage(usage) {
    if (!usage) return;
    this._tokenUsage.promptTokens += usage.prompt_tokens || 0;
    this._tokenUsage.completionTokens += usage.completion_tokens || 0;
    this._tokenUsage.totalTokens += usage.total_tokens || 0;
    this._tokenUsage.llmCalls++;
    // Check budget warning (edge semantics: fires once per arming;
    // increaseBudget re-arms so each granted extension can warn again)
    if (this._budgetTokens != null && !this._budgetWarningFired) {
      const percent = (this._tokenUsage.totalTokens / this._budgetTokens) * 100;
      if (percent >= this._budgetWarningPercent && this._onBudgetWarning) {
        this._budgetWarningFired = true;
        this._onBudgetWarning(this._tokenUsage, this._budgetTokens);
      }
    }
    // Stamp the moment we cross into exhaustion — the session watchdog
    // hard-stops after a configurable wait from this point.
    if (this.isBudgetExhausted() && !this._exhaustedAt) {
      this._exhaustedAt = Date.now();
    }
  }

  /** Get accumulated token usage for this session */
  getTokenUsage() {
    return { ...this._tokenUsage };
  }

  setBudget(budgetTokens, warningPercent = 80, onWarning = null) {
    this._budgetTokens = budgetTokens;
    this._budgetWarningPercent = warningPercent;
    this._onBudgetWarning = onWarning;
    this._budgetWarningFired = false;
    this._exhaustedAt = null;
    this._extensionRequested = false;
  }

  increaseBudget(additionalTokens) {
    if (this._budgetTokens != null && Number.isFinite(additionalTokens) && additionalTokens > 0) {
      this._budgetTokens += additionalTokens;
      // Re-arm edge-triggered state so a second overrun asks again (audit fix #5)
      this._budgetWarningFired = false;
      this._extensionRequested = false;
      if (!this.isBudgetExhausted()) this._exhaustedAt = null;
    }
  }

  isBudgetExhausted() {
    if (this._budgetTokens == null) return false;
    return this._tokenUsage.totalTokens >= this._budgetTokens;
  }

  /** ms epoch when the budget was first exhausted, or null while within budget */
  budgetExhaustedSince() {
    return this._exhaustedAt;
  }

  /** Honest status line for the buyer while generation is paused on budget */
  budgetExhaustedMessage() {
    const used = this._tokenUsage.totalTokens;
    return `I've reached the token budget for this job (${used} tokens used)` +
      ` and have requested a budget extension. I'll continue as soon as it's approved —` +
      ` otherwise I'll deliver what I have so far.`;
  }

  /**
   * Called once when the job starts. Set up connections/state.
   * @param {Object} job - Job metadata (id, description, buyer, amount, currency)
   * @param {Object} agent - J41Agent instance (for sendChatMessage, client, etc.)
   * @param {string} soulPrompt - Agent's SOUL personality prompt
   */
  async init(job, agent, soulPrompt) {
    throw new Error('Executor.init() not implemented');
  }

  /**
   * Process an incoming chat message from the buyer.
   * Return the response string to send back.
   * @param {string} message - Sanitized buyer message
   * @param {Object} meta - Message metadata (senderVerusId, jobId)
   * @returns {Promise<string>} Response to send to buyer
   */
  async handleMessage(message, meta) {
    throw new Error('Executor.handleMessage() not implemented');
  }

  /**
   * Called when the session ends. Return the final deliverable.
   * @returns {Promise<{content: string, hash: string}>} Final result
   */
  async finalize() {
    throw new Error('Executor.finalize() not implemented');
  }

  /**
   * Optional cleanup on timeout/error.
   */
  async cleanup() {
    // Default: no-op
  }

  /**
   * Inject workspace tools into the executor.
   * Called when workspace connects. Override in executors that support tool calling.
   * @param {Array} tools - Tool definitions in OpenAI function-calling format
   * @param {Function} handler - async (toolName, args) => result string
   */
  setWorkspaceTools(tools, handler) {
    // Default: no-op (executor doesn't support tools)
  }

  /**
   * Remove workspace tools. Called when workspace disconnects.
   */
  clearWorkspaceTools() {
    // Default: no-op
  }
}

module.exports = { Executor };
