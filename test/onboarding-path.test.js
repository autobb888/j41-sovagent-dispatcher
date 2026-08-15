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

test('the seeded message says the platform funds you, and names the amount', () => {
  const out = capture(() => printFundingInstructions('Rabc', 'verustest', { seeded: true }));
  assert.match(out, /0\.0033/, 'the seed amount must be named');
  assert.match(out, /do NOT need to acquire/i,
    'it must say plainly that no coins are needed up front');
});

test('CLASS: no funding text tells a newcomer to acquire coins before registering', () => {
  // The original version of this feature was backwards: it presented funding as
  // a prerequisite and pointed at a "faucet" that does not exist, blocking the
  // very step (registration) that provides the money.
  const both = capture(() => printFundingInstructions('Rabc', 'verustest', { seeded: true }))
    + capture(() => printFundingInstructions('Rabc', 'verustest'));
  assert.ok(!/faucet/i.test(both), 'there is no faucet — do not send anyone looking for one');
  assert.ok(!/discord/i.test(both), 'coins do not come from a chat server');
  // Look for the IMPERATIVE, not the word "before" — the correct copy legitimately
  // says "you do NOT need to acquire coins before registering", and a naive
  // keyword match flags that as the very thing it is denying.
  assert.ok(!/^\s*Send \d/mi.test(both), 'must not instruct anyone to send coins anywhere');
  assert.ok(!/Fund this address with/i.test(both),
    'the R-address is seeded by the platform, not funded by the operator');
});

test('the refill message points at the two real sources of more coins', () => {
  const out = capture(() => printFundingInstructions('Rabc', 'verustest'));
  assert.match(out, /wallet sweep/, 'an earning agent refills itself from its own earnings');
  assert.match(out, /wallet send/, 'a fleet agent can be topped up from another');
  assert.match(out, /never earned cannot self-fund/,
    'the one case needing outside help must be named');
});

test('the refill message still derives its currency from the network', () => {
  const testnet = capture(() => printFundingInstructions('Rabc', 'verustest'));
  const mainnet = capture(() => printFundingInstructions('Rabc', 'verus'));
  assert.match(testnet, /VRSCTEST/);
  assert.ok(!mainnet.includes('VRSCTEST'));
  assert.match(mainnet, /MAINNET — this is real money/);
});

