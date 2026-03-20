/**
 * Executor base class — defines the interface for job processing.
 * Each executor implements init/handleMessage/finalize/cleanup.
 *
 * @abstract
 */
class Executor {
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
