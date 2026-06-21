'use strict';

const GREEN = '\x1b[32m', RED = '\x1b[31m', RESET = '\x1b[0m';

/**
 * Format one upstream-health entry as a colored dashboard tag.
 * Pure: deterministic given (h, now). Treats null/undefined alike (no data → no tag).
 * @param {object|null|undefined} h - a health entry from buildUpstreamHealth, or null/undefined
 * @param {number} now - current epoch ms (injected for testability)
 * @returns {string} '' when there is no data, otherwise a leading-space tag
 */
function formatUpstreamHealthTag(h, now) {
  if (h == null) return '';
  if (h.healthy) {
    if (h.lastCheck == null) return `  ${GREEN}[healthy]${RESET}`;
    const ageS = Math.round((now - h.lastCheck) / 1000);
    return `  ${GREEN}[healthy ${ageS}s ago]${RESET}`;
  }
  const reason = h.error || `status ${h.status}`;
  return `  ${RED}[DOWN — ${reason}]${RESET}`;
}

module.exports = { formatUpstreamHealthTag };
