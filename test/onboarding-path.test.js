'use strict';
/**
 * The install-to-earning path (B2/B3/B4/B5 of the 2026-08-14 soft-launch audit,
 * docs/testing/2026-08-14-soft-launch-readiness.md).
 *
 * All four blockers were the same shape: the product knew a prerequisite and
 * told the user nowhere, too late, or in a path they could not execute.
 *
 *  - B2 no funding path: no faucet, no amount, and `init` said "VRSC" while
 *    `wallet show` said "VRSCTEST" for the same agent on the same install.
 *  - B3 the install could not reach the image build: a repo-relative script
 *    handed to a `yarn global add` audience, with no preflight, surfacing as a
 *    raw dockerode error AFTER a buyer's job was accepted.
 *  - B4 silence between `start` and the first job.
 *  - B5 the TUI showed no money surface at all.
 *
 * The lesson from the confirm-defaults fix earlier the same day is applied
 * here: assert over the CLASS, not over the instances already known. Checking
 * only the lines an audit found shipped a two-thirds fix last time.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
const { printFundingInstructions, NATIVE_COIN } = require('../src/cli.js');

const SRC = path.join(__dirname, '..', 'src');
const CLI = fs.readFileSync(path.join(SRC, 'cli.js'), 'utf8');
const DASH = fs.readFileSync(path.join(SRC, 'dashboard.js'), 'utf8');

/** Capture console.log output from a synchronous call. */
function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { fn(); } finally { console.log = orig; }
  return lines.join('\n');
}

// ── B2: there is a path to money ────────────────────────────────────────────

test('funding instructions name the network\'s own currency, not a hardcoded one', () => {
  const testnet = capture(() => printFundingInstructions('Rabc', 'verustest'));
  const mainnet = capture(() => printFundingInstructions('Rabc', 'verus'));

  assert.match(testnet, /VRSCTEST/);
  assert.ok(!/\bVRSC\b(?!TEST)/.test(testnet.replace(/NOT VRSC|real VRSC/g, '')),
    'a testnet message must not tell the user to send VRSC');
  assert.match(mainnet, /\bVRSC\b/);
  assert.ok(!mainnet.includes('VRSCTEST'), 'a mainnet message must not mention testnet coins');
});

test('funding instructions state an amount', () => {
  const out = capture(() => printFundingInstructions('Rabc', 'verustest'));
  assert.match(out, /0\.0001/, 'the registration cost must be named');
  assert.match(out, /Send 1 VRSCTEST/, 'a usable recommended amount must be named');
});

test('funding instructions name where to actually get testnet coins', () => {
  const out = capture(() => printFundingInstructions('Rabc', 'verustest'));
  assert.match(out, /faucet/i);
  assert.match(out, /discord\.gg\/veruscoin/, 'the faucet must be a real reachable pointer');
});

test('funding instructions warn that testnet and mainnet addresses are indistinguishable', () => {
  // This is the one that loses real money: told "VRSC", a newcomer may buy and
  // send mainnet coins to a testnet-purposed address that looks identical.
  const out = capture(() => printFundingInstructions('Rabc', 'verustest'));
  assert.match(out, /NOT VRSC/);
  assert.match(out, /identical/i);
});

test('a mainnet funding message says it is real money and offers no faucet', () => {
  const out = capture(() => printFundingInstructions('Rabc', 'verus'));
  assert.match(out, /MAINNET/);
  assert.ok(!/faucet/i.test(out), 'there is no mainnet faucet — offering one would be a lie');
});

test('the address is echoed so the user does not have to go find it', () => {
  const out = capture(() => printFundingInstructions('RtheAddress', 'verustest'));
  assert.match(out, /RtheAddress/);
});

test('printFundingInstructions tolerates a missing address', () => {
  // `init` calls it for a whole fleet, where no single address applies.
  const out = capture(() => printFundingInstructions(null, 'verustest'));
  assert.match(out, /VRSCTEST/);
  assert.ok(!out.includes('null'));
});

test('CLASS: no user-facing funding message hardcodes a currency', () => {
  // The original defect was two messages disagreeing. Assert no funding-shaped
  // string carries a literal coin name, so a third cannot drift back in.
  const offenders = [];
  CLI.split('\n').forEach((line, i) => {
    if (!/console\.(log|error)/.test(line)) return;
    if (!/\bfund|\bFund/.test(line)) return;
    if (/VRSCTEST|'VRSC'|\bVRSC\b/.test(line)) offenders.push(`cli.js:${i + 1}: ${line.trim()}`);
  });
  assert.deepEqual(offenders, [],
    'funding messages must derive their currency from the network');
});

test('CLASS: service-currency defaults derive from the network', () => {
  // A testnet fleet listing VRSC-priced services is how our own signed J41-JOB
  // payloads got inconsistent currency labels.
  assert.ok(!/'Service currency', 'VRSC'/.test(CLI),
    "no --service-currency option may default to the literal 'VRSC'");
  assert.match(CLI, /'Service currency', NATIVE_COIN/);
  assert.equal(NATIVE_COIN, 'VRSCTEST', 'this checkout is configured for testnet');
});

