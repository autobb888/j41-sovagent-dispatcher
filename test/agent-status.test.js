'use strict';
/**
 * Unit tests for `src/agent-status.js` — the pure decision/formatting brain for
 * diagnosing why a marketplace agent is/isn't hireable and for interpreting
 * on-chain activation results.
 *
 * Pure module: no I/O, no network. On-chain `status` is the source of truth;
 * an activation whose on-chain txid is null did NOT happen (treated as failed).
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  networkCurrency,
  currencyMatches,
  servicePayable,
  diagnoseAgent,
  interpretActivation,
  needsActivation,
  hireCell,
  formatDoctorReport,
} = require('../src/agent-status.js');

// ── networkCurrency ───────────────────────────────────────────────────────────

test('networkCurrency: known networks', () => {
  assert.strictEqual(networkCurrency('verus'), 'VRSC');
  assert.strictEqual(networkCurrency('verustest'), 'VRSCTEST');
});

test('networkCurrency: unknown → null', () => {
  assert.strictEqual(networkCurrency('bitcoin'), null);
  assert.strictEqual(networkCurrency(undefined), null);
  assert.strictEqual(networkCurrency(null), null);
});

// ── currencyMatches ───────────────────────────────────────────────────────────

test('currencyMatches: case-insensitive equality', () => {
  assert.strictEqual(currencyMatches('vrsctest', 'VRSCTEST'), true);
  assert.strictEqual(currencyMatches('VRSC', 'vrsc'), true);
  assert.strictEqual(currencyMatches('VRSC', 'VRSCTEST'), false);
});

test('currencyMatches: i-address → null (indeterminate, never blocks/warns)', () => {
  // ~34 char base58 i-address can't be resolved offline.
  assert.strictEqual(
    currencyMatches('iJhCezBexJHvtyH3fGhNnt2NhU4Ztkf2yq', 'VRSCTEST'),
    null,
  );
});

test('currencyMatches: missing inputs', () => {
  assert.strictEqual(currencyMatches(null, 'VRSC'), false);
  assert.strictEqual(currencyMatches('VRSC', null), false);
});

// ── servicePayable ────────────────────────────────────────────────────────────

test('servicePayable: direct currency + price > 0', () => {
  assert.strictEqual(
    servicePayable({ status: 'active', currency: 'VRSCTEST', price: '5' }, 'VRSCTEST'),
    true,
  );
});

test('servicePayable: via acceptedCurrencies', () => {
  const svc = {
    status: 'active',
    currency: 'USD',
    price: '0',
    acceptedCurrencies: [{ currency: 'VRSCTEST', price: '3' }],
  };
  assert.strictEqual(servicePayable(svc, 'VRSCTEST'), true);
});

test('servicePayable: inactive → false even if priced', () => {
  assert.strictEqual(
    servicePayable({ status: 'inactive', currency: 'VRSCTEST', price: '5' }, 'VRSCTEST'),
    false,
  );
});

test('servicePayable: zero price → false', () => {
  assert.strictEqual(
    servicePayable({ status: 'active', currency: 'VRSCTEST', price: '0' }, 'VRSCTEST'),
    false,
  );
});

test('servicePayable: wrong currency → false', () => {
  assert.strictEqual(
    servicePayable({ status: 'active', currency: 'VRSC', price: '5' }, 'VRSCTEST'),
    false,
  );
});

// ── diagnoseAgent ─────────────────────────────────────────────────────────────

const okRefresh = { agent: true, services: true };

test('diagnoseAgent: active + payable → hireable, no blockers', () => {
  const d = diagnoseAgent({
    platformStatus: 'active',
    network: 'verustest',
    services: [{ status: 'active', currency: 'VRSCTEST', price: '5' }],
    refresh: okRefresh,
  });
  assert.strictEqual(d.hireable, true);
  assert.strictEqual(d.blockers.length, 0);
});

test('diagnoseAgent: inactive → agent_inactive blocker; fix has on-chain activate, not --platform-only', () => {
  const d = diagnoseAgent({
    platformStatus: 'inactive',
    network: 'verustest',
    services: [{ status: 'active', currency: 'VRSCTEST', price: '5' }],
    refresh: okRefresh,
  });
  assert.strictEqual(d.hireable, false);
  const b = d.blockers.find((x) => x.code === 'agent_inactive');
  assert.ok(b, 'expected agent_inactive blocker');
  assert.match(b.fix, /node src\/cli\.js activate /);
  // The fix must NOT instruct using --platform-only; it must say to do a real
  // on-chain activate and explicitly call out --platform-only as wrong.
  assert.doesNotMatch(b.fix, /use --platform-only/i);
  assert.match(b.fix, /--platform-only/);
  assert.match(b.fix.toLowerCase(), /on-chain|on chain/);
});

test('diagnoseAgent: disabled → agent_inactive blocker', () => {
  const d = diagnoseAgent({
    platformStatus: 'disabled',
    network: 'verustest',
    services: [{ status: 'active', currency: 'VRSCTEST', price: '5' }],
    refresh: okRefresh,
  });
  assert.ok(d.blockers.some((x) => x.code === 'agent_inactive'));
  assert.strictEqual(d.hireable, false);
});

test('diagnoseAgent: mainnet-only service on testnet → WARNING not blocker, hireable stays true', () => {
  const d = diagnoseAgent({
    platformStatus: 'active',
    network: 'verustest',
    services: [{ status: 'active', currency: 'VRSC', price: '5' }],
    refresh: okRefresh,
  });
  assert.strictEqual(d.hireable, true);
  assert.strictEqual(d.blockers.length, 0);
  assert.ok(
    d.warnings.some((w) => /no active service priced in VRSCTEST/i.test(w)),
    'expected no-payable-in-currency warning',
  );
});

test('diagnoseAgent: no active service, non-api → no_active_service blocker', () => {
  const d = diagnoseAgent({
    platformStatus: 'active',
    network: 'verustest',
    services: [{ status: 'inactive', currency: 'VRSCTEST', price: '5' }],
    refresh: okRefresh,
  });
  assert.strictEqual(d.hireable, false);
  assert.ok(d.blockers.some((x) => x.code === 'no_active_service'));
});

test('diagnoseAgent: api-endpoint with no service → hireable (no no_active_service blocker)', () => {
  const d = diagnoseAgent({
    platformStatus: 'active',
    network: 'verustest',
    services: [],
    isApiEndpoint: true,
    refresh: okRefresh,
  });
  assert.strictEqual(d.hireable, true);
  assert.ok(!d.blockers.some((x) => x.code === 'no_active_service'));
});

test('diagnoseAgent: stale on-chain service (refresh.services=false) → blocker w/ runnable fix', () => {
  const d = diagnoseAgent({
    platformStatus: 'active',
    network: 'verustest',
    services: [{ status: 'active', currency: 'VRSCTEST', price: '5' }],
    refresh: { agent: true, services: false },
  });
  assert.strictEqual(d.hireable, false);
  const b = d.blockers.find((x) => x.code === 'stale_onchain_service');
  assert.ok(b, 'expected stale_onchain_service blocker');
  assert.match(b.fix, /node src\/cli\.js /);
});

test('diagnoseAgent: undefined status → status_unknown WARNING, no agent_inactive blocker', () => {
  const d = diagnoseAgent({
    platformStatus: undefined,
    network: 'verustest',
    services: [{ status: 'active', currency: 'VRSCTEST', price: '5' }],
    refresh: okRefresh,
  });
  assert.ok(d.warnings.some((w) => /status unknown/i.test(w)));
  assert.ok(!d.blockers.some((x) => x.code === 'agent_inactive'));
});

test('diagnoseAgent: revoked → agent_revoked blocker; fix does NOT say run activate', () => {
  const d = diagnoseAgent({
    platformStatus: 'revoked',
    network: 'verustest',
    services: [{ status: 'active', currency: 'VRSCTEST', price: '5' }],
    refresh: okRefresh,
  });
  assert.strictEqual(d.hireable, false);
  const b = d.blockers.find((x) => x.code === 'agent_revoked');
  assert.ok(b, 'expected agent_revoked blocker');
  assert.match(b.problem, /revoked/i);
  assert.doesNotMatch(b.fix, /run activate/i);
  assert.doesNotMatch(b.fix, /node src\/cli\.js activate/);
});

test('diagnoseAgent: pending → agent_pending blocker pointing to finalize', () => {
  const d = diagnoseAgent({
    platformStatus: 'pending',
    network: 'verustest',
    services: [{ status: 'active', currency: 'VRSCTEST', price: '5' }],
    refresh: okRefresh,
  });
  assert.strictEqual(d.hireable, false);
  const b = d.blockers.find((x) => x.code === 'agent_pending');
  assert.ok(b, 'expected agent_pending blocker');
  assert.match(b.fix, /finalize/i);
});

test('diagnoseAgent: zero-priced-only active service → 0-priced warning', () => {
  const d = diagnoseAgent({
    platformStatus: 'active',
    network: 'verustest',
    services: [{ status: 'active', currency: 'VRSCTEST', price: '0' }],
    refresh: okRefresh,
  });
  assert.strictEqual(d.hireable, true);
  assert.ok(d.warnings.some((w) => /0-priced/i.test(w)));
});

test('diagnoseAgent: low funding → funds warning, no blocker', () => {
  const d = diagnoseAgent({
    platformStatus: 'active',
    network: 'verustest',
    services: [{ status: 'active', currency: 'VRSCTEST', price: '5' }],
    refresh: okRefresh,
    funding: 0,
  });
  assert.strictEqual(d.hireable, true);
  assert.ok(d.warnings.some((w) => /fund/i.test(w)));
});

test('diagnoseAgent: i-address currency service is not flagged as unpriced (null never warns)', () => {
  const d = diagnoseAgent({
    platformStatus: 'active',
    network: 'verustest',
    services: [{ status: 'active', currency: 'iJhCezBexJHvtyH3fGhNnt2NhU4Ztkf2yq', price: '5' }],
    refresh: okRefresh,
  });
  // can't resolve currency offline → indeterminate, so no no-payable warning
  assert.ok(!d.warnings.some((w) => /no active service priced in/i.test(w)));
  assert.strictEqual(d.hireable, true);
});

// ── interpretActivation ───────────────────────────────────────────────────────

test('interpretActivation: null txid + canSign → failed/broadcast_failed (reason mentions funds/RPC)', () => {
  const r = interpretActivation({
    expected: 'active',
    onChainTxid: null,
    getAgentStatus: 'active',
    refresh: { agent: true },
    canSignOnChain: true,
  });
  assert.strictEqual(r.state, 'failed');
  assert.strictEqual(r.code, 'broadcast_failed');
  assert.match(r.reason, /fund|rpc/i);
});

test('interpretActivation: null txid + no signing → failed/no_signing_capability (no funds/RPC mention)', () => {
  const r = interpretActivation({
    expected: 'active',
    onChainTxid: null,
    getAgentStatus: 'active',
    refresh: { agent: true },
    canSignOnChain: false,
  });
  assert.strictEqual(r.state, 'failed');
  assert.strictEqual(r.code, 'no_signing_capability');
  assert.doesNotMatch(r.reason, /fund/i);
  assert.doesNotMatch(r.reason, /rpc/i);
});

test('interpretActivation: txid + status matches expected → confirmed', () => {
  const r = interpretActivation({
    expected: 'active',
    onChainTxid: 'abc123',
    getAgentStatus: 'active',
    refresh: { agent: true },
    canSignOnChain: true,
  });
  assert.strictEqual(r.state, 'confirmed');
});

test('interpretActivation: txid + stale/undefined status → pending (lag, never failed)', () => {
  const r = interpretActivation({
    expected: 'active',
    onChainTxid: 'abc123',
    getAgentStatus: undefined,
    refresh: { agent: false },
    canSignOnChain: true,
  });
  assert.strictEqual(r.state, 'pending');
  assert.match(r.reason, /lag|block|index/i);
});

test('interpretActivation: txid + 429 refreshError → pending (throttle never failed)', () => {
  const r = interpretActivation({
    expected: 'active',
    onChainTxid: 'abc123',
    getAgentStatus: 'inactive',
    refresh: { agent: true },
    refreshError: 429,
    canSignOnChain: true,
  });
  assert.strictEqual(r.state, 'pending');
});

// ── needsActivation ───────────────────────────────────────────────────────────

test('needsActivation: tri-state', () => {
  assert.strictEqual(needsActivation('active'), false);
  assert.strictEqual(needsActivation('inactive'), true);
  assert.strictEqual(needsActivation(undefined), true);
});

// ── hireCell ──────────────────────────────────────────────────────────────────

test('hireCell: tri-state', () => {
  assert.strictEqual(hireCell({ hireable: true }), '✅');
  assert.strictEqual(hireCell({ hireable: false, reason: 'revoked' }), '❌(revoked)');
  assert.strictEqual(hireCell({ hireable: false }), '❌(?)');
  assert.strictEqual(hireCell({ hireable: null }), '?');
  assert.strictEqual(hireCell({}), '?');
});

// ── formatDoctorReport ────────────────────────────────────────────────────────

test('formatDoctorReport: hireable row, not refreshed → as-of footer, no anyBlocked', () => {
  const out = formatDoctorReport(
    [
      {
        id: 'agent-1',
        identity: 'alice@',
        diagnosis: { hireable: true, blockers: [], warnings: ['minor warn'] },
      },
    ],
    { refreshed: false },
  );
  assert.strictEqual(out.anyBlocked, false);
  assert.ok(out.lines.some((l) => l.includes('agent-1') && l.includes('✅')));
  assert.ok(out.lines.some((l) => l.includes('⚠') && l.includes('minor warn')));
  assert.ok(
    out.lines.some((l) => /as of last indexer pass/i.test(l) && /--refresh/.test(l)),
    'expected as-of-last-indexer footer',
  );
});

test('formatDoctorReport: blocked row → anyBlocked true, blocker line, no footer when refreshed', () => {
  const out = formatDoctorReport(
    [
      {
        id: 'agent-2',
        identity: 'bob@',
        diagnosis: {
          hireable: false,
          blockers: [{ code: 'agent_inactive', problem: 'agent is inactive', fix: 'run activate' }],
          warnings: [],
        },
      },
    ],
    { refreshed: true },
  );
  assert.strictEqual(out.anyBlocked, true);
  assert.ok(out.lines.some((l) => l.includes('agent-2') && l.includes('❌')));
  assert.ok(
    out.lines.some(
      (l) => l.includes('✗') && l.includes('agent_inactive') && l.includes('→') && l.includes('run activate'),
    ),
    'expected blocker line with code, problem → fix',
  );
  assert.ok(!out.lines.some((l) => /as of last indexer pass/i.test(l)), 'no footer when refreshed');
});
