'use strict';
/**
 * Corrupt state files must fail LOUDLY, never silently reset.
 *
 * Fault-injection target 1f. `state.seen` is what stops an already-handled job
 * being picked up again (cli.js, the `state.seen.has(job.id)` gate). Reading a
 * corrupt seen-jobs.json as an empty Map therefore silently re-opens every job
 * the dispatcher has ever completed — and the file used to be written with a
 * bare writeFileSync, so any crash mid-write produced exactly that.
 *
 * Two properties are asserted here:
 *   1. writes are atomic, so a crash cannot truncate the file at all
 *   2. if a file IS corrupt anyway, absent and corrupt are distinguished —
 *      corruption is reported and the evidence preserved
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');

/** Run a snippet with a sandbox HOME; returns { stdout, stderr }. */
function inSandbox(snippet, seed) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-corrupt-'));
  const disp = path.join(home, '.j41', 'dispatcher');
  fs.mkdirSync(disp, { recursive: true });
  if (seed) seed(disp);
  const r = require('child_process').spawnSync(process.execPath, ['-e', snippet], {
    cwd: REPO, env: { ...process.env, HOME: home, NODE_ENV: 'test' }, encoding: 'utf8',
  });
  return { ...r, home, disp };
}

test('a healthy seen-jobs file is read back intact', () => {
  const r = inSandbox(
    'const {loadSeenJobs}=require("./src/cli.js"); console.log(loadSeenJobs().size);',
    (disp) => fs.writeFileSync(path.join(disp, 'seen-jobs.json'),
      JSON.stringify({ 'job-1': 1, 'job-2': 2, 'job-3': 3 })));
  assert.equal(r.stdout.trim(), '3');
});

test('an ABSENT seen-jobs file is silently empty — that is a legitimate first run', () => {
  const r = inSandbox('const {loadSeenJobs}=require("./src/cli.js"); console.log(loadSeenJobs().size);');
  assert.equal(r.stdout.trim(), '0');
  assert.equal(r.stderr.trim(), '', 'a first run must not warn about anything');
});

test('a CORRUPT seen-jobs file reports loudly instead of pretending to be empty', () => {
  const r = inSandbox(
    'const {loadSeenJobs}=require("./src/cli.js"); console.log(loadSeenJobs().size);',
    (disp) => fs.writeFileSync(path.join(disp, 'seen-jobs.json'), '{"job-1":1,"jo'));
  assert.equal(r.stdout.trim(), '0', 'it still returns a usable empty map');
  assert.match(r.stderr, /unreadable/i, 'but it must SAY the file was unreadable');
  assert.match(r.stderr, /re-processed/i, 'and state the consequence');
  const quarantined = fs.readdirSync(r.disp).filter((f) => f.includes('.corrupt.'));
  assert.equal(quarantined.length, 1, 'the corrupt file must be preserved, not overwritten');
});

test('seen-jobs is written ATOMICALLY, so a crash cannot truncate it', () => {
  // The real guarantee: no reader ever observes a partial file. Assert the temp
  // file is gone (renamed, not left behind) and the content is complete JSON.
  const r = inSandbox(`
    const {saveSeenJobs, loadSeenJobs} = require("./src/cli.js");
    saveSeenJobs(new Map([["a",1],["b",2]]));
    console.log(JSON.stringify([...loadSeenJobs()]));
  `);
  assert.match(r.stdout, /\["a",1\]/);
  const leftovers = fs.readdirSync(r.disp).filter((f) => f.endsWith('.tmp'));
  assert.equal(leftovers.length, 0, `temp files left behind: ${leftovers}`);
});

test('a corrupt finalize-state names the agent instead of silently reading as "never finalized"', () => {
  // null here sends an operator back through a registration flow that writes
  // on-chain and costs money — it must not be reached by a parse error in silence.
  const r = inSandbox(
    'const {loadFinalizeState}=require("./src/cli.js"); console.log(String(loadFinalizeState("agent-1")));',
    (disp) => {
      const a = path.join(disp, 'agents', 'agent-1');
      fs.mkdirSync(a, { recursive: true });
      fs.writeFileSync(path.join(a, 'finalize-state.json'), '{ truncated');
    });
  assert.equal(r.stdout.trim(), 'null');
  assert.match(r.stderr, /unreadable/i);
  assert.match(r.stderr, /agent-1/, 'the warning must name the agent');
});

test('an absent finalize-state is silent — a new agent is not a fault', () => {
  const r = inSandbox('const {loadFinalizeState}=require("./src/cli.js"); console.log(String(loadFinalizeState("agent-9")));');
  assert.equal(r.stdout.trim(), 'null');
  assert.equal(r.stderr.trim(), '');
});

// ---------------------------------------------------------------------------
// Fault-injection 1e: encrypt-keys interrupted mid-loop.
//
// The command writes master-key.json FIRST, then re-encrypts each agent. A crash
// in between leaves a master key present with some WIFs still in the clear — and
// the command used to refuse to run again ("already encrypted"), so those keys
// stayed plaintext permanently while the operator believed the pool was
// protected. Silent, and a security failure.
// ---------------------------------------------------------------------------

const { listPlaintextKeys } = require('../src/keys-migrate.js');

function poolWith(states) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-pool-'));
  const agents = path.join(home, '.j41', 'dispatcher', 'agents');
  for (const [id, kind] of Object.entries(states)) {
    fs.mkdirSync(path.join(agents, id), { recursive: true });
    const body = kind === 'encrypted'
      ? { v: 2, pubkey: 'aa', address: 'R1', network: 'verustest', encrypted: { alg: 'aes-256-gcm' } }
      : { wif: 'Uxxxx', pubkey: 'aa', address: 'R1', network: 'verustest' };
    fs.writeFileSync(path.join(agents, id, 'keys.json'), JSON.stringify(body));
  }
  return agents;
}

test('an interrupted encryption is detected as an incomplete pool, not a finished one', () => {
  const agents = poolWith({ 'agent-1': 'encrypted', 'agent-2': 'plain', 'agent-3': 'plain' });
  const straggling = listPlaintextKeys(agents);
  assert.deepEqual(straggling.sort(), ['agent-2', 'agent-3'],
    'the plaintext stragglers must be identifiable so the run can be finished');
});

test('a fully encrypted pool reports no stragglers', () => {
  const agents = poolWith({ 'agent-1': 'encrypted', 'agent-2': 'encrypted' });
  assert.deepEqual(listPlaintextKeys(agents), []);
});

test('a fully plaintext pool reports every agent', () => {
  const agents = poolWith({ 'agent-1': 'plain', 'agent-2': 'plain' });
  assert.deepEqual(listPlaintextKeys(agents).sort(), ['agent-1', 'agent-2']);
});

test('an unreadable key file is NOT reported as plaintext', () => {
  // Guessing "plaintext" about a file we cannot parse would drive a re-encrypt
  // over corrupt data. Unknown is not the same as unprotected.
  const agents = poolWith({ 'agent-1': 'encrypted' });
  fs.mkdirSync(path.join(agents, 'agent-broken'), { recursive: true });
  fs.writeFileSync(path.join(agents, 'agent-broken', 'keys.json'), '{ truncated');
  assert.deepEqual(listPlaintextKeys(agents), [], 'an unparseable file must not be treated as plaintext');
});
