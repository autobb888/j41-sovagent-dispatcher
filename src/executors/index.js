/**
 * Executor factory — loads the right executor based on J41_EXECUTOR env var.
 *
 * Supported executors:
 *   local-llm  (default) — Current Kimi/template behavior
 *   webhook    — POST to external URL (n8n, REST services)
 *   langserve  — LangChain Runnable via LangServe /invoke
 *   langgraph  — LangGraph Platform threads + runs
 *   a2a        — Google A2A protocol (JSON-RPC tasks/send)
 *   mcp        — MCP server tools + LLM agent loop
 */

const EXECUTOR_TYPE = (process.env.J41_EXECUTOR || 'local-llm').toLowerCase();

function createExecutor() {
  switch (EXECUTOR_TYPE) {
    case 'local-llm':
      const { LocalLLMExecutor } = require('./local-llm.js');
      return new LocalLLMExecutor();

    case 'webhook':
      const { WebhookExecutor } = require('./webhook.js');
      return new WebhookExecutor();

    case 'langserve':
      const { LangServeExecutor } = require('./langserve.js');
      return new LangServeExecutor();

    case 'langgraph':
      const { LangGraphExecutor } = require('./langgraph.js');
      return new LangGraphExecutor();

    case 'a2a':
      const { A2AExecutor } = require('./a2a.js');
      return new A2AExecutor();

    case 'mcp':
      const { MCPExecutor } = require('./mcp.js');
      return new MCPExecutor();

    default:
      throw new Error(`Unknown executor type: ${EXECUTOR_TYPE}. Supported: local-llm, webhook, langserve, langgraph, a2a, mcp`);
  }
}

module.exports = { createExecutor, EXECUTOR_TYPE };
