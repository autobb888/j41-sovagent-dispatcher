/**
 * Executor factory — loads the right executor based on J41_EXECUTOR env var.
 *
 * Core executors:
 *   local-llm  (default) — Any OpenAI-compatible LLM API (20+ providers)
 *   webhook    — POST to REST endpoint (n8n, Zapier, custom backends)
 *   langserve  — LangChain Runnables via /invoke
 *   langgraph  — LangGraph Platform (stateful threads + runs)
 *   a2a        — Google Agent-to-Agent protocol (JSON-RPC)
 *   mcp        — MCP server tools + LLM agent loop
 *
 * Framework aliases (use webhook executor with the framework's REST API):
 *   crewai     → webhook (CrewAI Kickoff API)
 *   autogen    → webhook (AutoGen REST endpoint)
 *   dify       → webhook (Dify Workflow API)
 *   flowise    → webhook (Flowise Chatflow API)
 *   haystack   → webhook (Haystack Pipeline API)
 *   n8n        → webhook (n8n Webhook trigger)
 */

const EXECUTOR_ALIASES = {
  'crewai': 'webhook',
  'autogen': 'webhook',
  'dify': 'webhook',
  'flowise': 'webhook',
  'haystack': 'webhook',
  'n8n': 'webhook',
};

const RAW_EXECUTOR = (process.env.J41_EXECUTOR || 'local-llm').toLowerCase();
const EXECUTOR_TYPE = EXECUTOR_ALIASES[RAW_EXECUTOR] || RAW_EXECUTOR;

function createExecutor() {
  switch (EXECUTOR_TYPE) {
    case 'local-llm': {
      const { LocalLLMExecutor } = require('./local-llm.js');
      return new LocalLLMExecutor();
    }
    case 'webhook': {
      const { WebhookExecutor } = require('./webhook.js');
      return new WebhookExecutor();
    }
    case 'langserve': {
      const { LangServeExecutor } = require('./langserve.js');
      return new LangServeExecutor();
    }
    case 'langgraph': {
      const { LangGraphExecutor } = require('./langgraph.js');
      return new LangGraphExecutor();
    }
    case 'a2a': {
      const { A2AExecutor } = require('./a2a.js');
      return new A2AExecutor();
    }
    case 'mcp': {
      const { MCPExecutor } = require('./mcp.js');
      return new MCPExecutor();
    }
    default:
      throw new Error(`Unknown executor: ${RAW_EXECUTOR}. Supported: local-llm, webhook, langserve, langgraph, a2a, mcp, crewai, autogen, dify, flowise, haystack, n8n`);
  }
}

module.exports = { createExecutor, EXECUTOR_TYPE, EXECUTOR_ALIASES };
