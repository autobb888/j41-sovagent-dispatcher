'use strict';
// Pure selector for the worker message-poll fallback: keep ONLY messages the
// buyer sent (positive match — never the agent's own, so no self-reply loop),
// oldest-first. Exactly-once dedup is handled downstream by markIfNew inside
// processBuyerMessage.
// Note: filtering is intentionally score-agnostic — safetyScore/flagged status is NOT checked here.
function selectBuyerMessages(messages, buyerVerusId) {
  if (!Array.isArray(messages) || !buyerVerusId) return [];
  return messages
    .filter(m => m && m.senderVerusId === buyerVerusId)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
module.exports = { selectBuyerMessages };
