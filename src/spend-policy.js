'use strict';
/**
 * Spend-policy — the dispatcher's outbound-money gate.
 *
 * Extracted VERBATIM from cli.js (P1, spec 2026-08-18): the financial allowlist,
 * the send-history rate limiter and its cross-process lock, and the fleet-wide
 * financial kill switch. cli.js re-imports and re-exports every name below, so
 * suites that import these from cli.js keep working unchanged.
 *
 * Paths are resolved from os.homedir() at require time — identical to cli.js, and
 * the test harness overrides os.homedir() BEFORE requiring cli.js (which requires
 * this module), so a sandboxed HOME still lands here.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { loadDispatcherConfig } = require('./config-loader.js');
const { untrusted } = require('./untrusted.js');
const { parseVrscAmount } = require('./wallet.js'); // string→BigInt-sats; the only float-safe parse

const J41_DIR = path.join(os.homedir(), '.j41');
const DISPATCHER_DIR = path.join(J41_DIR, 'dispatcher');

// ── Financial Allowlist (Plan C) ──
const ALLOWLIST_PATH = path.join(os.homedir(), '.j41', 'financial-allowlist.json');

function loadFinancialAllowlist() {
  try {
    if (!fs.existsSync(ALLOWLIST_PATH)) {
      // Create deny-all default
      const dir = path.dirname(ALLOWLIST_PATH);
      fs.mkdirSync(dir, { recursive: true });
      const empty = { permanent: [], operator: [], active_jobs: [] };
      fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(empty, null, 2));
      return empty;
    }
    return JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  } catch (err) {
    console.error(`[allowlist] Failed to load ${ALLOWLIST_PATH}: ${err.message} — deny-all mode`);
    return { permanent: [], operator: [], active_jobs: [] };
  }
}

function isAddressInAllowlist(allowlist, address) {
  const all = [
    ...allowlist.permanent.map(e => e.address),
    ...allowlist.operator.map(e => e.address),
    ...allowlist.active_jobs.map(e => e.address),
  ];
  return all.includes(address);
}

function addActiveJobToAllowlist(jobId, buyerAddress) {
  try {
    const list = loadFinancialAllowlist();
    if (list.active_jobs.some(e => e.jobId === jobId)) return;
    list.active_jobs.push({
      address: buyerAddress,
      jobId,
      added: new Date().toISOString(),
    });
    fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(list, null, 2));
    console.log(`[allowlist] Added buyer address ${untrusted(buyerAddress, 60)} for job ${jobId}`);
  } catch (err) {
    console.error(`[allowlist] Failed to add job address: ${err.message}`);
  }
}

function removeActiveJobFromAllowlist(jobId) {
  try {
    const list = loadFinancialAllowlist();
    list.active_jobs = list.active_jobs.filter(e => e.jobId !== jobId);
    fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(list, null, 2));
    console.log(`[allowlist] Removed buyer address for job ${jobId}`);
  } catch (err) {
    console.error(`[allowlist] Failed to remove job address: ${err.message}`);
  }
}

function addToRefundAllowlist(address, jobId) {
  try {
    fs.mkdirSync(path.dirname(ALLOWLIST_PATH), { recursive: true });
    const list = loadFinancialAllowlist();
    if (!list.permanent.some(e => e.address === address)) {
      list.permanent.push({ address, jobId, added: new Date().toISOString(), via: 'refund-approve' });
    }
    const tmp = `${ALLOWLIST_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, ALLOWLIST_PATH);
    console.log(`[refund] owner-approved allowlist add ${address} for job ${jobId}`);
  } catch (err) {
    console.error(`[allowlist] Failed to add refund address: ${err.message}`);
    throw err;
  }
}

// ── Dispatcher-side outbound-money rate limiting ────────────────────────────
//
// M3: the README has documented "max 3 sends/job, max value = job price + 10%,
// max 10 sends/hour, 30s cooldown" and "suspends all sends if the API is
// unreachable for 30 min" since the security section was written. Both functions
// below had ZERO callers — `attemptPendingRefund`, the one place VRSC leaves the
// host, never consulted either. Nothing enforced any of it, and
// `dispatcherFinancialSuspended` was written by the sweep and read by nobody.
//
// This is defence in depth, not the primary control: every send is already behind
// an explicit operator approval, an allowlist check, an inter-process lock and a
// durable refunded-jobs ledger. What it adds is a bound on how much damage a BUG
// in any of those can do before a human notices — the case those four don't cover,
// because each of them trusts the caller's arithmetic.
//
// PERSISTED, not in-memory. The first version kept this in process memory, which
// quietly made all four guarantees per-process rather than fleet-wide — and the
// operator's documented workflow is to drive the daemon out-of-band with a second
// CLI process, so two independent 10/hour budgets was the normal case, not the
// exotic one. Worse, the API-outage suspension is only ever SET by the daemon's
// sweep, so a CLI `refunds approve` sent freely straight through an outage that
// had already suspended the daemon. A restart also reset the "lifetime" per-job cap.
//
// The file is the shared state; the in-memory object is only a scratch buffer.
const SEND_HISTORY_PATH = path.join(DISPATCHER_DIR, 'send-history.json');

function loadSendHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(SEND_HISTORY_PATH, 'utf8'));
    return {
      global: Array.isArray(raw.global) ? raw.global : [],
      perJob: (raw.perJob && typeof raw.perJob === 'object') ? raw.perJob : {},
    };
  } catch {
    // Absent OR corrupt. Starting from empty is the right failure mode for the
    // COUNTERS: they bound damage, they do not authorise anything, and refusing to
    // send on an unreadable counter file would strand every owed refund.
    return { global: [], perJob: {} };
  }
}

// The outage suspension lives in its OWN file, deliberately. Folded into the counter
// file, a one-byte corruption did not merely reset the counters (defensible) — it
// also silently lifted an active kill-switch, because the fail-open default returned
// `suspendedAt: null`. A safety flag must not inherit the failure mode of a
// bookkeeping file. Existence IS the state, so it survives any parse failure, and an
// operator with a dead daemon can clear it with `rm`.
const FINANCIAL_SUSPENDED_PATH = path.join(DISPATCHER_DIR, 'financial-suspended');

function isFinanciallySuspended() {
  try { return fs.existsSync(FINANCIAL_SUSPENDED_PATH); } catch { return false; }
}

function saveSendHistory(h) {
  try {
    fs.mkdirSync(path.dirname(SEND_HISTORY_PATH), { recursive: true });
    const tmp = `${SEND_HISTORY_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(h), { mode: 0o600 });
    fs.renameSync(tmp, SEND_HISTORY_PATH);
  } catch (e) {
    console.warn(`[refund] could not persist send history: ${e.message}`);
  }
}

// Cross-process mutex for the counter file. The rate check runs inside a per-JOB
// send lock, so two DIFFERENT jobs in two processes — the daemon drain and an
// out-of-band `refunds approve`, which is the documented operator workflow — do
// unsynchronized read-modify-write on the same file. Interleaved, one process's
// record is lost and the fleet-wide cap silently under-counts; the same race lets a
// `recordDispatcherSend` whose read predated a `setFinancialSuspended(true)` clobber
// the outage kill-switch back to null.
//
// O_EXCL create is the lock. Stale locks are stolen after 10s — this guards a
// counter, so a crashed holder must never wedge refunds permanently.
const SEND_HISTORY_LOCK = () => `${SEND_HISTORY_PATH}.lock`;

/**
 * Age window for the LAST-RESORT reclaim, used only when the lock's content
 * carries no usable pid.
 *
 * It was 10s against a 5s acquire deadline, which made the path unreachable: the
 * deadline always expired first, so a lock with legacy or torn content could never
 * be reclaimed and every caller fell through to an UNSERIALIZED write. Proved by
 * `test/send-history-lock-race.test.js` — 4 concurrent recorders left 3 records.
 *
 * 2s is safe here because this branch is only reached when no pid can be parsed,
 * and a healthy holder always writes `pid:ts:seq` in a single small `writeSync`.
 * Unparseable content is therefore debris, not a live peer; the window exists only
 * to avoid racing a writer caught mid-write.
 */
