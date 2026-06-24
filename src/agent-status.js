'use strict';
/**
 * agent-status.js — pure decision/formatting brain for the dispatcher's
 * "agent doctor". No I/O, no network, no requires beyond node stdlib.
 *
 * Core principle: on-chain `status` is the source of truth. An activation
 * whose on-chain txid is null did NOT happen and is treated as failed —
 * never success. Currency is NEVER a hireability blocker (the backend does
 * not gate status on currency); it can only ever produce a warning. Where a
 * currency cannot be resolved offline (Verus i-addresses) the comparison is
 * indeterminate (null) and is never used to block or warn.
 */

// ── currency helpers ──────────────────────────────────────────────────────────

/** Map a network name to its native currency ticker, or null if unknown. */
function networkCurrency(network) {
  if (network === 'verus') return 'VRSC';
  if (network === 'verustest') return 'VRSCTEST';
  return null;
}

/**
 * Does a Verus i-address style identifier appear? These resolve to a currency
 * only via on-chain lookup, which this pure module cannot perform — so any
 * comparison against one is indeterminate.
 *
 * i-addresses: start with 'i', ~34 chars, base58-ish (no 0 O I l).
 */
function looksLikeIAddress(s) {
  if (typeof s !== 'string') return false;
  if (s[0] !== 'i') return false;
  if (s.length < 33 || s.length > 36) return false;
  return /^i[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

/**
 * Case-insensitive currency comparison.
 * @returns true|false for resolvable tickers, or null (indeterminate) when
 *          serviceCurrency is an i-address. null is NEVER used to block/warn.
 */
function currencyMatches(serviceCurrency, netCur) {
  if (looksLikeIAddress(serviceCurrency)) return null;
  if (typeof serviceCurrency !== 'string' || typeof netCur !== 'string') {
    return false;
  }
  return serviceCurrency.toLowerCase() === netCur.toLowerCase();
}

/**
 * Is this service payable in `netCur`? Active, and either its primary
 * currency matches with a positive price, or one of its acceptedCurrencies
 * does. Indeterminate (i-address) currencies never count as payable here.
 */
function servicePayable(service, netCur) {
  if (!service || service.status !== 'active') return false;
  if (currencyMatches(service.currency, netCur) === true && Number(service.price) > 0) {
    return true;
  }
  return Array.isArray(service.acceptedCurrencies)
    ? service.acceptedCurrencies.some(
        (a) =>
          a &&
          typeof a === 'object' &&
          currencyMatches(a.currency, netCur) === true &&
          Number(a.price) > 0,
      )
    : false;
}

// ── diagnoseAgent ─────────────────────────────────────────────────────────────

const RECOVERABLE_INACTIVE = new Set(['inactive', 'disabled']);

/**
 * Diagnose why an agent is/isn't hireable.
 * @returns { hireable, blockers:[{code,problem,fix}], warnings:[string] }
 */
function diagnoseAgent(input) {
  const {
    platformStatus,
    network,
    services = [],
    isApiEndpoint,
    refresh,
    funding,
  } = input || {};

  const blockers = [];
  const warnings = [];
  const netCur = networkCurrency(network);
  const agentId = '<agent-id>';

  // ── status-derived blockers / warnings ──
  if (platformStatus == null) {
    warnings.push('platform status unknown — could not read agent status from the indexer');
  } else if (RECOVERABLE_INACTIVE.has(platformStatus)) {
    blockers.push({
      code: 'agent_inactive',
      problem: `agent is ${platformStatus} on the platform; buyers cannot hire it`,
      // Must be a REAL on-chain activate. --platform-only only flips the indexer
      // flag, which the indexer then reverts on its next chain read.
      fix:
        `node src/cli.js activate ${agentId} — this must be a real on-chain activate ` +
        `(without --platform-only, which only flips the indexer flag and gets reverted on the next chain read)`,
    });
  } else if (platformStatus === 'revoked') {
    blockers.push({
      code: 'agent_revoked',
      problem: 'agent identity is revoked on-chain and cannot serve jobs',
      // A revoked identity CANNOT be reactivated — must NOT suggest activate.
      fix: 'a revoked identity cannot be reactivated; register a fresh agent identity instead',
    });
  } else if (platformStatus === 'pending') {
    blockers.push({
      code: 'agent_pending',
      problem: 'agent onboarding is still pending and is not yet live',
      fix: `finalize onboarding: node src/cli.js finalize ${agentId}`,
    });
  } else if (platformStatus !== 'active') {
    // Catch-all: any present status that is neither 'active' nor a specifically
    // handled value (inactive/disabled/revoked/pending) must still block.
    blockers.push({
      code: 'agent_not_active',
      problem: `agent status is '${platformStatus}' (not active) — buyers cannot hire it`,
      fix: 'investigate the on-chain status; run: node src/cli.js doctor <agent-id> --refresh',
    });
  }

  // ── service blockers ──
  const activeServices = Array.isArray(services)
    ? services.filter((s) => s && s.status === 'active')
    : [];

  if (activeServices.length === 0 && isApiEndpoint !== true) {
    blockers.push({
      code: 'no_active_service',
      problem: 'agent has no active service offering, so it cannot be hired',
      fix: `add and activate at least one service: node src/cli.js dashboard (Configure Services), or node src/cli.js finalize ${agentId}`,
    });
  }

  // Stale on-chain service listing — the indexer's view of services is behind
  // chain and must be republished.
  // NOTE: `finalize` is used here as the republish command; confirm the exact
  // republish subcommand against the live CLI before relying on it.
  if (refresh && refresh.services === false) {
    blockers.push({
      code: 'stale_onchain_service',
      problem: 'on-chain service listing is stale / out of sync with the indexer',
      fix: `republish the on-chain service listing: node src/cli.js finalize ${agentId}`,
    });
  }

  // ── currency warnings (NEVER blockers) ──
  // Only warn when the currency situation is actually determinable. If every
  // active service's currency is an i-address (indeterminate → null), we cannot
  // know offline whether it's payable, and null must never warn.
  const currencyDeterminable = (s) => {
    if (currencyMatches(s.currency, netCur) !== null) return true;
    return (
      Array.isArray(s.acceptedCurrencies) &&
      s.acceptedCurrencies.some(
        (a) =>
          a && typeof a === 'object' && currencyMatches(a.currency, netCur) !== null,
      )
    );
  };
  const determinable = activeServices.filter(currencyDeterminable);
  if (netCur !== null && determinable.length > 0) {
    const payable = activeServices.filter((s) => servicePayable(s, netCur));
    if (payable.length === 0) {
      // Is the only reason a price-of-0, or a genuine currency mismatch?
      // Distinguish so we can emit the more specific "0-priced" warning.
      const zeroPricedInCur = activeServices.some((s) => {
        const primZero =
          currencyMatches(s.currency, netCur) === true && Number(s.price) === 0;
        const acceptedZero =
          Array.isArray(s.acceptedCurrencies) &&
          s.acceptedCurrencies.some(
            (a) =>
              a &&
              typeof a === 'object' &&
              currencyMatches(a.currency, netCur) === true &&
              Number(a.price) === 0,
          );
        return primZero || acceptedZero;
      });
      if (zeroPricedInCur) {
        warnings.push(
          `the only active service(s) in ${netCur} are 0-priced — set a positive price so buyers can pay`,
        );
      } else {
        warnings.push(
          `no active service priced in ${netCur} — buyers on this network cannot pay`,
        );
      }
    }
  }

  // ── funding warning ──
  if (funding != null && Number(funding) <= 0) {
    warnings.push('agent appears to be low on funds; top up so it can cover on-chain fees');
  }

  return { hireable: blockers.length === 0, blockers, warnings };
}

// ── interpretActivation ───────────────────────────────────────────────────────

/**
 * Interpret an on-chain activation attempt.
 * @returns { state: 'confirmed'|'pending'|'failed', code?, reason }
 *
 * Precedence:
 *  1. onChainTxid == null → failed. No broadcast happened.
 *  2. status read back === expected → confirmed.
 *  3. otherwise → pending (stale/undefined status, refresh.agent===false,
 *     or a throttled 429 read — a lagging/throttled read is NEVER failed).
 */
function interpretActivation(opts) {
  const { expected, onChainTxid, getAgentStatus, canSignOnChain } = opts || {};

  if (onChainTxid == null) {
    if (canSignOnChain) {
      return {
        state: 'failed',
        code: 'broadcast_failed',
        reason:
          'activation transaction was not broadcast (no on-chain txid) — likely insufficient funds for fees or an RPC/broadcast error',
      };
    }
    return {
      state: 'failed',
      code: 'no_signing_capability',
      reason:
        'cannot sign the activation on-chain — no local signing key (WIF) is available and the broker is not wired in',
    };
  }

  if (expected != null && getAgentStatus === expected) {
    return { state: 'confirmed', reason: 'activation confirmed on-chain' };
  }

  return {
    state: 'pending',
    reason:
      'activation was broadcast but is not yet reflected — waiting on block confirmation / indexer lag',
  };
}

// ── small helpers ─────────────────────────────────────────────────────────────

/** Should we attempt activation? Anything not 'active' (incl. unknown) → yes. */
function needsActivation(status) {
  return status !== 'active';
}

/** Tri-state hireability cell for table rendering. */
function hireCell(entry) {
  if (!entry) return '?';
  if (entry.hireable === true) return '✅';
  if (entry.hireable === false) return `❌(${entry.reason || '?'})`;
  return '?';
}

// ── formatDoctorReport ────────────────────────────────────────────────────────

/**
 * Render a doctor report for a set of agents.
 * @param rows [{ id, identity, diagnosis:{hireable,blockers,warnings} }]
 * @param opts { refreshed:boolean }
 * @returns { lines:string[], anyBlocked:boolean }
 */
function formatDoctorReport(rows, opts) {
  const lines = [];
  let anyBlocked = false;
  const list = Array.isArray(rows) ? rows : [];

  for (const row of list) {
    const diag = (row && row.diagnosis) || { hireable: false, blockers: [], warnings: [] };
    const blockers = Array.isArray(diag.blockers) ? diag.blockers : [];
    const warnings = Array.isArray(diag.warnings) ? diag.warnings : [];
    if (blockers.length > 0) anyBlocked = true;

    const mark = diag.hireable ? '✅' : '❌';
    const label = [row && row.id, row && row.identity].filter(Boolean).join(' / ');
    lines.push(`${mark} ${label}`);

    for (const b of blockers) {
      lines.push(`  ✗ [${b.code}] ${b.problem} → ${b.fix}`);
    }
    for (const w of warnings) {
      lines.push(`  ⚠ ${w}`);
    }
  }

  if (!opts || !opts.refreshed) {
    lines.push(
      'verdict is as of last indexer pass — pass --refresh to force a chain re-read',
    );
  }

  return { lines, anyBlocked };
}

module.exports = {
  networkCurrency,
  currencyMatches,
  servicePayable,
  diagnoseAgent,
  interpretActivation,
  needsActivation,
  hireCell,
  formatDoctorReport,
};
