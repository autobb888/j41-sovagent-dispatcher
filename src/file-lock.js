'use strict';
/**
 * Inter-process advisory file lock.
 *
 * A generalisation of the discipline `acquireSendLock` in cli.js arrived at the
 * hard way, over two rounds of a race that put two processes inside the same
 * "exclusive" section and double-broadcast a refund. The invariants are the
 * whole value of this file:
 *
 *  1. **Liveness, not age, decides whether a holder may be robbed.** Age flips
 *     over time and misjudges a holder that is merely slow — a process holding
 *     the lock across a network call, or across an interactive prompt, looks
 *     exactly like a crashed one. "The holder is dead" is stable: a dead pid
 *     stays dead. Age is only the fallback for a lock whose owner we cannot
 *     identify at all.
 *
 *  2. **`rename()` is atomic on a PATH, not on the file you inspected.** Every
 *     steal decides against the file it read and then acts on whatever occupies
 *     that path by the time it acts — which may already be a peer's fresh, live
 *     lock. So a steal must re-read inside an exclusive gate, and reclaiming the
 *     GATE must prove it moved the exact bytes it judged dead.
 *
 *  3. **The stale window must be SMALLER than the acquire deadline.** Otherwise
 *     the reclaim path is unreachable: every contender times out before the lock
 *     is old enough to steal, and they all fall through to doing the work
 *     unserialised — which is worse than not having a lock, because the code
 *     reads as if it were protected.
 *
 * Deliberately NOT wired into `acquireSendLock`. That path is hardened and
 * live-proven, and this codebase's dominant defect source is fixes to code that
 * was already working. Duplicating a well-understood ~100 lines is the cheaper
 * risk. They must also never share a lock namespace: a bug in one money path
 * must not be able to reach into another.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Below the acquire deadline, on purpose — see invariant 3. */
const DEFAULT_STALE_MS = 2000;
const DEFAULT_TIMEOUT_MS = 5000;
const GATE_STALE_MS = 2000;

/**
 * Publish a file at `dest` with its content already in it, or fail if it exists.
 *
 * `open(wx)` then `write()` looks exclusive and is not: between the two calls a
 * reader sees an EMPTY file at the visible path. Empty content is unparseable,
 * unparseable reads as "holder unidentifiable", and that reads as stale — so a
 * peer robs a lock that is being created right now. Worse, the content check
 * that is supposed to catch exactly this passes trivially, because both the
 * bytes it read and the bytes it moved are the empty string.
 *
 * Measured, not theorised: 6 contenders against one stale lock produced 5
 * records instead of 6 — two processes inside the critical section, one write
 * lost.
 *
 * `link()` is atomic and fails with EEXIST if the destination exists, so the
 * file appears at the path complete or not at all.
 */
