'use strict';
/**
 * Virtual clock — lets a test cross the dispatcher's real waits instantly.
 *
 * The `start` action sleeps a LOT before it reaches the interesting code: 2s
 * between capability loads per agent, 1s between activations, 10s poll steps
 * inside a 180s deactivate-confirmation wait, 5s steps inside a 90s pending-write
 * gate. A nine-agent upgrade restart spends over four real minutes asleep. No
 * suite can pay that, which is exactly why the start action has never had an
 * executing test and every assertion about it is a source-text grep.
 *
 * This replaces the global timer functions and `Date` with an in-memory
 * scheduler, so those waits cost microseconds.
 *
 * ── How the auto-advance works, and its honest limitation ──
 *
 * A real `setImmediate` chain pumps the loop. Every `idleTicks` turns of that
 * chain we fire exactly one virtual timer, jumping virtual time to its deadline.
 * It is a RATE LIMITER on virtual time, not an idle detector — we cannot see
 * whether the code under test is mid-await, so we give the event loop a fixed
 * number of turns between virtual firings and no more.
 *
 * That is safe here because the harness stubs every network call, so nothing the
 * dispatcher awaits depends on real elapsed time. It would NOT be safe against a
 * `Promise.race([realHttpRequest, timeout])` — virtual time could reach the
 * timeout before a real socket completes. If you add a real I/O path to a
 * harnessed scenario, raise `idleTicks` or drive the clock manually with
 * `pause()` + `advance()`.
 *
 * Node's own internals (net, http, fs) schedule on the C++ timer list rather
 * than through the `global.setTimeout` binding, so replacing the globals does
 * not disturb real server binds or socket timeouts.
 */

/**
 * @param {object} [opts]
 * @param {number} [opts.startMs]      initial virtual epoch
 * @param {number} [opts.idleTicks]    event-loop turns between virtual firings
 * @param {number} [opts.budgetMs]     stop auto-advancing after this much virtual time
 * @param {(e: Error) => void} [opts.onError] called when a timer callback throws
 */
function installVirtualClock(opts = {}) {
  const startMs = opts.startMs ?? Date.UTC(2026, 7, 13, 12, 0, 0);
  const idleTicks = opts.idleTicks ?? 3;
  const budgetMs = opts.budgetMs ?? 24 * 60 * 60 * 1000;

  const realSetTimeout = global.setTimeout;
  const realSetInterval = global.setInterval;
  const realClearTimeout = global.clearTimeout;
  const realClearInterval = global.clearInterval;
  const realSetImmediate = global.setImmediate;
  const RealDate = global.Date;

  let now = startMs;
  let seq = 0;
  let installed = true;
  let pumping = false;
  let paused = false;
  let tick = 0;
  const timers = new Map();
  const errors = [];
  const stats = { fired: 0, scheduled: 0 };

  function schedule(fn, delay, args, repeating) {
    if (typeof fn !== 'function') throw new TypeError('callback must be a function');
    const ms = Math.max(0, Number(delay) || 0);
    const id = ++seq;
    stats.scheduled++;
    const rec = { id, fn, args, at: now + ms, every: repeating ? Math.max(1, ms) : null };
    // Mimic enough of Node's Timeout object that production code calling
    // `.unref()` (the capability-retry timer does) keeps working.
    rec.handle = {
      _virtualTimerId: id,
      unref() { return this; },
      ref() { return this; },
      hasRef() { return true; },
      refresh() { rec.at = now + (rec.every ?? ms); return this; },
      close() { timers.delete(id); return this; },
      [Symbol.toPrimitive]() { return id; },
    };
    timers.set(id, rec);
    return rec.handle;
  }

  function cancel(handle) {
    if (handle == null) return;
    const id = typeof handle === 'object' ? handle._virtualTimerId : Number(handle);
    if (id) timers.delete(id);
  }

  /** The earliest pending timer, or null. Ties break by insertion order. */
  function nextTimer() {
    let best = null;
    for (const rec of timers.values()) {
      if (!best || rec.at < best.at || (rec.at === best.at && rec.id < best.id)) best = rec;
    }
    return best;
  }

  /** Fire the single earliest timer, jumping virtual time to its deadline. */
  function fireNext() {
    const rec = nextTimer();
    if (!rec) return false;
    if (rec.at > now) now = rec.at;
    if (rec.every) rec.at = now + rec.every;
    else timers.delete(rec.id);
    stats.fired++;
    try {
      rec.fn(...(rec.args || []));
    } catch (e) {
      // Node would treat this as an uncaught exception. Record it rather than
      // letting the pump die, and surface it to the harness.
      errors.push(e);
      if (opts.onError) opts.onError(e);
    }
    return true;
  }

  function pump() {
    if (!installed || !pumping) return;
    if (!paused && ++tick >= idleTicks) {
      tick = 0;
      if (now - startMs < budgetMs) fireNext();
    }
    realSetImmediate(pump);
  }

  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() { return now; }
  }

  global.setTimeout = (fn, delay, ...args) => schedule(fn, delay, args, false);
  global.setInterval = (fn, delay, ...args) => schedule(fn, delay, args, true);
  global.clearTimeout = cancel;
  global.clearInterval = cancel;
  global.Date = FakeDate;

  pumping = true;
  realSetImmediate(pump);

  return {
    now: () => now,
    /** Jump virtual time forward, firing everything due along the way. */
    advance(ms) {
      const target = now + Math.max(0, ms);
      let guard = 0;
      for (;;) {
        const rec = nextTimer();
        if (!rec || rec.at > target) break;
        if (++guard > 100000) throw new Error('virtual clock: runaway timer loop in advance()');
        fireNext();
      }
      now = Math.max(now, target);
    },
    /** Stop auto-advancing (manual `advance()` still works). */
    pause() { paused = true; },
    resume() { paused = false; },
    pending: () => timers.size,
    stats: () => ({ ...stats, pending: timers.size, virtualElapsedMs: now - startMs }),
    errors: () => errors.slice(),
    uninstall() {
      if (!installed) return;
      installed = false;
      pumping = false;
      timers.clear();
      global.setTimeout = realSetTimeout;
      global.setInterval = realSetInterval;
      global.clearTimeout = realClearTimeout;
      global.clearInterval = realClearInterval;
      global.Date = RealDate;
    },
    /** Real-time sleep, for a harness that needs the loop to breathe. */
    realSleep(ms) { return new Promise((r) => realSetTimeout(r, ms)); },
  };
}

module.exports = { installVirtualClock };
