'use strict';

const INDEXER_LAG_HINT =
  'Platform indexer has not caught the new identity yet. Wait ~30s then: j41-dispatcher finalize <agent-id>';

function isIndexerLagError(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  const code = err.code != null ? String(err.code) : '';
  const status = err.status || err.statusCode || err.httpStatus;
  if (code === 'SIGNATURE_INVALID' || Number(status) === 401) return false;
  if (code === 'IDENTITY_NOT_INDEXED') return true;
  if (/invalid request format/i.test(msg)) return true;
  if (Number(status) === 409 && /IDENTITY_NOT_INDEXED|not indexed/i.test(msg)) return true;
  return false;
}

function planOnboardingAfterProfile({ mintOk, profile } = {}) {
  if (!mintOk) return { runFinalize: false, exitCode: 1, hint: null };
  if (profile && profile.ok === false && profile.indexerLag) {
    return { runFinalize: false, exitCode: 0, hint: INDEXER_LAG_HINT };
  }
  return { runFinalize: true, exitCode: 0, hint: null };
}

async function retryRegisterWithJ41(registerFn, { attempts = 3, delayMs = 5000, sleep } = {}) {
  const wait = typeof sleep === 'function'
    ? sleep
    : (ms) => new Promise((r) => setTimeout(r, process.env.NODE_ENV === 'test' ? 0 : ms));
  const max = Math.max(1, parseInt(String(attempts), 10) || 3);
  const gap = Number.isFinite(Number(delayMs)) ? Number(delayMs) : 5000;
  let last = null;
  for (let i = 0; i < max; i++) {
    try {
      const result = await registerFn();
      return { ok: true, result, attempts: i + 1, indexerLag: false, error: null };
    } catch (e) {
      last = e;
      if (!isIndexerLagError(e) || i === max - 1) {
        return { ok: false, result: null, attempts: i + 1, indexerLag: isIndexerLagError(e), error: e };
      }
      await wait(gap);
    }
  }
  return { ok: false, result: null, attempts: max, indexerLag: isIndexerLagError(last), error: last };
}

module.exports = { isIndexerLagError, retryRegisterWithJ41, INDEXER_LAG_HINT, planOnboardingAfterProfile };