function _publishExclusive(dest, content) {
  const tmp = `${dest}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  try {
    fs.linkSync(tmp, dest);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function _pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to another user. Still alive.
    return e.code === 'EPERM';
  }
}

/** Is this lock's holder gone, as opposed to slow? */
function _isStale(raw, staleMs, now) {
  if (typeof raw !== 'string' || !raw) return true; // unreadable → stale
  const [pidStr, tsStr] = raw.split(':');
  const pid = parseInt(pidStr, 10);
  if (Number.isInteger(pid) && pid > 0) return !_pidAlive(pid);
  const ts = parseInt(tsStr, 10);
  return !ts || (now - ts) > staleMs;
}

/**
 * Take the stale lock, or prove we must not.
 *
 * The steal is serialised behind an O_EXCL gate — the only genuinely atomic
 * primitive available — and re-reads the real lock inside it, so a contender
 * that arrives after a peer has already stolen sees a live holder and stands
 * down instead of stealing a second time.
 */
function _stealStale(lockPath, token, staleMs, now) {
  const gatePath = `${lockPath}.steal`;
  const gateTag = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;

  const gateContent = `${process.pid}:${now}:${gateTag}`;
  if (!_publishExclusive(gatePath, gateContent)) {
    // Reclaiming an orphaned gate is itself a steal and needs the same
    // discipline as the lock it guards.
    let orphanRaw = null;
    try { orphanRaw = String(fs.readFileSync(gatePath, 'utf8')); } catch { return false; }
    if (!_isStale(orphanRaw, GATE_STALE_MS, now)) return false; // a live peer is mid-steal

    const deadName = `${gatePath}.dead.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    try { fs.renameSync(gatePath, deadName); } catch { return false; }
    // Invariant 2: prove we moved the orphan we judged, not a fresh gate a peer
    // created in the meantime. If it is not ours, put it back and stand down.
    let movedRaw = null;
    try { movedRaw = String(fs.readFileSync(deadName, 'utf8')); } catch { movedRaw = null; }
    // NOT covered by a test, and it is worth being honest about why: the window
    // is a third contender creating a fresh gate between our rename and this
    // read, which is sub-microsecond and did not reproduce in 40 rounds. A
    // mutation deleting this check survives the suite. It stays because the
    // sibling lock in cli.js met exactly this bug for real — the reasoning is
    // sound even where the test cannot reach.
    if (movedRaw !== orphanRaw) {
      try { fs.renameSync(deadName, gatePath); } catch { /* peer owns it now */ }
      return false;
    }
    try { fs.unlinkSync(deadName); } catch {}
    if (!_publishExclusive(gatePath, gateContent)) return false;
  }

  try {
    // Inside the gate: re-read the real lock. A peer may already have replaced it.
    let currentRaw = null;
    try { currentRaw = String(fs.readFileSync(lockPath, 'utf8')); } catch { currentRaw = null; }
    if (currentRaw !== null && !_isStale(currentRaw, staleMs, Date.now())) return false;

    // Replace via rename: atomic, and the replacement carries its content from
    // the start, so no contender can observe an empty lock at this path.
    const tmp = `${lockPath}.new.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, token, { mode: 0o600 });
    fs.renameSync(tmp, lockPath);
    return true;
  } finally {
    try { fs.unlinkSync(gatePath); } catch {}
  }
}

/**
 * Acquire an exclusive lock at `lockPath`, or return null.
 *
 * @returns {string|null} the token to pass to `releaseFileLock`, or null on timeout.
 */
async function acquireFileLock(lockPath, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  if (staleMs >= timeoutMs) {
    // Invariant 3, enforced rather than documented: this combination makes the
    // reclaim path dead code and every caller silently unserialised.
    throw new Error(`file-lock: staleMs (${staleMs}) must be below timeoutMs (${timeoutMs}), ` +
      'or a stale lock can never be reclaimed and every contender falls through unserialised');
  }
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  const token = `${process.pid}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (_publishExclusive(lockPath, token)) return token;

    let raw = null;
    try { raw = String(fs.readFileSync(lockPath, 'utf8')); } catch { raw = null; }
    if (_isStale(raw, staleMs, Date.now()) && _stealStale(lockPath, token, staleMs, Date.now())) {
      return token;
    }

    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 25 + Math.floor(Math.random() * 25)));
  }
}

/**
 * Release a lock we hold.
 *
 * Verifies the token first: releasing unconditionally would let a process whose
 * lock was stolen (because it genuinely stalled past the stale window) delete
 * the NEW holder's lock on its way out, putting two processes inside the
 * critical section by way of the cleanup path.
 */
function releaseFileLock(lockPath, token) {
  try {
    if (String(fs.readFileSync(lockPath, 'utf8')) !== token) return false;
  } catch {
    return false;
  }
  try { fs.unlinkSync(lockPath); } catch {}
  return true;
}

module.exports = { acquireFileLock, releaseFileLock, DEFAULT_STALE_MS, DEFAULT_TIMEOUT_MS };
