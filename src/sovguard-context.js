'use strict';

/**
 * Source-trust-aware scanning of untrusted text flowing INTO the agent's
 * context — a tool result, a job description, a buyer message. Wraps the
 * vendored scanContext from @junction41/sovagent-sdk (model-less: regex +
 * indirect + perplexity, no native deps).
 *
 * Trusted sources ('user') are never muzzled. For untrusted sources, a flagged
 * injection is stripped/quarantined per policy (default 'strip') and a
 * notification is logged. On any scanner error or unavailability we fail OPEN
 * (return the original text): this is a defense-in-depth layer on top of
 * junction41's inbound scanning + canary + workspace policy, so a scanner hiccup
 * must never break a live job. Detection still strips when the scanner runs.
 */

let _scanContext;
let _scanUnavailableWarned = false;
function getScanContext() {
  if (_scanContext === undefined) {
    try {
      _scanContext = require('@junction41/sovagent-sdk/dist/safety/context.js').scanContext;
    } catch (_e) {
      _scanContext = null; // SDK/scanner unavailable
    }
    if (_scanContext === null && !_scanUnavailableWarned) {
      _scanUnavailableWarned = true;
      console.warn('[sovguard] scanner module unavailable — inputs will pass through UNSCANNED');
    }
  }
  return _scanContext;
}

function logNotify(logger, line) {
  const sink = logger && typeof logger.warn === 'function' ? logger
    : logger && typeof logger.log === 'function' ? logger
      : console;
  const fn = sink.warn || sink.log;
  fn.call(sink, line);
}

/**
 * @param {string} text   The untrusted text.
 * @param {string} source One of the SDK SourceTrust values
 *                        (user|job_description|workspace_file|mcp_result|api_response|other_agent).
 * @param {{policy?: 'block'|'strip'|'quarantine', logger?: object}} [opts]
 * @returns {Promise<string>} The (possibly sanitized) text safe to put in context.
 */
async function scanUntrusted(text, source, opts = {}) {
  if (typeof text !== 'string' || text.length === 0) return text;
  const scanContext = getScanContext();
  if (!scanContext) return text;

  const { policy = 'strip', logger } = opts;
  try {
    const res = await scanContext(text, { source, policy });
    if (res.action !== 'allow' && res.notify) {
      logNotify(logger, `[sovguard] ${res.notify.message} flags=[${res.notify.flags.join(', ')}]`);
    }
    return res.text;
  } catch (err) {
    logNotify(logger, `[sovguard] scan failed (${source}): ${err.message}`);
    return text;
  }
}

module.exports = { scanUntrusted, getScanContext };
