'use strict';
// Exactly-once dedup for chat message ids shared by the WS handler and the poll
// fallback. Bounded: evicts oldest (insertion order) beyond `cap`.
function markIfNew(set, id, cap = 500) {
  if (set.has(id)) return false;
  set.add(id);
  if (set.size > cap) { const oldest = set.values().next().value; set.delete(oldest); }
  return true;
}
module.exports = { markIfNew };
