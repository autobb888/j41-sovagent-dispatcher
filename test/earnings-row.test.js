'use strict';
/**
 * The Earnings screen's numbers, pinned.
 *
 * Plan 2. This arithmetic used to live inline in dashboard.js, which runs
 * `main()` on require and drives Inquirer against a TTY — so it could not be
 * imported under `node --test` and was untestable by construction. A wrong
 * number on the money screen would have shown forever with no suite noticing.
 *
 * A pty smoke test would NOT have caught that either: in a sandbox the agents
 * are unregistered and unfunded, so every money path renders its degraded branch
 * and the assertion degenerates to em-dash == em-dash. The number has to be
 * tested here, deterministically, against fixtures.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildEarningsRow } = require('../src/wallet.js');

const R = 'RWoeXSRs4WHQYauzUg6bPowNyBRsz5bW51';
const I = 'i9j8RkZcqmdU8gMiTHvggtRAdwv4Q3VWJf';
const utxos = (...specs) => ({ address: R, iAddress: I, utxos: specs });
const at = (addr, satoshis) => ({ txid: 'a'.repeat(64), vout: 0, address: addr, satoshis });

test('a funded tank renders the exact balance and write count', () => {
  const row = buildEarningsRow({ agentId: 'agent-6', utxoRes: utxos(at(R, 13490000)) });
  assert.equal(row.feeSats, 13490000);
  assert.equal(row.writes, 1349);
  assert.equal(row.tankText, 'Tank: 0.13490000 (1349 writes)');
});

test('sweepable earnings are surfaced alongside the tank', () => {
  const row = buildEarningsRow({ agentId: 'a', utxoRes: utxos(at(R, 50000000), at(I, 17999900)) });
  assert.equal(row.sweepableSats, 17999900);
  assert.match(row.tankText, /\[0\.17999900 sweepable\]/);
});

test('an empty tank says EMPTY and names the address to fund', () => {
  const row = buildEarningsRow({ agentId: 'a', utxoRes: utxos(at(I, 500000)) });
  assert.equal(row.writes, 0);
  assert.match(row.tankText, /EMPTY — fund RWoe/);
  assert.match(row.tankText, /sweepable/, 'and it should say the money to fix it is right there');
});

test('a FAILED utxo lookup renders "(unavailable)" and NULL balances — never zero', () => {
  // The distinction the whole feature rests on. Zero means "we looked and it is
  // empty"; null means "we could not look". Conflating them is how an operator
  // funds an agent twice, or ignores one that is genuinely dry.
  for (const bad of [null, undefined, {}, { utxos: [] }, 'nope', 0]) {
    const row = buildEarningsRow({ agentId: 'a', utxoRes: bad });
    assert.equal(row.tankText, 'Tank: (unavailable)', `utxoRes=${JSON.stringify(bad)}`);
    assert.equal(row.feeSats, null, 'must be null, not 0');
    assert.equal(row.writes, null, 'must be null, not 0');
    assert.equal(row.sweepableSats, null, 'must be null, not 0');
  }
});

test('a low-but-nonzero tank is flagged LOW rather than passed over', () => {
  const row = buildEarningsRow({ agentId: 'a', utxoRes: utxos(at(R, 500000)), floorWrites: 100 });
  assert.equal(row.writes, 50);
  assert.match(row.tankText, /LOW/);
  assert.ok(!/EMPTY/.test(row.tankText), 'LOW and EMPTY are different states');
});

test('completed and delivered both count as earned; nothing else does', () => {
  const row = buildEarningsRow({
    agentId: 'a',
    jobs: [
      { status: 'completed', amount: '1.5' },
      { status: 'delivered', amount: '2.25' },
      { status: 'in_progress', amount: '99' },
      { status: 'disputed', amount: '99' },
    ],
  });
  assert.equal(row.completedCount, 2);
  assert.equal(row.earned, 3.75);
});

test('a garbage job amount cannot poison the total for the whole row', () => {
  const row = buildEarningsRow({
    agentId: 'a',
    jobs: [
      { status: 'completed', amount: '1.5' },
      { status: 'completed', amount: undefined },
      { status: 'completed', amount: 'free' },
      { status: 'completed' },
      null,
    ],
  });
  assert.equal(row.earned, 1.5, 'one bad amount must not turn the total into NaN');
  assert.ok(Number.isFinite(row.earned));
});

test('both balance shapes render, and neither renders as blank', () => {
  assert.equal(buildEarningsRow({ agentId: 'a', balance: { balances: [{ amount: 5, currency: 'VRSCTEST' }] } }).balanceText,
    '5 VRSCTEST');
  assert.equal(buildEarningsRow({ agentId: 'a', balance: { balance: 7, currency: 'VRSC' } }).balanceText,
    '7 VRSC');
  assert.equal(buildEarningsRow({ agentId: 'a', balance: null }).balanceText, '0');
  assert.equal(buildEarningsRow({ agentId: 'a', balance: { balances: [] } }).balanceText, '0');
});

test('missing jobs entirely is zero earned, not a crash', () => {
  for (const j of [null, undefined, 'nope', {}, 42]) {
    const row = buildEarningsRow({ agentId: 'a', jobs: j });
    assert.equal(row.completedCount, 0);
    assert.equal(row.earned, 0);
  }
});

test('called with no arguments at all it still returns a renderable row', () => {
  const row = buildEarningsRow();
  assert.equal(row.tankText, 'Tank: (unavailable)');
  assert.equal(row.earned, 0);
});

test('string satoshis do not inflate the tank (delegated to summarizeUtxos)', () => {
  const row = buildEarningsRow({ agentId: 'a', utxoRes: utxos(at(R, '500000'), at(R, '500000')) });
  assert.equal(row.feeSats, 0, 'string amounts must contribute nothing, never concatenate');
});

test('earnings are not rounded away — 0.005 must not display as 0.01, nor 1 sat as 0.00', () => {
  // toFixed(2) was hiding real money: agent job prices here are routinely in the
  // thousandths, so two decimals rounded a 0.005 job up to 0.01 and anything
  // under half a cent down to "0.00" — earnings displayed as nothing.
  const earned = (amount) => buildEarningsRow({ agentId: 'a', jobs: [{ status: 'completed', amount }] }).earnedText;
  assert.equal(earned('0.005'), '0.005');
  assert.equal(earned('0.00000001'), '0.00000001');
  assert.equal(earned('1.5'), '1.5', 'common cases stay readable — trailing zeros trimmed');
  assert.equal(buildEarningsRow({ agentId: 'a', jobs: [] }).earnedText, '0');
});

test('earnedText is present even when the tank lookup failed', () => {
  const row = buildEarningsRow({ agentId: 'a', utxoRes: null, jobs: [{ status: 'completed', amount: '2.5' }] });
  assert.equal(row.tankText, 'Tank: (unavailable)');
  assert.equal(row.earnedText, '2.5', 'a failed tank lookup must not blank the earnings column');
});