test('the mainnet/testnet warning survives where it still matters — the README', () => {
  // The CLI no longer tells anyone to send coins anywhere, so the warning moved
  // to the one place that still discusses moving money by hand.
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /addresses look identical/i);
  assert.match(readme, /never send mainnet coins to a testnet agent/i);
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

test('CLASS: no user-facing output or default hardcodes a currency', () => {
  // The first version of this scanned only lines containing "fund", in cli.js
  // only — and both surviving defect clusters (deposit screens, dashboard
  // service pricing) sat exactly where it could not see. Scan every printed
  // line and every prompt default, in BOTH files.
  const offenders = [];
  for (const [name, text] of [['cli.js', CLI], ['dashboard.js', DASH]]) {
    text.split('\n').forEach((line, i) => {
      const isOutput = /console\.(log|error)|message:|default:/.test(line);
      if (!isOutput) return;
      if (/^\s*(\/\/|\*)/.test(line)) return;              // comments
      if (/networkCurrency|NATIVE_COIN/.test(line)) return;   // derived: fine
      // The testnet warning must NAME the mainnet coin — that is its whole job.
      if (/is NOT VRSC|sending real VRSC/.test(line)) return;
      // The USD price feed is genuinely denominated in mainnet VRSC even on
      // testnet; relabelling it VRSCTEST/USD would be the actual falsehood.
      if (/VRSC\/USD|platform VRSC rate/.test(line)) return;
      if (/VRSCTEST|'VRSC'|`VRSC`|\bVRSC\b/.test(line)) {
        offenders.push(`${name}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'user-facing currency must derive from the configured network');
});

test('CLASS: service-currency defaults derive from the network', () => {
  // A testnet fleet listing VRSC-priced services is how our own signed J41-JOB
  // payloads got inconsistent currency labels.
  assert.ok(!/'Service currency', 'VRSC'/.test(CLI),
    "no --service-currency option may default to the literal 'VRSC'");
  assert.match(CLI, /'Service currency', NATIVE_COIN/);
  // Do NOT assert a specific coin: that couples the suite to whatever network
  // the runner's config happens to name, so correct code fails on a
  // mainnet-configured machine. Assert the shape instead.
  assert.ok(['VRSC', 'VRSCTEST'].includes(NATIVE_COIN), `unexpected coin ${NATIVE_COIN}`);
});

test('setup does NOT gate registration on funding', () => {
  // It used to. That was backwards — Junction41 seeds the address AT
  // registration, so the gate blocked the step that delivers the money and sent
  // people looking for a faucet that does not exist.
  const start = CLI.indexOf('Step 2/4: Register identity on-chain');
  assert.ok(start > 0);
  const body = CLI.slice(start, start + 2500);
  assert.ok(!/Funded and ready to register/.test(body),
    'no funding confirmation may stand between the operator and registration');
  assert.match(body, /seeded: true/,
    'it should instead explain that the platform funds the new agent');
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

test('BEHAVIOUR: readMoneyAttention counts correctly and degrades to zero', () => {
  // Counting `catch` keywords in source (the first version of this test) proves
  // nothing about behaviour. Extract the real function and run it: it draws the
  // menu, so a corrupt ledger must not lock the operator out of the only
  // interface they have.
  const os = require('os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-money-'));
  const dir = path.join(home, '.j41', 'dispatcher');
  fs.mkdirSync(dir, { recursive: true });

  const src = DASH.slice(DASH.indexOf('function readMoneyAttention('),
                         DASH.indexOf('// ── ESC-to-back'));
  // eslint-disable-next-line no-new-func
  const make = new Function('fs', 'path', 'DISPATCHER_DIR', 'require',
    `${src}; return readMoneyAttention;`);
  const readMoneyAttention = make(fs, path, dir, require);

  fs.writeFileSync(path.join(dir, 'pending-refunds.json'), JSON.stringify({
    a: { status: 'pending_approval' },
    b: { status: 'sent' },
    c: { status: 'pending_approval' },
  }));
  fs.writeFileSync(path.join(dir, 'fee-tank-status.json'), JSON.stringify({
    at: Date.now(), agents: [{ agentId: 'x', needsFunding: true }, { agentId: 'y', needsFunding: false }],
  }));
  let r = readMoneyAttention([]);
  assert.equal(r.pendingRefunds, 2, 'only pending_approval counts');
  assert.equal(r.feeTanksNeedingFunding, 1, 'only empty tanks count');

  // Corrupt both ledgers: must degrade, not throw.
  fs.writeFileSync(path.join(dir, 'pending-refunds.json'), '{ not json');
  fs.writeFileSync(path.join(dir, 'fee-tank-status.json'), 'garbage');
  assert.doesNotThrow(() => { r = readMoneyAttention([]); });
  assert.equal(r.pendingRefunds, 0);
  assert.equal(r.feeTanksNeedingFunding, 0);

  // Missing files and a null agent list.
  fs.rmSync(path.join(dir, 'pending-refunds.json'));
  fs.rmSync(path.join(dir, 'fee-tank-status.json'));
  assert.doesNotThrow(() => { r = readMoneyAttention(null); });
  assert.deepEqual({ p: r.pendingRefunds, f: r.feeTanksNeedingFunding }, { p: 0, f: 0 });
  fs.rmSync(home, { recursive: true, force: true });
});

test('a drained fee tank is surfaced on the first screen, not only inside [19]', () => {
  // Half of B5's original finding. An agent whose R-address empties goes silent
  // on-chain — no reviews, no attestations — while the menu said nothing.
  assert.match(DASH, /feeTanksNeedingFunding/);
  assert.match(DASH, /EMPTY fee tank/);
  assert.match(CLI, /FEE_TANK_STATUS_PATH/,
    'the daemon must persist the status for the separate TUI process to read');
});

test('the TUI money screens shell out to the CLI instead of copying money logic', () => {
  // A second implementation of the refund path would be a second place for the
  // allowlist, value ceiling and in-flight marker to be got wrong.
  const start = DASH.indexOf('async function moneyScreen(');
  assert.ok(start > 0);
  const body = DASH.slice(start, start + 900);
  assert.match(body, /runCommandAsync\(process\.execPath, \[process\.argv\[1\]/);
});

test('every TUI money CALL SITE passes a read-only verb', () => {
  // The earlier version of this test grepped moneyScreen's own body, where a
  // mutating verb could never appear — it would have passed while a call site
  // said `['refunds','approve','--all','--yes']`. Assert on the arguments that
  // are actually handed over.
  const calls = [...DASH.matchAll(/moneyScreen\(inquirer,[^,]+,\s*(\[[^\]]*\])/g)].map(m => m[1]);
  assert.ok(calls.length >= 3, `expected at least 3 money screens, found ${calls.length}`);
  const MUTATING = ['approve', 'reject', 'sweep', 'send', 'credit', 'dismiss', 'unblock', '--yes', '--all'];
  for (const call of calls) {
    for (const verb of MUTATING) {
      assert.ok(!call.includes(`'${verb}'`),
        `a money screen passes the mutating verb ${verb}: ${call}`);
    }
  }
});

test('the refund drain counts only what an operator can still act on', () => {
  // It used to be `jobIds.length - approvedIds.length`, which counted every
  // terminal entry — already-sent `refunded` rows and `rejected` ones. The
  // "awaiting owner approval" figure therefore GREW each time a refund was
  // settled and could never reach zero. Found on the live fleet: it claimed 24
  // awaiting when 20 were. A money number that only climbs as you clear the
  // queue trains operators to ignore it.
  const idx = CLI.indexOf('awaiting owner approval');
  assert.ok(idx > 0, 'the drain summary must exist');
  // Strip comment lines: the fix's own comment quotes the old expression to
  // explain it, and matching raw source would flag the explanation as the bug.
  const body = CLI.slice(idx - 1200, idx + 200)
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.match(body, /pending_approval/, 'the count must be status-filtered');
  assert.ok(!/jobIds\.length - approvedIds\.length/.test(body),
    'must not derive the count by subtracting from every ledger entry');
});
