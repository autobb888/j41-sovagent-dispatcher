/**
 * MCP Executor — Connect to an MCP server, use LLM + MCP tools.
 * Combines an OpenAI-compatible LLM with MCP tool calling in an agent loop.
 * Supports stdio (spawn process) and Streamable HTTP transports.
 *
 * Config env vars:
 *   J41_MCP_COMMAND        - Command to spawn MCP server (stdio transport)
 *   J41_MCP_URL            - MCP server URL (Streamable HTTP transport)
 *   J41_MCP_MAX_ROUNDS     - Max tool-calling rounds per message (default: 10)
 *   J41_EXECUTOR_AUTH      - Authorization header for HTTP transport
 *   J41_EXECUTOR_TIMEOUT   - Per-request timeout in ms (default: 60000)
 *   KIMI_API_KEY           - LLM API key (required — drives tool selection)
 *   KIMI_BASE_URL          - LLM API base URL
 *   KIMI_MODEL             - LLM model name
 *   MAX_CONVERSATION_LOG   - Max conversation entries (default: 50)
 */

const crypto = require('crypto');
const { spawn } = require('child_process');
const { Executor } = require('./base.js');

const MCP_COMMAND = process.env.J41_MCP_COMMAND || '';
const MCP_URL = process.env.J41_MCP_URL || '';
const EXECUTOR_AUTH = process.env.J41_EXECUTOR_AUTH || '';
const EXECUTOR_TIMEOUT = parseInt(process.env.J41_EXECUTOR_TIMEOUT || '60000');
const KIMI_API_KEY = process.env.KIMI_API_KEY || '';
const KIMI_BASE_URL = process.env.KIMI_BASE_URL || 'https://api.kimi.com/coding/v1';
const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k2.5';
const MAX_TOOL_ROUNDS = parseInt(process.env.J41_MCP_MAX_ROUNDS || '10');
const MAX_CONVERSATION_LOG = parseInt(process.env.MAX_CONVERSATION_LOG || '50');

class MCPExecutor extends Executor {
  constructor() {
    super();
    this.job = null;
    this.systemPrompt = '';
    this.conversationLog = [];
    this.tools = [];
    this.openaiTools = [];
    this.transport = null; // 'stdio' or 'http'
    this.mcpProcess = null;
    this._rpcId = 0;
    this._pending = new Map();
    this._buffer = '';
    this.workspaceToolNames = new Set();
    this.workspaceHandler = null;
  }