const SEND_HISTORY_LOCK_STALE_MS = 2000;
/** Distinguishes two acquisitions by the same pid in the same millisecond. */
let _sendHistoryLockSeq = 0;

/**
 * Serialize the read-modify-write of the send-history file across processes.
 *
 * This guards the LIFETIME "max 3 sends per job" cap and the hourly global cap, so
 * a lost update here is not a cosmetic counter glitch — it under-counts sends and
 * grants an extra refund broadcast.
 *
 * Rewritten to the same discipline as `acquireSendLock`, because it had the same
 * three flaws that lock's own comments condemn:
 *
 *  1. It judged the holder by AGE. Age flips over time and misjudges a peer that is
 *     merely slow; "the holder is dead" is stable, because a dead pid stays dead.
 *  2. It stole with unlink-then-create — two contenders could both stat the same
 *     stale lock, and the second's `unlink` then deleted the FIRST's freshly created
 *     live lock, putting both inside the "exclusive" section.
 *  3. On release it unlinked `lockPath` unconditionally. If our own lock had since
 *     been stolen (we outlived the stale window), that deleted the new holder's lock.
 *
 * The steal is now an atomic rename plus a content check proving we moved the exact
 * file we judged — rename() is atomic on a PATH, not on the file you inspected — and
 * the release only removes a lock that is still ours.
 */
