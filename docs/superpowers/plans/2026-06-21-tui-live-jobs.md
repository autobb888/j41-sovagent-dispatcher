# TUI Live Jobs (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live, auto-refreshing "Live Jobs" screen to the dispatcher dashboard (backed by the existing control socket), and fix the Status header + log-path so the TUI reflects the running dispatcher.

**Architecture:** A new, fully unit-tested module `src/tui/live-screen.js` holds a pure render function plus a non-blocking refresh loop with all I/O injected. `src/dashboard.js` consumes it via `sendCommand` from `src/control.js`. No changes to the dispatcher daemon, no new socket commands.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert/strict`, Inquirer v9 (existing), the existing `control.js` Unix-socket control plane.

**Spec:** `docs/superpowers/specs/2026-06-21-tui-live-jobs-design.md`

---

## File Structure

- **Create** `src/tui/live-screen.js` — pure `renderActiveJobs(data)` + `runLiveScreen(io)` loop. One responsibility: render live data and drive a refresh/key loop with injected I/O.
- **Create** `test/live-screen.test.js` — unit tests for the above.
- **Modify** `src/dashboard.js` — add `Live Jobs` menu item + switch case; rewire `Status & Health` header to the socket and drop the misleading health tag; fix `View Logs` path resolution.
- No other files change. `src/control.js` already exports `sendCommand`, `buildJobs`, `buildStatus`.

---

## Task 1: Pure renderer `renderActiveJobs`

**Files:**
- Create: `src/tui/live-screen.js`
- Test: `test/live-screen.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/live-screen.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderActiveJobs } = require('../src/tui/live-screen');

// Strip ANSI so assertions are about content, not color.
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('renderActiveJobs: empty list shows "No active jobs" and queue 0', () => {
  const out = plain(renderActiveJobs({ jobs: { active: [], queue: 0 } }));
  assert.match(out, /Live Jobs/);
  assert.match(out, /No active jobs\./);
  assert.match(out, /Queue: 0 pending/);
});

test('renderActiveJobs: one running job shows id, agent, runtime, tokens', () => {
  const data = {
    jobs: { active: [{ jobId: '0bf75391-aaaa', agentId: 'agent-5', runningFor: '3m', paused: false, workspace: false, tokens: { total: 1234 } }], queue: 0 },
  };
  const out = plain(renderActiveJobs(data));
  assert.match(out, /0bf75391/);
  assert.match(out, /agent-5/);
  assert.match(out, /3m/);
  assert.match(out, /1234/);
  assert.match(out, /running/);
});

test('renderActiveJobs: paused job and [WS] flag render', () => {
  const data = {
    jobs: { active: [{ jobId: 'deadbeef-1', agentId: 'agent-2', runningFor: '1m', paused: true, workspace: true, tokens: null }], queue: 2 },
  };
  const out = plain(renderActiveJobs(data));
  assert.match(out, /paused/);
  assert.match(out, /\[WS\]/);
  assert.match(out, /Queue: 2 pending/);
});

test('renderActiveJobs: per-job memMB from resources is shown', () => {
  const data = {
    jobs: { active: [{ jobId: '0bf75391-aaaa', agentId: 'agent-5', runningFor: '3m', paused: false, workspace: false, tokens: null }], queue: 0 },
    resources: { jobs: [{ jobId: '0bf75391', memMB: 512, agentId: 'agent-5' }] },
  };
  const out = plain(renderActiveJobs(data));
  assert.match(out, /512MB/);
});

