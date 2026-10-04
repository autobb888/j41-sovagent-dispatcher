'use strict';

/**
 * The model call returns these sentences when the provider never answers.
 * They are not a greeting, not the hire answer, and not a rework package.
 */
function isDegenerateModelText(text) {
  const s = String(text || '').trim();
  if (s.length < 12) return false;
  const alnum = s.replace(/[^A-Za-z0-9]/g, '').length;
  return alnum / s.length < 0.2;
}

function isModelOutageText(text) {
  const s = String(text || '');
  return /I experienced a temporary issue/i.test(s)
    || /I could not generate a response/i.test(s)
    || /I encountered an issue generating a response/i.test(s)
    || /I encountered an issue processing your request/i.test(s)
    || isDegenerateModelText(s);
}

/** What the buyer may see as the greeting. An outage sentence becomes the template. */
function buyerGreeting(modelText, template) {
  const text = typeof modelText === 'string' ? modelText.trim() : '';
  if (!text || isModelOutageText(text)) return template;
  return modelText;
}

function reworkAnswerUsable(response, { budgetGateHit = false } = {}) {
  if (typeof response !== 'string') return false;
  const trimmed = response.trim();
  if (!trimmed) return false;
  if (trimmed === 'I received your message — one moment while I finish my current thought.') return false;
  if (budgetGateHit) return false;
  if (/^I've reached the token budget for this job/.test(trimmed)) return false;
  if (isModelOutageText(trimmed)) return false;
  return true;
}

/**
 * A hire whose only model result is an outage stays open. Pausing on that
 * tick spends a pause, and the third pause on a paid job with no zip starts
 * the dispute clock.
 */
function holdOpenForModelOutage({ hireAnswered = false, outage = false } = {}) {
  return !hireAnswered && !!outage;
}

module.exports = {
  isModelOutageText,
  buyerGreeting,
  reworkAnswerUsable,
  holdOpenForModelOutage,
};
