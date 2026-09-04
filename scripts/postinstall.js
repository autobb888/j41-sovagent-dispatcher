#!/usr/bin/env node
'use strict';
/**
 * After npm install, expose job-agent.js at the path @junction41/secure-setup
 * 0.3.0 hardcodes. Needed when this package is nested under the unscoped
 * j41-dispatcher alias. Must never fail the install.
 */
try {
  const { ensureJobAgentVisibleToSecureSetup } = require('../src/job-agent-path');
  const r = ensureJobAgentVisibleToSecureSetup();
  if (r && r.reason === 'symlinked') {
    process.stdout.write('j41: linked job-agent.js for @junction41/secure-setup canary check\n');
  }
} catch {
  // never fail npm install
}
