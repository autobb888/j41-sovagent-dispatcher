'use strict';

const { isModelOutageText } = require('./model-outage');

function completionText(raw) {
  const s = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  const trimmed = s.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const choice = parsed && parsed.choices && parsed.choices[0];
      const msg = choice && choice.message;
      if (msg && typeof msg.content === 'string') return msg.content;
    } catch { /* an SSE body falls through */ }
  }
  let content = '';
  for (const line of s.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const json = line.slice(5).trim();
    if (!json || json === '[DONE]') continue;
    try {
      const frame = JSON.parse(json);
      const choice = frame && frame.choices && frame.choices[0];
      const delta = (choice && (choice.delta || choice.message)) || {};
      if (typeof delta.content === 'string') content += delta.content;
    } catch { /* keep-alive or a broken frame */ }
  }
  return content;
}

/**
 * What the meter may keep. An error, a dropped stream with no usage, and an
 * unusable completion cost nothing. A 2xx with no usage frame keeps the
 * reserved output so a silent upstream cannot give the tokens away.
 */
function settleTokenCounts({
  statusOk = false,
  aborted = false,
  sawOutput = false,
  inputTok = 0,
  outputTok = 0,
  reserveOutput = 0,
  text = '',
} = {}) {
  if (!statusOk) return { inputTok: 0, outputTok: 0, reason: 'upstream-error' };
  if (text && isModelOutageText(text)) return { inputTok: 0, outputTok: 0, reason: 'unusable' };
  if (aborted) return { inputTok, outputTok: sawOutput ? outputTok : 0, reason: 'abort' };
  if (!sawOutput) return { inputTok, outputTok: reserveOutput, reason: 'no-usage' };
  return { inputTok, outputTok, reason: 'usage' };
}

module.exports = { completionText, settleTokenCounts };
