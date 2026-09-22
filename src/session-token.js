'use strict';

/** The review posts the token after the colon, not `buyer:token`. */
function sessionTokenFromHeader(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const idx = trimmed.lastIndexOf(':');
  if (idx > 0 && idx < trimmed.length - 1) return trimmed.slice(idx + 1).trim();
  return trimmed;
}

module.exports = { sessionTokenFromHeader };