test('renderActiveJobs: error state shows the message and retry hint', () => {
  const out = plain(renderActiveJobs({ error: 'Dispatcher is not running (no control socket)' }));
  assert.match(out, /Dispatcher is not running/);
  assert.match(out, /press q to go back/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/live-screen.test.js`
Expected: FAIL — `Cannot find module '../src/tui/live-screen'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/tui/live-screen.js`:

```js
'use strict';

const DIM = '\x1b[2m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RED = '\x1b[31m', RESET = '\x1b[0m';

function pad(s, n) {
  s = String(s == null ? '' : s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/**
 * Pure: render the Live Jobs screen from a data object.
 * @param {{jobs?: {active: object[], queue: number}, resources?: {jobs: object[]}, error?: string}} data
 * @returns {string}
 */
function renderActiveJobs(data) {
  const lines = [];
  lines.push('  ═══ Live Jobs ═══');
  lines.push('');

  if (data && data.error) {
    lines.push(`  ${RED}${data.error}${RESET}`);
    lines.push('');
    lines.push(`  ${DIM}press q to go back, r to retry${RESET}`);
    return lines.join('\n');
  }

  const jobs = (data && data.jobs && data.jobs.active) || [];
  const queue = (data && data.jobs && data.jobs.queue) || 0;

  const memByJob = {};
  for (const r of (data && data.resources && data.resources.jobs) || []) {
    memByJob[r.jobId] = r.memMB; // resources uses an 8-char jobId prefix
  }

  if (jobs.length === 0) {
    lines.push(`  ${DIM}No active jobs.${RESET}`);
  } else {
    lines.push(`  ${DIM}#   JOB       AGENT        RUNTIME  TOKENS    STATE${RESET}`);
    jobs.forEach((j, i) => {
      const short = String(j.jobId || '').substring(0, 8);
      const tok = j.tokens && j.tokens.total != null ? String(j.tokens.total) : '-';
      const state = j.paused ? `${YELLOW}paused${RESET}` : `${GREEN}running${RESET}`;
      const ws = j.workspace ? ' [WS]' : '';
      const mem = memByJob[short] != null ? `  ${memByJob[short]}MB` : '';
      lines.push(`  ${DIM}[${i + 1}]${RESET} ${pad(short, 8)}  ${pad(j.agentId, 11)}  ${pad(j.runningFor, 6)}  ${pad(tok, 8)}  ${state}${ws}${mem}`);
    });
  }

  lines.push('');
  lines.push(`  Queue: ${queue} pending`);
  lines.push('');
  lines.push(`  ${DIM}auto-refresh • q back • r refresh${RESET}`);
  return lines.join('\n');
}

module.exports = { renderActiveJobs, pad };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/live-screen.test.js`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tui/live-screen.js test/live-screen.test.js
git commit -m "feat(tui): pure renderActiveJobs for the live jobs screen"
```

---

## Task 2: Non-blocking refresh loop `runLiveScreen`

**Files:**
- Modify: `src/tui/live-screen.js`
- Test: `test/live-screen.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/live-screen.test.js`:

```js
const { runLiveScreen } = require('../src/tui/live-screen');
const { EventEmitter } = require('node:events');

// A fake stdin that records raw-mode toggles and lets tests emit keys.
function makeStdin() {
  const e = new EventEmitter();
  e.rawModes = [];
  e.setRawMode = (v) => { e.rawModes.push(v); return e; };
  e.resume = () => e;
  e.pause = () => e;
  return e;
}

test('runLiveScreen: fetches and renders immediately, then quits on q', async () => {
  const stdin = makeStdin();
  const frames = [];
  let fetchCount = 0;
  const p = runLiveScreen({
    stdin,
    intervalMs: 9999,
    fetch: async () => { fetchCount++; return { jobs: { active: [], queue: 0 } }; },
    render: (d) => `frame:${d.error ? 'err' : 'ok'}`,
    write: (s) => frames.push(s),
    clear: () => {},
    setInterval: () => 0,        // no real timer
    clearInterval: () => {},
  });
  // let the immediate refresh() microtasks settle
  await new Promise((r) => setImmediate(r));
  assert.equal(fetchCount, 1);
  assert.deepEqual(frames, ['frame:ok']);
  assert.equal(stdin.rawModes[0], true); // raw mode turned on

  stdin.emit('data', Buffer.from('q'));
  const res = await p;
  assert.ok(res); // resolved
  assert.equal(stdin.rawModes[stdin.rawModes.length - 1], false); // raw mode restored
});

test('runLiveScreen: r forces an extra refresh', async () => {
  const stdin = makeStdin();
  let fetchCount = 0;
  const p = runLiveScreen({
    stdin, intervalMs: 9999,
    fetch: async () => { fetchCount++; return { jobs: { active: [], queue: 0 } }; },
    render: () => 'x', write: () => {}, clear: () => {},
    setInterval: () => 0, clearInterval: () => {},
  });
  await new Promise((r) => setImmediate(r));
  stdin.emit('data', Buffer.from('r'));
  await new Promise((r) => setImmediate(r));
  assert.equal(fetchCount, 2);
  stdin.emit('data', Buffer.from('q'));
  await p;
});

test('runLiveScreen: fetch rejection renders an error frame, loop survives', async () => {
  const stdin = makeStdin();
  const frames = [];
  const p = runLiveScreen({
    stdin, intervalMs: 9999,
    fetch: async () => { throw new Error('boom'); },
    render: (d) => (d.error ? `ERR:${d.error}` : 'ok'),
    write: (s) => frames.push(s), clear: () => {},
    setInterval: () => 0, clearInterval: () => {},
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(frames, ['ERR:boom']);
  stdin.emit('data', Buffer.from('q'));
  await p;
});

test('runLiveScreen: the interval callback triggers refresh', async () => {
  const stdin = makeStdin();
  let intervalFn = null;
  let fetchCount = 0;
  const p = runLiveScreen({
    stdin, intervalMs: 10,
    fetch: async () => { fetchCount++; return { jobs: { active: [], queue: 0 } }; },
    render: () => 'x', write: () => {}, clear: () => {},
    setInterval: (fn) => { intervalFn = fn; return 1; },
    clearInterval: () => {},
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(fetchCount, 1);
  await intervalFn();                 // simulate a tick
  assert.equal(fetchCount, 2);
  stdin.emit('data', Buffer.from('q'));
  await p;
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/live-screen.test.js`
Expected: FAIL — `runLiveScreen` is not a function / undefined.

- [ ] **Step 3: Write the minimal implementation**

In `src/tui/live-screen.js`, add `runLiveScreen` and export it:

```js
/**
 * Run a live, auto-refreshing screen until the user quits. All I/O injected.
 * @param {object} io
 * @param {() => Promise<object>} io.fetch        - returns data passed to render()
 * @param {(data: object) => string} io.render
 * @param {NodeJS.EventEmitter & {setRawMode?:Function, resume?:Function, pause?:Function}} io.stdin
 * @param {number} io.intervalMs
 * @param {(s: string) => void} [io.write]        - default: process.stdout.write
 * @param {() => void} [io.clear]                 - default: clear screen
 * @param {(fn:Function, ms:number) => any} [io.setInterval]
 * @param {(t:any) => void} [io.clearInterval]
 * @returns {Promise<{lastData: object}>}
 */
function runLiveScreen(io) {
  const fetch = io.fetch;
  const render = io.render;
  const stdin = io.stdin;
  const write = io.write || ((s) => process.stdout.write(s));
  const clear = io.clear || (() => process.stdout.write('\x1b[2J\x1b[H'));
  const setI = io.setInterval || setInterval;
  const clearI = io.clearInterval || clearInterval;

  return new Promise((resolve) => {
    let timer = null;
    let lastData = null;
    let done = false;

    async function refresh() {
      try { lastData = await fetch(); }
      catch (e) { lastData = { error: e.message }; }
      clear();
      write(render(lastData));
    }

    function finish() {
      if (done) return;
      done = true;
      if (timer != null) clearI(timer);
      try { stdin.removeListener('data', onData); } catch { /* ignore */ }
      try { if (stdin.setRawMode) stdin.setRawMode(false); } catch { /* ignore */ }
      try { stdin.pause(); } catch { /* ignore */ }
      resolve({ lastData });
    }

    function onData(chunk) {
      const key = chunk.toString();
      if (key === 'q' || key === '\x1b' || key === '\x03') { finish(); return; } // q / ESC / Ctrl-C
      if (key === 'r') { refresh(); return; }
    }

    try { if (stdin.setRawMode) stdin.setRawMode(true); } catch { /* ignore */ }
    try { stdin.resume(); } catch { /* ignore */ }
    stdin.on('data', onData);

    refresh();
    timer = setI(refresh, io.intervalMs);
  });
}

module.exports = { renderActiveJobs, runLiveScreen, pad };
```

(Replace the existing `module.exports` line at the bottom of the file with the one above.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/live-screen.test.js`
Expected: PASS — all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tui/live-screen.js test/live-screen.test.js
git commit -m "feat(tui): non-blocking runLiveScreen refresh loop"
```

---

## Task 3: Wire the Live Jobs screen into the dashboard

**Files:**
- Modify: `src/dashboard.js` (requires near top ~line 18; menu choices ~line 204-231; main switch ~line 2952)

- [ ] **Step 1: Add the requires**

In `src/dashboard.js`, just after the existing `const { loadDispatcherConfig, saveDispatcherConfig } = require('./config-loader.js');` line (~line 18), add:

```js
const { sendCommand } = require('./control.js');
const { renderActiveJobs, runLiveScreen } = require('./tui/live-screen.js');
```

- [ ] **Step 2: Add the menu item**

In `mainMenu`, in the `choices` array, immediately after the line:

```js
      new inquirer.Separator('  ── Dispatcher ──'),
```

insert:

```js
      { name: '⚡ Live Jobs (auto-refresh)', value: 'live_jobs' },
```

- [ ] **Step 3: Add the switch case**

In `main()`'s `switch (choice)`, immediately before the existing `case 'logs': {` line, insert:

```js
      case 'live_jobs': {
        await runLiveScreen({
          stdin: process.stdin,
          intervalMs: 2500,
          render: renderActiveJobs,
          fetch: async () => {
            const [jobs, resources] = await Promise.all([
              sendCommand({ action: 'jobs' }),
              sendCommand({ action: 'resources' }).catch(() => null),
            ]);
            return { jobs, resources };
          },
        });
        break;
      }
```

- [ ] **Step 4: Syntax-check**

Run: `node --check src/dashboard.js`
Expected: no output (exit 0).

- [ ] **Step 5: Manual verification**

With the dispatcher running (`node src/cli.js ctl status` succeeds), run:

Run: `node src/dashboard.js`
Then pick `⚡ Live Jobs (auto-refresh)`.
Expected: a "═══ Live Jobs ═══" screen listing active jobs (or "No active jobs.") with "Queue: N pending", refreshing every ~2.5s; `q` returns to the menu and the terminal is usable (not stuck in raw mode). Stop the dispatcher and re-open the screen: expect the red "Dispatcher is not running…" state, and `q` still exits cleanly.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard.js
git commit -m "feat(tui): add Live Jobs screen to the dashboard menu"
```

---

## Task 4: Rewire Status header to the socket; drop the misleading health tag

**Files:**
- Modify: `src/dashboard.js` — `statusScreen` (the API-Proxy health block ~line 803-822)

- [ ] **Step 1: Add a live header from the socket**

Find the start of `async function statusScreen(` in `src/dashboard.js`. Immediately after its first `console.clear();` (the screen header), add a live status block:

```js
  // Live header from the running dispatcher (matches `ctl status`).
  // buildStatus() returns: { uptime, uptimeMs, agents:{total,available,busy}, active, queue, seen }
  try {
    const liveStatus = await sendCommand({ action: 'status' });
    const ag = liveStatus.agents || {};
    console.log('  ── Live (dispatcher) ──');
    console.log(`  Uptime:    ${liveStatus.uptime != null ? liveStatus.uptime : '?'}`);
    console.log(`  Agents:    ${ag.available != null ? ag.available : '?'} available / ${ag.total != null ? ag.total : '?'} total`);
    console.log(`  Active:    ${liveStatus.active != null ? liveStatus.active : '?'} job(s)`);
    console.log(`  Queue:     ${liveStatus.queue != null ? liveStatus.queue : 0} pending\n`);
  } catch {
    console.log('  ── Live (dispatcher) ──');
    console.log('  Dispatcher not running (no control socket).\n');
  }
```

These field names are taken directly from `buildStatus` in `src/control.js:145-156` — they are correct as written; no further lookup needed.

- [ ] **Step 2: Remove the dead cross-process health lookup**

In the API-Proxy section, delete these lines (they can never work from a separate process):

```js
    const live = status.running;
    let getHealth = null;
    if (live) {
      try { getHealth = require(path.join(REPO_DIR, 'src/upstream-health.js')).getHealth; } catch {}
    }
```

and replace the per-agent `healthTag` computation:

```js
      let healthTag = '';
      if (live && getHealth) {
        const h = getHealth(a.id);
        if (h) {
          const ageS = Math.round((Date.now() - h.lastCheck) / 1000);
          healthTag = h.healthy
            ? `  \x1b[32m[healthy ${ageS}s ago]\x1b[0m`
            : `  \x1b[31m[DOWN — ${h.error || 'status ' + h.status}]\x1b[0m`;
        } else {
          healthTag = `  \x1b[2m[no health check yet]\x1b[0m`;
        }
      }
```

with:

```js
      // Upstream health is tracked in-process by the dispatcher and is not yet
      // exposed over the control socket (Phase 1.5). Show no tag rather than a
      // misleading "no health check yet".
      const healthTag = '';
```

Leave the `console.log(... ${healthTag})` line as-is (it now appends an empty string).

- [ ] **Step 3: Remove the now-unused `live` reference**

Search the rest of `statusScreen` for other uses of the removed `const live`. If none remain, you're done. If the variable name `live` collides with the Step 1 block, rename the Step 1 variable to `liveStatus` consistently in that block.

- [ ] **Step 4: Syntax-check**

Run: `node --check src/dashboard.js`
Expected: no output (exit 0).

- [ ] **Step 5: Manual verification**

Run: `node src/dashboard.js` → `[10] Status & Health` with the dispatcher running.
Expected: a "── Live (dispatcher) ──" block whose Uptime/Agents/Active/Queue match `node src/cli.js ctl status`; API-Proxy upstreams listed with **no** "[no health check yet]" tag. Stop the dispatcher → the Live block shows "Dispatcher not running".

- [ ] **Step 6: Commit**

```bash
git add src/dashboard.js
git commit -m "fix(tui): Status & Health pulls live numbers from socket; drop dead health tag"
```

---

## Task 5: Fix the View Logs path resolution

**Files:**
- Modify: `src/dashboard.js` — add `resolveDispatcherLogPath()` helper + the `case 'logs'` block (~line 2954)

- [ ] **Step 1: Add the helper**

In `src/dashboard.js`, near the other top-level helper functions (e.g. just above `async function statusScreen(`), add:

```js
// Resolve where the dispatcher's log actually is, in priority order.
// Returns an existing path, or null if logs aren't captured to a file.
function resolveDispatcherLogPath() {
  const candidates = [];
  try {
    const cfg = loadCfg();
    if (cfg && cfg.runtime && cfg.runtime.log_file) candidates.push(cfg.runtime.log_file);
  } catch { /* ignore */ }
  candidates.push('/tmp/dispatcher.log'); // path used when the dashboard starts it
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}
```

- [ ] **Step 2: Rewrite the `logs` case**

Replace the body of `case 'logs': {` (from `console.clear();` down to its `break;`) with:

```js
      case 'logs': {
        console.clear();
        console.log('\n  ═══ Dispatcher Logs ═══\n');
        const logPath = resolveDispatcherLogPath();
        if (!logPath) {
          console.log('  Logs are not being captured to a file.');
          console.log('  The dispatcher was started outside the dashboard, so its');
          console.log('  output went to wherever its stdout was pointed.');
          console.log('  Start it via [7] to capture logs, or redirect stdout to a file.\n');
          await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
          break;
        }
        console.log(`  Streaming ${logPath} — press Ctrl+C to stop\n`);
        const { spawn } = require('child_process');
        const tail = spawn('tail', ['-f', '-n', '40', logPath], { stdio: 'inherit' });
        let resolved = false;
        await new Promise((resolve) => {
          const done = () => { if (resolved) return; resolved = true; process.removeListener('SIGINT', handler); resolve(); };
          const handler = () => { tail.kill(); done(); };
          tail.on('close', done);
          process.on('SIGINT', handler);
        });
        break;
      }
```

- [ ] **Step 3: Syntax-check**

Run: `node --check src/dashboard.js`
Expected: no output (exit 0).

- [ ] **Step 4: Manual verification**

Case A — dispatcher started via dashboard (`[7]`): `[9] View Logs` streams `/tmp/dispatcher.log`.
Case B — no log file present (rename/remove `/tmp/dispatcher.log` and no `log_file` config): `[9] View Logs` prints the honest "Logs are not being captured to a file" message instead of "No log file found. Start the dispatcher first." and returns on Enter/ESC.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard.js
git commit -m "fix(tui): resolve real dispatcher log path with honest fallback"
```

---

## Task 6: Full suite + lint, final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: lint (`node --check`) clean, then all tests pass including the new `live-screen.test.js` (9 new tests). Confirm the prior count (163) increased by 9 to 172 and 0 fail.

- [ ] **Step 2: Lint the changed files explicitly**

Run: `node --check src/dashboard.js src/tui/live-screen.js`
Expected: no output (exit 0).

- [ ] **Step 3: End-to-end smoke (with dispatcher running)**

Run: `node src/cli.js ctl jobs` and compare with the dashboard's Live Jobs screen.
Expected: same active jobs + queue depth in both.

- [ ] **Step 4: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "chore(tui): phase 1 live jobs — verification pass"
```

(If no changes were needed in this task, skip the commit.)

---

## Notes for the implementer

- **Do not modify `src/cli.js`, `src/control.js`, or any daemon code.** This phase is client-side only.
- The `runLiveScreen` loop is the one piece that touches the real TTY; its tests inject a fake stdin precisely so we never depend on a real terminal in CI.
- If `buildStatus` field names differ from those assumed in Task 4 Step 1, **match the real names** — that note is in the task itself; it is the only place a field-name assumption exists.
- Upstream-health tag full repair and per-job Docker log tail are intentionally **out of scope** (Phase 1.5 / blocked on the daemon log-persistence P0 fix). Do not stub them.