function withSendHistoryLock(fn) {
  const lockPath = SEND_HISTORY_LOCK();
  const deadline = Date.now() + 5000;
  const token = `${process.pid}:${Date.now()}:${++_sendHistoryLockSeq}`;
  let held = false;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, token);
      fs.closeSync(fd);
      held = true;
      break;
    } catch {
      // Read the holder's bytes: they identify the specific lock we are judging,
      // and the steal below has to prove it moved that one.
      let holderRaw = null;
      try { holderRaw = String(fs.readFileSync(lockPath, 'utf8')); }
      catch { continue; } // vanished — retry the create immediately

      let stealable = false;
      const holderPid = parseInt(holderRaw.split(':')[0], 10);
      if (Number.isInteger(holderPid) && holderPid > 0) {
        let alive = true;
        try { process.kill(holderPid, 0); } catch (e) { alive = (e.code === 'EPERM'); }
        stealable = !alive;
      } else {
        // No usable pid (legacy or torn content). Age is all we have left.
        try { stealable = (Date.now() - fs.statSync(lockPath).mtimeMs) > SEND_HISTORY_LOCK_STALE_MS; }
        catch { continue; }
      }

      if (stealable) {
        // Serialise the steal behind an O_EXCL gate, and re-check INSIDE it.
        //
        // The previous version renamed the lock away, compared the bytes, and
        // renamed it back if it had grabbed the wrong file. Between that
        // rename-away and rename-back the lock PATH IS EMPTY, so a third
        // contender's `openSync(lockPath, 'wx')` succeeds there — and then the
        // rename-back drops the old bytes on top of that contender's live lock.
        // Two processes end up inside the critical section and one send record
        // is lost, which under-counts the per-job cap and grants an extra refund.
        //
        // Measured, not theorised: 3 failures in 33 full-suite runs under CPU
        // contention, every one of them this test. The diagnostic that settled
        // it was the children's stderr — all 8 reported success, none took the
        // deliberate unserialized fallback, and 7 records reached disk. It never
        // reproduced standalone at 16 contenders over 30 rounds: the window is
        // two syscalls wide and needs real preemption to land in.
        //
        // `acquireSendLock` has had this gate since 1306478; this sibling never
        // got it. Same discipline, same reasons.
        const gatePath = `${lockPath}.steal`;
        const gateTag = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
        let gate = null;
        try {
          gate = fs.openSync(gatePath, 'wx');
          fs.writeSync(gate, gateTag);
        } catch (ge) {
          if (ge.code !== 'EEXIST') { continue; }
          // A peer is mid-steal, or crashed inside the gate. The gate is held
          // for microseconds, so age is a sound test HERE (unlike for the lock,
          // whose holder may legitimately be slow).
          let gateAge = Infinity;
          try { gateAge = Date.now() - fs.statSync(gatePath).mtimeMs; } catch { continue; }
          if (gateAge > SEND_HISTORY_LOCK_STALE_MS) { try { fs.unlinkSync(gatePath); } catch {} }
          continue;
        }
        try {
          // Re-read the real lock now that we are alone. A peer may have
          // completed its steal while we were getting in here.
          let curRaw = null;
          try { curRaw = String(fs.readFileSync(lockPath, 'utf8')); } catch { curRaw = null; }

          if (curRaw === null) {
            // The path is FREE, not stale — nothing here is ours to reclaim, and
            // a plain acquirer may be creating a lock at it right now. Compete
            // honestly on the next loop instead of installing over them.
            continue;
          }

          const curPid = parseInt(curRaw.split(':')[0], 10);
          let curStale;
          if (Number.isInteger(curPid) && curPid > 0) {
            let alive = true;
            try { process.kill(curPid, 0); } catch (e) { alive = (e.code === 'EPERM'); }
            curStale = !alive;
          } else {
            try { curStale = (Date.now() - fs.statSync(lockPath).mtimeMs) > SEND_HISTORY_LOCK_STALE_MS; }
            catch { curStale = false; }
          }
          if (!curStale) continue; // a live holder arrived; stand down

          // Replace by rename, never unlink-then-create: rename is atomic and
          // leaves no window in which the path is empty. Safe because the file
          // we are replacing belongs to a DEAD holder, so nobody live can pull
          // it out from under us.
          const tmp = `${lockPath}.new.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
          fs.writeFileSync(tmp, token, { mode: 0o600 });
          fs.renameSync(tmp, lockPath);
          // Prove we own what is actually at the path before claiming the lock.
          let back = null;
          try { back = String(fs.readFileSync(lockPath, 'utf8')); } catch { back = null; }
          if (back === token) { held = true; }
        } finally {
          try { fs.closeSync(gate); } catch {}
          try { fs.unlinkSync(gatePath); } catch {}
        }
        if (held) break;
        continue;
      }

      // Spin briefly. This is a sub-millisecond critical section in practice.
      const until = Date.now() + 25;
      while (Date.now() < until) { /* busy-wait */ }
    }
  }
  if (!held) {
    // We still run `fn`, and that is deliberate: it RECORDS a send that has already
    // been broadcast, so dropping it would under-count the cap in exactly the
    // direction that permits an extra refund. But an unserialized read-modify-write
    // on a money cap must never be silent — a concurrent writer can still lose this
    // record, and the operator needs to know a cap reading may be low.
    console.error('[refund] send-history lock not acquired within 5s — recording UNSERIALIZED. ' +
      'A concurrent write could drop this record and under-count the per-job send cap.');
  }
  try {
    return fn();
  } finally {
    if (held) {
      // Only remove a lock that is still OURS. Not atomic, but the failure mode
      // inverts from "delete a live peer's lock" to "leave a lock that ages out".
      let cur = null;
      try { cur = String(fs.readFileSync(lockPath, 'utf8')); } catch { cur = null; }
      if (cur === token) { try { fs.unlinkSync(lockPath); } catch { /* already gone */ } }
    }
  }
}

/** Set/clear the fleet-wide financial suspension. Written by the daemon's sweep,
 *  read by EVERY process — including a one-shot CLI approve. */
function setFinancialSuspended(on, now = Date.now()) {
  try {
    if (on) {
      if (isFinanciallySuspended()) return;
      fs.mkdirSync(path.dirname(FINANCIAL_SUSPENDED_PATH), { recursive: true });
      fs.writeFileSync(FINANCIAL_SUSPENDED_PATH, JSON.stringify({ since: new Date(now).toISOString() }), { mode: 0o600 });
    } else {
      try { fs.unlinkSync(FINANCIAL_SUSPENDED_PATH); } catch { /* already clear */ }
    }
  } catch (e) {
    console.error(`[refund] could not ${on ? 'set' : 'clear'} the financial suspension flag: ${e.message}`);
  }
}

function dispatcherRateLimits() {
  try {
    const l = loadDispatcherConfig().refund_limits || {};
    return {
      maxSendsPerJob: Number.isFinite(l.max_sends_per_job) ? l.max_sends_per_job : 3,
      maxValueMultiplier: Number.isFinite(l.max_value_multiplier) ? l.max_value_multiplier : 1.1,
      maxSendsPerHour: Number.isFinite(l.max_sends_per_hour) ? l.max_sends_per_hour : 10,
      cooldownMs: Number.isFinite(l.cooldown_ms) ? l.cooldown_ms : 30_000,
    };
  } catch {
    // A broken config must not disable the limiter — fall back to the documented
    // defaults rather than to "no limit".
    return { maxSendsPerJob: 3, maxValueMultiplier: 1.1, maxSendsPerHour: 10, cooldownMs: 30_000 };
  }
}

/**
 * @returns {{allowed: boolean, reason?: string, retryable?: boolean}}
 *   `retryable` distinguishes "wait and this will pass" (cooldown, hourly cap,
 *   outage suspension) from "this will never pass without operator action"
 *   (per-job cap, value ceiling). Callers must not drop a retryable refund.
 */
function checkDispatcherRateLimit(jobId, amount, jobPrice, now = Date.now()) {
  // effectiveLimits() clamps the configured limits to the compiled hard ceilings
  // (P2) — this is the single place the value-multiplier / per-job / hourly caps
  // are enforced, so clamping here is what closes the config-widen gap.
  const LIM = effectiveLimits();
  if (isFinanciallySuspended()) {
    return {
      allowed: false,
      retryable: true,
      reason: `Financial operations suspended (API outage). Clears automatically when the platform ` +
        `responds; if the daemon is not running, remove ${FINANCIAL_SUSPENDED_PATH}`,
    };
  }
  const H = loadSendHistory();
  const jobHistory = H.perJob[jobId] || [];

  if (jobHistory.length >= LIM.maxSendsPerJob) {
    return { allowed: false, retryable: false, reason: `Max sends per job (${LIM.maxSendsPerJob})` };
  }

  // A missing/garbage price must not silently disable the value ceiling. The old
  // code computed `undefined * 1.1` → NaN, and every `> NaN` comparison is false,
  // so the check passed for exactly the malformed entries it should have caught.
  // Fall back to the amount itself: one send of this size is allowed, a second is
  // then caught by the per-job cap.
  const price = Number.isFinite(jobPrice) && jobPrice > 0 ? jobPrice : amount;
  const maxValue = price * LIM.maxValueMultiplier;
  const totalSent = jobHistory.reduce((s, r) => s + r.amount, 0);
  if (totalSent + amount > maxValue) {
    return {
      allowed: false,
      retryable: false,
      reason: `Total value ${(totalSent + amount).toFixed(8)} exceeds job price + ` +
        `${Math.round((LIM.maxValueMultiplier - 1) * 100)}% (${maxValue.toFixed(8)})`,
    };
  }

  const oneHourAgo = now - 3_600_000;
  const recentGlobal = H.global.filter(r => r.timestamp > oneHourAgo);
  if (recentGlobal.length >= LIM.maxSendsPerHour) {
    return { allowed: false, retryable: true, reason: `Hourly global limit (${LIM.maxSendsPerHour})` };
  }

  if (jobHistory.length > 0) {
    const last = jobHistory[jobHistory.length - 1];
    if (now - last.timestamp < LIM.cooldownMs) {
      return { allowed: false, retryable: true, reason: 'Cooldown active' };
    }
  }

  return { allowed: true };
}

function recordDispatcherSend(jobId, amount, now = Date.now()) {
  return withSendHistoryLock(() => _recordDispatcherSendLocked(jobId, amount, now));
}

function _recordDispatcherSendLocked(jobId, amount, now) {
  const H = loadSendHistory();
  const record = { timestamp: now, amount };
  if (!H.perJob[jobId]) H.perJob[jobId] = [];
  H.perJob[jobId].push(record);
  H.global.push(record);

  // Prune the GLOBAL list only — it backs the hourly window, so anything older is
  // dead weight. `perJob` is deliberately NOT pruned: "max 3 sends per job" is a
  // lifetime cap, and expiring it after an hour would quietly grant a fourth send
  // to a job that has already been paid three times. It grows by one small record
  // per refund per process lifetime, which is tens of entries in practice.
  const oneHourAgo = now - 3_600_000;
  H.global = H.global.filter(r => r.timestamp > oneHourAgo);
  // Bound perJob so a very long-lived install cannot grow it without limit. Keep
  // the most recent 5000 jobs — far beyond any real refund volume, so the lifetime
  // per-job cap holds in practice while the file stays small.
  const jobIds = Object.keys(H.perJob);
  if (jobIds.length > 5000) {
    const keep = jobIds.slice(-5000);
    const trimmed = {};
    for (const id of keep) trimmed[id] = H.perJob[id];
    H.perJob = trimmed;
  }
  saveSendHistory(H);
}

/** Test hook: the limiter is process-global in-memory state, so a suite that
 *  exercises it has to be able to start from a known point and to simulate the
 *  API-outage suspension the sweep sets. Not used in production paths. */
function _resetDispatcherRateLimit(suspended = false) {
  saveSendHistory({ global: [], perJob: {} });
  setFinancialSuspended(suspended);
}

// ── The funnel: gateExternalSend / recordSendOutcome (P1) ──
//
// One entry point every outbound send passes. It composes the primitives above
// (suspension, allowlist, rate limiter) and — from P2/P3 — the absolute per-tx
// cap and the unified ledger. `kind` selects which checks apply:
//   refund / payment          → external: counterparty + full rate family + abs cap
//   fleet_transfer / fee_sweep → self-directed: suspension + advisory abs cap
const EXTERNAL_KINDS = new Set(['refund', 'payment']);

// ── Compiled hard ceilings (P2) ──────────────────────────────────────────────
//
// Un-widenable. config/env can raise a limit only UP TO these; anything higher is
// clamped (and logged), so a hand-edited config or a compromised env can never
// widen the money limiter past them. Set generously — they bound tampering and
// fat-fingers, not the operator workflows the docs endorse (e.g. backlog drains).
const HARD_MAX_VALUE_MULTIPLIER = 2.0;
const HARD_MAX_SENDS_PER_JOB    = 10;
const HARD_MAX_SENDS_PER_HOUR   = 100;
// Integer satoshis as a Number — parseVrscAmount caps amounts at 2^50 sat, well
// inside MAX_SAFE_INTEGER, so a Number is exact here (same convention as the SDK).
const HARD_MAX_SINGLE_SEND_SATS = 1000 * 100_000_000; // 1000 VRSC, absolute per-tx

const _clampedKeysSet = new Set();
/** Keys whose configured value had to be clamped this process (read by the mainnet guard, P5). */
function _clampedKeys() { return [..._clampedKeysSet]; }

function _clamp(key, val, hard) {
  if (Number.isFinite(val) && val > hard) {
    if (!_clampedKeysSet.has(key)) {
      _clampedKeysSet.add(key);
      console.warn(`[spend-policy] ${key}=${val} exceeds the compiled ceiling ${hard} — clamped. ` +
        'A configured limit above the hard cap means the config/env was hand-edited.');
    }
    return hard;
  }
  return val;
}

/** dispatcherRateLimits() (or a supplied raw object) clamped to the hard ceilings. */
function effectiveLimits(raw) {
  const l = raw || dispatcherRateLimits();
  return {
    maxSendsPerJob: _clamp('max_sends_per_job', l.maxSendsPerJob, HARD_MAX_SENDS_PER_JOB),
    maxValueMultiplier: _clamp('max_value_multiplier', l.maxValueMultiplier, HARD_MAX_VALUE_MULTIPLIER),
    maxSendsPerHour: _clamp('max_sends_per_hour', l.maxSendsPerHour, HARD_MAX_SENDS_PER_HOUR),
    cooldownMs: l.cooldownMs,
  };
}

/** Decimal amount (number or string) → integer satoshis (Number), or null if unparseable. */
function _amountSats(amount) {
  const r = parseVrscAmount(typeof amount === 'string' ? amount : String(amount));
  return r.ok ? r.sats : null;
}

// ── Unified append-only ledger (P3) ──────────────────────────────────────────
//
// One JSON line per gate decision (allow AND deny) and per broadcast outcome,
// covering every kind. Append is a single write() to an O_APPEND fd, taken under a
// DEDICATED lock (not the send-history lock — reusing it would drag daemon fee
// sweeps into the refund limiter's critical section). A `checks` object can exceed
// PIPE_BUF (4 KB), so the lock is what keeps concurrent lines from interleaving.
const SPEND_LEDGER_PATH = path.join(DISPATCHER_DIR, 'spend-ledger.jsonl');
const SPEND_LEDGER_LOCK = `${SPEND_LEDGER_PATH}.lock`;
let _ledgerLockSeq = 0;

function _withLedgerLock(fn) {
  const deadline = Date.now() + 5000;
  const token = `${process.pid}:${Date.now()}:${++_ledgerLockSeq}`;
  let held = false;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(path.dirname(SPEND_LEDGER_LOCK), { recursive: true });
      const fd = fs.openSync(SPEND_LEDGER_LOCK, 'wx');
      fs.writeSync(fd, token); fs.closeSync(fd); held = true; break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e; // real fault (perms, EISDIR on the dir) — surface it
      let stale = false;
      try {
        const raw = String(fs.readFileSync(SPEND_LEDGER_LOCK, 'utf8'));
        const pid = parseInt(raw.split(':')[0], 10);
        if (Number.isInteger(pid) && pid > 0) {
          let alive = true; try { process.kill(pid, 0); } catch (er) { alive = (er.code === 'EPERM'); }
          stale = !alive;
        } else { stale = (Date.now() - fs.statSync(SPEND_LEDGER_LOCK).mtimeMs) > 2000; }
      } catch { continue; }
      if (stale) { try { fs.unlinkSync(SPEND_LEDGER_LOCK); } catch { /* raced */ } continue; }
      const until = Date.now() + 15; while (Date.now() < until) { /* brief spin */ }
    }
  }
  try { return fn(); }
  finally {
    if (held) {
      try { if (String(fs.readFileSync(SPEND_LEDGER_LOCK, 'utf8')) === token) fs.unlinkSync(SPEND_LEDGER_LOCK); }
      catch { /* already stolen/gone */ }
    }
  }
}

/** Append one line. THROWS on a write failure — callers decide fail-closed vs best-effort. */
function appendLedger(obj) {
  const line = JSON.stringify(obj) + '\n';
  _withLedgerLock(() => {
    fs.mkdirSync(path.dirname(SPEND_LEDGER_PATH), { recursive: true });
    const fd = fs.openSync(SPEND_LEDGER_PATH, 'a'); // EISDIR / ENOSPC surface here
    try { fs.writeSync(fd, line); } finally { fs.closeSync(fd); }
  });
}

/** Decimal amount (number or string) → satoshi string, or null if unparseable. */
function _amountSatsStr(amount) {
  const s = _amountSats(amount);
  return s === null ? null : s.toString();
}

function _ledgerBase(kind, jobId, toAddress, amount, now, amountSatsOverride) {
  return {
    ts: new Date(now).toISOString(), kind,
    jobId: jobId || null, toAddress: toAddress || null,
    amountSats: amountSatsOverride != null ? String(amountSatsOverride) : _amountSatsStr(amount),
  };
}

/** Map a checkDispatcherRateLimit reason onto the specific `checks` field. */
function _rateCheckField(checks, reason) {
  const r = String(reason || '');
  if (/Max sends per job/.test(r)) checks.perJobCap = 'fail';
  else if (/exceeds job price/.test(r)) checks.valueCeiling = 'fail';
  else if (/Hourly global limit/.test(r)) checks.hourlyCap = 'fail';
  else if (/Cooldown/.test(r)) checks.cooldown = 'fail';
  else if (/suspend/i.test(r)) checks.suspension = 'fail';
}

/**
 * The single gate before an outbound broadcast.
 * @returns {{allowed:boolean, retryable:boolean, reason?:string, checks:object}}
 *   `retryable` distinguishes "wait and retry" from "needs operator action";
 *   callers must not drop a retryable send.
 */
function gateExternalSend({ jobId, toAddress, amount, jobPrice, kind, expectedRecipients, now = Date.now() }) {
  const checks = {
    suspension: 'skip', counterparty: 'skip', perJobCap: 'skip',
    valueCeiling: 'skip', hourlyCap: 'skip', cooldown: 'skip', absoluteCap: 'skip',
  };
  const external = EXTERNAL_KINDS.has(kind);

  // finish() records the decision to the ledger and returns it. For an ALLOW, a
  // ledger-write failure flips to a RETRYABLE deny (fail-closed): an irreversible
  // send whose authorization we could not record must not go out.
  const finish = (allowed, retryable, reason) => {
    const decision = { allowed, retryable: !!retryable, reason: reason || undefined, checks };
    try {
      appendLedger({ event: 'gate_decision', ..._ledgerBase(kind, jobId, toAddress, amount, now),
        allowed: decision.allowed, retryable: decision.retryable, reason: reason || null, checks });
    } catch (e) {
      if (allowed) {
        const denied = { allowed: false, retryable: true, reason: `spend-ledger unwritable: ${e.message}`, checks };
        return denied;
      }
      console.warn(`[spend-ledger] could not record a denied ${kind}: ${e.message}`);
    }
    return decision;
  };

  // 1. Counterparty authorization (external only) — FIRST, matching the historical
  //    allowlist-before-ratelimit order in attemptPendingRefund.
  if (external) {
    const ok = kind === 'refund'
      ? isAddressInAllowlist(loadFinancialAllowlist(), toAddress)
      : (Array.isArray(expectedRecipients) && expectedRecipients.includes(toAddress));
    checks.counterparty = ok ? 'pass' : 'fail';
    if (!ok) {
      return finish(false, false, kind === 'refund'
        ? 'Refund address not in allowlist'
        : "Payment destination not in the job's expected recipients");
    }
  }

  // 2. Suspension + rate family.
  if (external) {
    const rl = checkDispatcherRateLimit(jobId, amount, jobPrice, now);
    if (!rl.allowed) { _rateCheckField(checks, rl.reason); return finish(false, rl.retryable, rl.reason); }
    checks.suspension = 'pass';
    checks.perJobCap = 'pass'; checks.valueCeiling = 'pass';
    checks.hourlyCap = 'pass'; checks.cooldown = 'pass';
  } else {
    // Self-directed: the only shared gate is the kill switch.
    if (isFinanciallySuspended()) { checks.suspension = 'fail'; return finish(false, true, 'Financial operations suspended (API outage)'); }
    checks.suspension = 'pass';
  }

  // 3. Absolute per-tx cap (P2). Terminal for external kinds; advisory (warn, never
  //    deny) for self-directed sweeps — a self→self move has no counterparty risk,
  //    and terminally blocking a large sweep would strand the fee tank (C1).
  const sats = _amountSats(amount);
  if (sats !== null && sats > HARD_MAX_SINGLE_SEND_SATS) {
    if (external) {
      checks.absoluteCap = 'fail';
      return finish(false, false, `Amount ${amount} exceeds the hard per-tx cap of ${HARD_MAX_SINGLE_SEND_SATS} sats`);
    }
    checks.absoluteCap = 'warn';
    console.warn(`[spend-policy] ${kind} of ${amount} exceeds the advisory per-tx cap — allowed (self-directed), logged.`);
  } else {
    checks.absoluteCap = 'pass';
  }

  return finish(true, false, null);
}

/**
 * Record the result of a send. External kinds consume the refund limiter budget;
 * self-directed kinds (fleet_transfer / fee_sweep) do NOT — they only ledger, plus
 * an ADVISORY absolute-cap warning (never a block: terminally capping a self→self
 * sweep would strand the fee tank, C1). `amountSats` may be supplied directly (the
 * fleet paths already hold integer sats); otherwise it is derived from `amount`.
 */
function recordSendOutcome({ kind, jobId, toAddress, amount, amountSats, txid, denial, now = Date.now() }) {
  if (EXTERNAL_KINDS.has(kind)) {
    recordDispatcherSend(jobId, amount, now);
  } else {
    const sats = amountSats != null ? amountSats : _amountSats(amount);
    if (sats !== null && sats > HARD_MAX_SINGLE_SEND_SATS) {
      console.warn(`[spend-policy] ${kind} of ${sats} sat exceeds the advisory per-tx cap — allowed (self-directed), logged.`);
    }
  }
  // Best-effort: the money already moved, so a lost audit line must not crash us.
  try {
    appendLedger({ event: 'broadcast_outcome', ..._ledgerBase(kind, jobId, toAddress, amount, now, amountSats),
      txid: txid || null, denial: denial || null });
  } catch (e) {
    console.warn(`[spend-ledger] could not record ${kind} outcome (money already moved): ${e.message}`);
  }
}

module.exports = {
  // allowlist
  ALLOWLIST_PATH, loadFinancialAllowlist, isAddressInAllowlist,
  addActiveJobToAllowlist, removeActiveJobFromAllowlist, addToRefundAllowlist,
  // send-history + rate limiter
  SEND_HISTORY_PATH, loadSendHistory, saveSendHistory, withSendHistoryLock,
  dispatcherRateLimits, checkDispatcherRateLimit, recordDispatcherSend,
  _resetDispatcherRateLimit,
  // kill switch
  FINANCIAL_SUSPENDED_PATH, isFinanciallySuspended, setFinancialSuspended,
  // funnel
  gateExternalSend, recordSendOutcome, EXTERNAL_KINDS,
  // ledger
  SPEND_LEDGER_PATH, appendLedger,
  // hard ceilings (P2)
  effectiveLimits, _clampedKeys,
  HARD_MAX_VALUE_MULTIPLIER, HARD_MAX_SENDS_PER_JOB, HARD_MAX_SENDS_PER_HOUR, HARD_MAX_SINGLE_SEND_SATS,
};
