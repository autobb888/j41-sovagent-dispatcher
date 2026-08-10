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
  "init",
  "setup <agent-id> <identity-name>",
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

// ── Derived check: the list above is hand-maintained, which is how `init` slipped ──
//
// K2: `init` writes a WIF per agent and was simply never added to COMMANDS, so it
// wrote plaintext keys onto an encrypted pool AND no test noticed. Enumerating the
// commands that actually touch key material closes that class: a new command that
// writes keys fails here whether or not somebody remembers to list it.

const KEY_WRITING = /writeKeysFile\s*\(|generateKeypair\s*\(/;
const EXCLUDED = new Set([
  'start',     // dedicated interactive unlock block
  'privacy',   // read-only status display, loads no keys
  'keys-migrate', // operates on the keystore itself
  'encrypt-keys', // establishes the passphrase
]);

test('every command whose body writes key material calls the unlock guard', () => {
  const re = /\n  \.command\('([^']+)'\)/g;
  const cmds = [];
  let m;
  while ((m = re.exec(CLI)) !== null) cmds.push({ name: m[1], at: m.index });

  const offenders = [];
  for (let i = 0; i < cmds.length; i++) {
    const start = cmds[i].at;
    const end = i + 1 < cmds.length ? cmds[i + 1].at : CLI.length;
    const block = CLI.slice(start, end);
    const base = cmds[i].name.split(' ')[0];
    if (EXCLUDED.has(base)) continue;
    if (!KEY_WRITING.test(block)) continue;
    if (!/ensureKeystoreUnlockedIfEncrypted\(\)/.test(block)) offenders.push(cmds[i].name);
  }

  assert.deepStrictEqual(offenders, [],
    `these commands write key material without the unlock guard: ${offenders.join(', ')}`);
});
