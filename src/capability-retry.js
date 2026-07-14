'use strict';
// Pure selector: which agents still need a capability retry. Caller stops the
// retry timer when this returns empty.
function stillFailed(state, agents) {
  return agents.filter(a => state.capabilities.get(a.id)?._fetchFailed === true);
}
module.exports = { stillFailed };
