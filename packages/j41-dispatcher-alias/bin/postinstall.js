#!/usr/bin/env node
'use strict';
const pkg = require('../package.json');
process.stdout.write(
  `\nj41-dispatcher@${pkg.version} is an alias of @junction41/dispatcher@${pkg.version}.\n` +
  'The real CLI lives in the scoped package. Frozen 2.0.0 is no longer what this name installs.\n\n',
);
try {
  require('@junction41/dispatcher/src/job-agent-path').ensureJobAgentVisibleToSecureSetup();
} catch {
  // never fail npm install; start/doctor also try
}
