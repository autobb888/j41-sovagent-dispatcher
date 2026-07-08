'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CLI = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');

// Every key-dependent command action should call the unlock guard so an
// encrypted pool prompts to unlock instead of throwing ELOCKED.
// Deliberately excluded: `start` (has its own dedicated interactive unlock block)
// and `privacy` (read-only status display, loads no keys).
const COMMANDS = [
  "register <agent-id> <identity-name>",
  "finalize <agent-id>",
  "set-authorities <agentId>",
  "check-authorities",
  "deactivate <agent-id>",
  "activate <agent-id>",
  "activate-all",
  "deactivate-all",
  "update-profile <agent-id>",
  "inspect <agent-id>",
  "api-setup <agent-id>",
  "respond-dispute <jobId>",
  "post-bounty <agent-id>",
  "list-bounties",
  "my-bounties <agent-id>",
];

for (const cmd of COMMANDS) {
  test(`command "${cmd}" calls ensureKeystoreUnlockedIfEncrypted`, () => {
    const marker = `.command('${cmd}')`;
    const start = CLI.indexOf(marker);
    assert.ok(start > -1, `command not found: ${cmd}`);
    // Look within this command's block: from its .command() to the next .command( at column 0-ish.
    const next = CLI.indexOf('\n  .command(', start + marker.length);
    const block = CLI.slice(start, next === -1 ? start + 4000 : next);
    assert.match(block, /ensureKeystoreUnlockedIfEncrypted\(\)/, `missing guard in "${cmd}"`);
  });
}
