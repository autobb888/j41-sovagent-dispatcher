'use strict';
function isValidJobId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id); }
module.exports = { isValidJobId };
