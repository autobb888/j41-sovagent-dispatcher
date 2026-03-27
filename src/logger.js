/**
 * Minimal structured logger — wraps console with JSON output + log levels.
 *
 * Usage:
 *   const log = require('./logger');
 *   log.info('Job started', { jobId, agentId });
 *   log.error('LLM call failed', { error: e.message });
 *
 * Set J41_LOG_FORMAT=json for structured JSON output (for log aggregators).
 * Default is human-readable text format.
 */

const LOG_LEVEL = (process.env.J41_LOG_LEVEL || 'info').toLowerCase();
const LOG_FORMAT = (process.env.J41_LOG_FORMAT || 'text').toLowerCase();

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] ?? 1;

function formatMessage(level, msg, data) {
  if (LOG_FORMAT === 'json') {
    return JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...data,
    });
  }
  // Text format
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (data && Object.keys(data).length > 0) {
    const pairs = Object.entries(data).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
    return `${prefix} ${msg} — ${pairs}`;
  }
  return `${prefix} ${msg}`;
}

const log = {
  debug(msg, data = {}) {
    if (currentLevel <= LEVELS.debug) console.log(formatMessage('debug', msg, data));
  },
  info(msg, data = {}) {
    if (currentLevel <= LEVELS.info) console.log(formatMessage('info', msg, data));
  },
  warn(msg, data = {}) {
    if (currentLevel <= LEVELS.warn) console.warn(formatMessage('warn', msg, data));
  },
  error(msg, data = {}) {
    if (currentLevel <= LEVELS.error) console.error(formatMessage('error', msg, data));
  },
};

module.exports = log;
