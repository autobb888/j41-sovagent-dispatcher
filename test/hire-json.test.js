'use strict';

// The machine-driven hire contract.
//
// `hire` is how an autonomous caller (an LLM with a shell, a script) actually spends money through
// the dispatcher, so its failure modes have to be branchable without parsing prose, and its
// success has to report the FULL txid — the human line truncates to 16 chars, which loses it
// irrecoverably.
//
// Two kinds of test here, deliberately:
//   - subprocess tests for paths reachable with no keys and no network;
//   - a source-level wiring assertion for the spend gate, which cannot be reached without a
//     registered buyer identity and a live broadcast. That one exists because the gate is the
//     only thing standing between a headless caller and an unbounded send, and a deleted call is
//     invisible to every behavioural test above.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI_PATH = path.join(__dirname, '..', 'src', 'cli.js');
const CLI = fs.readFileSync(CLI_PATH, 'utf8');

function runHire(args) {
  const r = spawnSync(process.execPath, [CLI_PATH, 'hire', ...args], {
    encoding: 'utf8',
    input: '',          // any interactive prompt gets EOF rather than hanging the suite
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function parseJsonStdout(stdout) {
  const t = stdout.trim();
  assert.ok(t.startsWith('{'), `expected a JSON object on stdout, got: ${t.slice(0, 200)}`);
  return JSON.parse(t);
}

// --------------------------------------------------------------- the JSON contract

test('--json without --yes refuses instead of blocking on the confirm prompt', () => {
  // confirmHire() reads stdin. Without this guard the combination waits forever, which for an
  // autonomous caller is worse than an error: it hangs the agent rather than failing it.
  const r = runHire(['buyer1', 'seller1', '--amount', '1', '--json']);
  assert.equal(r.status, 1);
  assert.equal(parseJsonStdout(r.stdout).code, 'JSON_REQUIRES_YES');
});

test('a rejected amount is a branchable code, not prose', () => {
  const r = runHire(['buyer1', 'seller1', '--amount', '0', '--json', '--yes']);
  assert.equal(r.status, 1);
  const out = parseJsonStdout(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'BAD_AMOUNT');
});

test('an unknown buyer is a branchable code, not prose', () => {
  const r = runHire(['nosuchbuyer', 'seller1', '--amount', '5', '--json', '--yes']);
  assert.equal(r.status, 1);
  assert.equal(parseJsonStdout(r.stdout).code, 'BUYER_NOT_FOUND');
});

test('every --json failure carries ok:false, a code and a message', () => {
  for (const args of [
    ['buyer1', 'seller1', '--amount', '1', '--json'],
    ['buyer1', 'seller1', '--amount', '-3', '--json', '--yes'],
    ['nosuchbuyer', 'seller1', '--amount', '5', '--json', '--yes'],
  ]) {
    const out = parseJsonStdout(runHire(args).stdout);
    assert.equal(out.ok, false);
    assert.equal(typeof out.code, 'string');
    assert.ok(out.code.length > 0);
    assert.equal(typeof out.message, 'string');
    assert.ok(out.message.length > 0);
  }
});

test('the human path is unchanged: prose on stderr, nothing on stdout', () => {
  // Adding --json must not have altered what an operator at a terminal sees.
  const r = runHire(['nosuchbuyer', 'seller1', '--amount', '5', '--yes']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), '');
  assert.match(r.stderr, /Agent nosuchbuyer not found/);
});

test('human path: local keys without identity exit 1 (not 0)', () => {
  const home = fs.mkdtempSync(path.join(require('os').tmpdir(), 'j41-hire-'));
  const dir = path.join(home, '.j41', 'dispatcher', 'agents', 'agent-1');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify({
    address: 'R9PXNzv1eTbVUERY48LDxiQGaTt7btkZ6e',
    wif: 'unused',
  }), { mode: 0o600 });
  const r = spawnSync(process.execPath, [CLI_PATH, 'hire', 'agent-1', 'testgpu01.agentplatform@', '--amount', '1', '--yes'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    timeout: 20_000,
  });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.match(`${r.stderr}\n${r.stdout}`, /not registered/i);
  fs.rmSync(home, { recursive: true, force: true });
});

test('missing --amount is a non-zero exit', () => {
  const r = runHire(['agent-1', 'seller1', '--yes']);
  assert.notEqual(r.status, 0);
});

// ------------------------------------------------------- wiring the behavioural tests can't reach

// The hire action's source, isolated so these assertions cannot be satisfied by an unrelated
// command elsewhere in this 13k-line file.
const HIRE_SRC = (() => {
  const start = CLI.indexOf(".command('hire <buyer-agent-id> <seller>')");
  assert.ok(start > -1, 'hire command not found in cli.js');
  const end = CLI.indexOf(".command('buyers')", start);
  assert.ok(end > start, 'could not bound the hire action');
  return CLI.slice(start, end);
})();

test('the autonomous pay path is gated before the broadcast, not after', () => {
  // `hire --pay` is the only money-broadcast site in the dispatcher with no spend gate; its whole
  // protection is confirmHire's keystroke, which --json and J41_HEADLESS_MAINNET_PAY remove.
  const gate = HIRE_SRC.indexOf('gateExternalSend(');
  const send = HIRE_SRC.indexOf('sendMultiPayment(');
  assert.ok(gate > -1, 'hire no longer calls gateExternalSend — a headless send would be unbounded');
  assert.ok(send > -1, 'hire no longer broadcasts');
  assert.ok(gate < send, 'gateExternalSend must run BEFORE sendMultiPayment');
});

test('the spend gate is told recipients resolved from the chain, not from the value under test', () => {
  // expectedRecipients derived from job.payment.address is a tautology: the check then authorises
  // whatever address it was handed. The independent source is the seller identity on chain.
  assert.match(HIRE_SRC, /getAgentPaymentAddress\(/,
    'hire no longer resolves the seller address independently');
  const gateCall = HIRE_SRC.slice(HIRE_SRC.indexOf('gateExternalSend('), HIRE_SRC.indexOf('sendMultiPayment('));
  assert.match(gateCall, /expectedRecipients:\s*expected/,
    'the gate is not being given an expectedRecipients set');
  assert.ok(!/expectedRecipients:\s*\[[^\]]*job\.payment\.address/.test(HIRE_SRC),
    'expectedRecipients is derived from job.payment.address — that makes the check a no-op');
});

test('headless mainnet payment is opt-in through its own env var, never through --yes', () => {
  // --yes is a general "skip the prompt" flag a script sets once and forgets. It must not be the
  // thing that authorises real money with nobody watching.
  assert.match(HIRE_SRC, /J41_HEADLESS_MAINNET_PAY/);
  assert.match(HIRE_SRC, /IS_MAINNET[\s\S]{0,120}headlessMainnetPay/,
    'the mainnet TTY refusal no longer consults the opt-in');
});

test('the JSON result reports the full txid', () => {
  // The human line prints substring(0, 16); if the JSON branch reuses that, a paying agent can
  // never learn the txid it broadcast.
  const jsonBlock = HIRE_SRC.slice(HIRE_SRC.indexOf('ok: true'));
  assert.ok(jsonBlock.length > 0, 'no success JSON block found');
  assert.match(jsonBlock, /\btxid,/, 'the JSON result does not carry txid');
  assert.ok(!/txid:\s*String\(txid\)\.substring/.test(jsonBlock), 'the JSON result truncates the txid');
});