test('setup pauses for funding before it spends, and refuses headless rather than guessing', () => {
  const start = CLI.indexOf('Step 2/4: Register identity on-chain');
  assert.ok(start > 0);
  const body = CLI.slice(start, start + 2200);
  assert.match(body, /printFundingInstructions\(keys\.address/,
    'the funding instructions must appear before registration');
  assert.match(body, /Funded and ready to register\?/);
  assert.match(body, /process\.exit\(2\)/,
    'a non-TTY unfunded setup must refuse with a distinct code, not register blindly');
  assert.match(body, /options\.yes/, 'scripted callers who funded ahead must have a way through');
});

// ── B3: the image build is reachable ────────────────────────────────────────

test('build-image is a real command, so the build script is reachable from a global install', () => {
  assert.match(CLI, /\.command\('build-image'\)/);
  assert.match(CLI, /buildImageScriptPath/);
  // It must resolve relative to the module, not the caller's cwd.
  const start = CLI.indexOf('function buildImageScriptPath(');
  const body = CLI.slice(start, start + 300);
  assert.match(body, /__dirname/, 'the path must resolve from our own location');
});

test('the bundled build script actually ships in the npm tarball', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('scripts'), 'scripts/ must be in package.json files');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'build-image.sh')),
    'the script build-image resolves to must exist');
});

test('start refuses when the job image is missing, before any buyer can pay', () => {
  const start = CLI.indexOf('Refusing to start: the job image');
  assert.ok(start > 0, 'the preflight must exist');
  const body = CLI.slice(start - 400, start + 700);
  assert.match(body, /jobImageExists\(\)/);
  assert.match(body, /no buyer can pay into this fleet/);
  assert.match(body, /build-image/, 'the error must name the fix');
  assert.match(body, /process\.exit\(1\)/);
});

test('the image preflight does not fire in local mode', () => {
  // local mode does not use the image at all; refusing there would be a lie.
  const idx = CLI.indexOf('Refusing to start: the job image');
  const guard = CLI.slice(CLI.lastIndexOf('if (', idx), idx);
  assert.match(guard, /RUNTIME !== 'local'/);
});

test('jobImageExists never throws when docker is absent', () => {
  const { jobImageExists } = require('../src/cli.js');
  assert.doesNotThrow(() => jobImageExists());
  assert.equal(typeof jobImageExists(), 'boolean');
});

// ── B4: the operator can tell running from broken ───────────────────────────

test('start prints proof the fleet is live and an honest expectation', () => {
  const idx = CLI.indexOf('Your fleet is live');
  assert.ok(idx > 0, 'the fleet summary must exist');
  const body = CLI.slice(idx, idx + 1400);
  assert.match(body, /inspect \$\{readyAgents/, 'must show how to verify a listing');
  assert.match(body, /ctl status/, 'must show how to watch activity');
  assert.match(body, /ctl earnings/, 'must show how to check earnings');
  assert.match(body, /silence here is normal/,
    'must set the expectation, since silence is this system\'s failure mode too');
  assert.ok(idx < CLI.indexOf('Starting job listener'),
    'the summary must print before the listener message');
});

// ── B5: the TUI has a money surface ─────────────────────────────────────────

test('the dashboard menu exposes wallet, refunds and deposits', () => {
  for (const v of ["value: 'wallet'", "value: 'refunds'", "value: 'deposits'"]) {
    assert.ok(DASH.includes(v), `menu must offer ${v}`);
  }
  assert.match(DASH, /── Money ──/);
});

test('each money menu entry has a handler', () => {
  for (const c of ["case 'wallet':", "case 'refunds':", "case 'deposits':"]) {
    assert.ok(DASH.includes(c), `missing handler ${c}`);
  }
});

test('money owed to buyers is surfaced on the FIRST screen, not buried', () => {
  // The whole defect was that a dashboard-dwelling operator never learned that
  // refunds were pending or a fee tank had drained.
  const idx = DASH.indexOf('const money = readMoneyAttention(');
  assert.ok(idx > 0, 'the menu must compute the counts');
  const body = DASH.slice(idx, idx + 700);
  assert.match(body, /awaiting your approval/);
  assert.match(body, /buyers are owed until you act/);
});

test('readMoneyAttention degrades to zero rather than blocking the TUI', () => {
  // It runs on the way to drawing a menu; a corrupt ledger must not lock the
  // operator out of the only interface they have.
  const start = DASH.indexOf('function readMoneyAttention(');
  const body = DASH.slice(start, start + 1400);
  assert.equal((body.match(/catch/g) || []).length >= 3, true,
    'every read must be individually guarded');
  assert.match(body, /out\.pendingRefunds = 0|pendingRefunds: 0/);
});

test('the TUI money screens shell out to the CLI instead of copying money logic', () => {
  // A second implementation of the refund path would be a second place for the
  // allowlist, value ceiling and in-flight marker to be got wrong.
  const start = DASH.indexOf('async function moneyScreen(');
  assert.ok(start > 0);
  const body = DASH.slice(start, start + 900);
  assert.match(body, /runCommandAsync\(process\.execPath, \[process\.argv\[1\]/);
  for (const verb of ['approve', 'reject', 'sweep', 'send', 'credit', 'dismiss']) {
    assert.ok(!new RegExp(`'${verb}'\\s*\\]`).test(body),
      `moneyScreen must not invoke the mutating verb ${verb}`);
  }
});