  async init(job, agent, soulPrompt) {
    if (!MCP_COMMAND && !MCP_URL) {
      throw new Error('J41_MCP_COMMAND or J41_MCP_URL is required for mcp executor');
    }
    if (!KIMI_API_KEY) {
      throw new Error('KIMI_API_KEY is required for mcp executor (LLM drives tool selection)');
    }

    this.job = job;
    this.transport = MCP_COMMAND ? 'stdio' : 'http';

    // Connect to MCP server
    if (this.transport === 'stdio') {
      await this._connectStdio();
    }
    await this._initialize();

    // List available tools
    const toolsResult = await this._rpc('tools/list', {});
    this.tools = toolsResult.tools || [];
    console.log(`[MCP] Discovered ${this.tools.length} tools: ${this.tools.map(t => t.name).join(', ')}`);

    // Convert MCP tools to OpenAI function calling format
    this.openaiTools = this.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.inputSchema || { type: 'object', properties: {} },
      },
    }));

    this.systemPrompt = [
      soulPrompt,
      '',
      '--- Job Context ---',
      `Job: ${job.description}`,
      `Buyer: ${job.buyer}`,
      `Payment: ${job.amount} ${job.currency}`,
      '',
      'You are in a live chat session with tools available.',
      "Use tools when needed to fulfill the buyer's request.",
      'Respond helpfully and concisely.',
    ].join('\n');

    const greeting = `Hello! I've accepted your job: "${job.description.substring(0, 100)}". I have ${this.tools.length} tools available to help. How can I assist you?`;
    agent.sendChatMessage(job.id, greeting);
    this.conversationLog.push({ role: 'assistant', content: greeting });
    console.log(`[MCP] Sent greeting`);
  }

  async handleMessage(message, meta) {
    this.conversationLog.push({ role: 'user', content: message });

    // Cap conversation log
    if (this.conversationLog.length > MAX_CONVERSATION_LOG) {
      const first = this.conversationLog[0];
      this.conversationLog.splice(0, this.conversationLog.length - MAX_CONVERSATION_LOG + 1, first);
    }

    const response = await this._agentLoop();
    this.conversationLog.push({ role: 'assistant', content: response });
    return response;
  }

  async finalize() {
    const content = this.conversationLog
      .map(m => `${m.role}: ${m.content}`)
      .join('\n\n');
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return { content, hash };
  }

  async cleanup() {
    if (this.mcpProcess) {
      try {
        this.mcpProcess.kill('SIGTERM');
        console.log(`[MCP] Terminated MCP server process`);
      } catch (e) {
        console.error(`[MCP] Process cleanup failed: ${e.message}`);
      }
    }
  }

  setWorkspaceTools(tools, handler) {
    this.workspaceHandler = handler;
    for (const tool of tools) {
      this.workspaceToolNames.add(tool.function.name);
      this.openaiTools.push(tool);
    }
    console.log(`[MCP] Workspace tools injected: ${tools.map(t => t.function.name).join(', ')}`);
  }

  clearWorkspaceTools() {
    this.openaiTools = this.openaiTools.filter(t => !this.workspaceToolNames.has(t.function.name));
    this.workspaceToolNames.clear();
    this.workspaceHandler = null;
    console.log(`[MCP] Workspace tools removed`);
  }

  // Agent loop: LLM decides tools → execute via MCP → feed results back → repeat
  async _agentLoop() {
    const messages = [
      { role: 'system', content: this.systemPrompt },
      ...this.conversationLog,
    ];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const llmResponse = await this._callLLM(messages);

      // No tool calls — return the text response
      if (!llmResponse.tool_calls || llmResponse.tool_calls.length === 0) {
        return llmResponse.content || 'I could not generate a response.';
      }

      // Add assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: llmResponse.content || null,
        tool_calls: llmResponse.tool_calls,
      });

      // Execute each tool call via MCP
      for (const toolCall of llmResponse.tool_calls) {
        const toolName = toolCall.function.name;
        let args;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          args = {};
        }

        console.log(`[MCP] Calling tool: ${toolName}`);
        let toolResult;
        try {
          if (this.workspaceToolNames.has(toolName) && this.workspaceHandler) {
            toolResult = await this.workspaceHandler(toolName, args);
          } else {
            const result = await this._rpc('tools/call', { name: toolName, arguments: args });
            toolResult = result.content
              ?.map(c => c.type === 'text' ? c.text : JSON.stringify(c))
              ?.join('\n') || JSON.stringify(result);
          }
        } catch (e) {
          toolResult = `Error: ${e.message}`;
          console.error(`[MCP] Tool ${toolName} failed: ${e.message}`);
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      }
    }

    return 'I reached the maximum number of tool-calling rounds. Please try rephrasing your request.';
  }

  async _callLLM(messages) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXECUTOR_TIMEOUT);

    try {
      const body = {
        model: KIMI_MODEL,
        messages,
        temperature: 0.6,
        max_tokens: 8192,
      };
      if (this.openaiTools.length > 0) {
        body.tools = this.openaiTools;
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
        console.error(`[MCP] LLM API error ${res.status}: ${err.substring(0, 200)}`);
        return { content: 'I encountered an issue processing your request. Please try again.' };
      }

      const data = await res.json();
      return data.choices?.[0]?.message || { content: 'No response generated.' };
    } catch (e) {
      clearTimeout(timer);
      console.error(`[MCP] LLM call failed: ${e.message}`);
      return { content: 'I experienced a temporary issue. Please try again.' };
    }
  }

  // ─── MCP Stdio Transport ───

  async _connectStdio() {
    if (!MCP_COMMAND) throw new Error('J41_MCP_COMMAND is not set');

    // Validate command: must be a non-empty string, must not contain shell metacharacters
    // and must start with a known-safe path prefix or binary name.
    const SAFE_COMMAND_PATTERN = /^(node|npx|python3?|\/usr\/|\/opt\/|\.\/|\/home\/)[^\0;&|`$<>]*$/;
    if (!SAFE_COMMAND_PATTERN.test(MCP_COMMAND.trim())) {
      throw new Error(
        `J41_MCP_COMMAND validation failed: "${MCP_COMMAND.substring(0, 80)}" does not match allowed pattern. ` +
        'Command must start with node, npx, python, or an absolute path.'
      );
    }

    const parts = MCP_COMMAND.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    // Whitelist env vars — don't leak secrets to MCP child process
    const safeEnv = {};
    const SAFE_KEYS = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'NODE_ENV', 'HOSTNAME', 'TZ'];
    for (const key of SAFE_KEYS) {
      if (process.env[key]) safeEnv[key] = process.env[key];
    }
    this.mcpProcess = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: safeEnv,
    });

    this.mcpProcess.stderr.on('data', (data) => {
      console.error(`[MCP-STDERR] ${data.toString().trim()}`);
    });

    this.mcpProcess.stdout.on('data', (data) => {
      this._buffer += data.toString();
      this._processBuffer();
    });

    this.mcpProcess.on('exit', (code) => {
      console.log(`[MCP] Server process exited with code ${code}`);
      this.mcpProcess = null;
      // Reject any pending requests
      for (const [id, { reject }] of this._pending) {
        reject(new Error('MCP server process exited'));
      }
      this._pending.clear();
    });

    // Give the process a moment to start
    await new Promise(r => setTimeout(r, 500));
  }

  _processBuffer() {
    const lines = this._buffer.split('\n');
    this._buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id != null && this._pending.has(msg.id)) {
          const { resolve, reject } = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
          } else {
            resolve(msg.result);
          }
        }
      } catch {
        // Non-JSON line, ignore
      }
    }
  }

  // ─── MCP Protocol ───

  async _initialize() {
    await this._rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'j41-agent', version: '2.0.0' },
    });

    // Send initialized notification (no id = notification)
    if (this.transport === 'stdio' && this.mcpProcess) {
      try {
        this.mcpProcess.stdin.write(JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }) + '\n');
      } catch (e) {
        console.error(`[MCP] Failed to send initialized notification: ${e.message}`);
      }
    }
  }

  async _rpc(method, params) {
    const id = ++this._rpcId;
    const body = { jsonrpc: '2.0', id, method, params };

    if (this.transport === 'stdio') {
      if (!this.mcpProcess) {
        throw new Error('MCP server process is not running');
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._pending.delete(id);
          reject(new Error(`MCP stdio request timed out after ${EXECUTOR_TIMEOUT}ms`));
        }, EXECUTOR_TIMEOUT);

        this._pending.set(id, {
          resolve: (result) => { clearTimeout(timer); resolve(result); },
          reject: (err) => { clearTimeout(timer); reject(err); },
        });

        try {
          this.mcpProcess.stdin.write(JSON.stringify(body) + '\n');
        } catch (writeErr) {
          this._pending.delete(id);
          clearTimeout(timer);
          reject(new Error(`MCP stdin write failed: ${writeErr.message}`));
        }
      });
    }

    // Streamable HTTP transport
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
      const res = await fetch(MCP_URL, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify(body),
      });

      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`MCP HTTP ${res.status}: ${errText.substring(0, 200)}`);
      }

      let data;
      try {
        data = await res.json();
      } catch (parseErr) {
        throw new Error(`MCP HTTP returned non-JSON response: ${parseErr.message}`);
      }
      if (data.error) {
        throw new Error(`MCP error ${data.error.code}: ${data.error.message}`);
      }
      return data.result;
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        throw new Error(`MCP HTTP request timed out after ${EXECUTOR_TIMEOUT}ms`);
      }
      throw e;
    }
  }
}

module.exports = { MCPExecutor };
