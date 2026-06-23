# Docker Job-Log Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist Docker (and local) job logs to `output.log` with a privacy-aware retention policy, so `logs`/`logs -f`/the TUI tail work for all jobs.

**Architecture:** A new pure module `src/job-log.js` holds all retention/cap decision logic (unit-tested in isolation). `src/cli.js` calls those pure functions from the job run/teardown plumbing: the Docker path gains an `output.log` writer with a size cap, both teardown paths archive failed-job logs to `JOBS_DIR/_logs/<jobId>.log`, and the `logs` command surfaces archives. Config gains three `runtime.*` knobs.

**Tech Stack:** Node.js (CommonJS, no build step), `node:test` + `node:assert/strict`, `dockerode`, `@iarna/toml` via `config-loader.js`.

**Spec:** `docs/superpowers/specs/2026-06-22-docker-log-persistence-design.md`

---

## File Structure

- **Create `src/job-log.js`** — pure decisions: `resolveLogRetention`, `isAbnormalExit`, `shouldArchiveLog`, `applyLogCap`, `selectLogsToPrune`. No I/O.
- **Create `test/job-log.test.js`** — exhaustive unit tests for the above.
- **Modify `src/config-loader.js`** — add three `DEFAULTS.runtime` keys + three `ENV_OVERRIDES` rows.
- **Modify `test/config-loader.test.js`** — regression for new defaults + env overrides.
- **Modify `src/cli.js`** — require job-log helpers; add a capped-writer helper; Docker `output.log` writer + exit capture (`startJobContainer`); local cap + exit stash (`startJobLocal`); teardown archival + timeout `_killed` flag (`stopJobContainer`, `stopJobLocal`, timeout timer); `logs` command archive surfacing.

`src/cli.js` edits are module-level / inside large functions with heavy side effects on import, so they are **not** unit-tested. They are verified by `node --check src/cli.js` and the controller smoke test (Task 7), matching the project's established pattern for cli.js changes.

---

## Task 1: Pure `src/job-log.js` module

**Files:**
- Create: `src/job-log.js`
- Test: `test/job-log.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/job-log.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveLogRetention, isAbnormalExit, shouldArchiveLog,
  applyLogCap, selectLogsToPrune, VALID_RETENTION,
} = require('../src/job-log.js');

test('resolveLogRetention passes through valid values', () => {
  assert.equal(resolveLogRetention({ runtime: { job_log_retention: 'off' } }), 'off');
  assert.equal(resolveLogRetention({ runtime: { job_log_retention: 'errors' } }), 'errors');
  assert.equal(resolveLogRetention({ runtime: { job_log_retention: 'all' } }), 'all');
});

test('resolveLogRetention coerces missing/invalid to errors', () => {
  assert.equal(resolveLogRetention({}), 'errors');
  assert.equal(resolveLogRetention(undefined), 'errors');
  assert.equal(resolveLogRetention({ runtime: {} }), 'errors');
  assert.equal(resolveLogRetention({ runtime: { job_log_retention: 'bogus' } }), 'errors');
  assert.equal(resolveLogRetention({ runtime: { job_log_retention: 3 } }), 'errors');
});

test('VALID_RETENTION lists exactly the three modes', () => {
  assert.deepEqual([...VALID_RETENTION].sort(), ['all', 'errors', 'off']);
});

test('isAbnormalExit truth table', () => {
  assert.equal(isAbnormalExit({ killed: true }), true);
  assert.equal(isAbnormalExit({ exitCode: 1 }), true);
  assert.equal(isAbnormalExit({ exitCode: 137, killed: true }), true);
  assert.equal(isAbnormalExit({ exitCode: 0 }), false);
  assert.equal(isAbnormalExit({}), false);
  assert.equal(isAbnormalExit({ exitCode: null }), false);
  assert.equal(isAbnormalExit(undefined), false);
});

test('shouldArchiveLog respects retention mode', () => {
  assert.equal(shouldArchiveLog('off', { exitCode: 1, killed: true }), false);
  assert.equal(shouldArchiveLog('all', { exitCode: 0 }), true);
  assert.equal(shouldArchiveLog('errors', { exitCode: 1 }), true);
  assert.equal(shouldArchiveLog('errors', { exitCode: 0 }), false);
  assert.equal(shouldArchiveLog('errors', { killed: true }), true);
});

test('applyLogCap writes whole chunk under the cap', () => {
  const r = applyLogCap(0, Buffer.from('hello'), 100);
  assert.equal(r.data.toString(), 'hello');
  assert.equal(r.written, 5);
  assert.equal(r.truncated, false);
});

test('applyLogCap accepts string input', () => {
  const r = applyLogCap(0, 'abc', 100);
  assert.equal(r.data.toString(), 'abc');
  assert.equal(r.written, 3);
});

test('applyLogCap slices the chunk that crosses the cap and flags truncated', () => {
  const r = applyLogCap(8, Buffer.from('abcdef'), 10); // room = 2
  assert.equal(r.data.toString(), 'ab');
  assert.equal(r.written, 10);
  assert.equal(r.truncated, true);
});

test('applyLogCap writes nothing once already at/over the cap', () => {
  const r = applyLogCap(10, Buffer.from('xyz'), 10);
  assert.equal(r.data.length, 0);
  assert.equal(r.written, 10);
  assert.equal(r.truncated, false);
});

test('applyLogCap exact-fit boundary is not truncated', () => {
  const r = applyLogCap(7, Buffer.from('abc'), 10); // room = 3, exact
  assert.equal(r.data.toString(), 'abc');
  assert.equal(r.written, 10);
  assert.equal(r.truncated, false);
});

test('selectLogsToPrune returns [] under or at cap', () => {
  assert.deepEqual(selectLogsToPrune([{ id: 'a', mtimeMs: 1 }], 50), []);
  const exactly = Array.from({ length: 50 }, (_, i) => ({ id: `j${i}`, mtimeMs: i }));
  assert.deepEqual(selectLogsToPrune(exactly, 50), []);
});

test('selectLogsToPrune drops oldest-first when over cap', () => {
  const entries = [
    { id: 'new', mtimeMs: 300 },
    { id: 'old', mtimeMs: 100 },
    { id: 'mid', mtimeMs: 200 },
  ];
  assert.deepEqual(selectLogsToPrune(entries, 2), ['old']);
  assert.deepEqual(selectLogsToPrune(entries, 1), ['old', 'mid']);
});

test('selectLogsToPrune tolerates non-array', () => {
  assert.deepEqual(selectLogsToPrune(undefined, 5), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/job-log.test.js`
Expected: FAIL — `Cannot find module '../src/job-log.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/job-log.js`:

```js
'use strict';

const VALID_RETENTION = ['off', 'errors', 'all'];

/** Resolve retention mode from config; invalid/missing → 'errors'. */
function resolveLogRetention(cfg) {
  const v = cfg && cfg.runtime && cfg.runtime.job_log_retention;
  return VALID_RETENTION.includes(v) ? v : 'errors';
}

/**
 * Was the job's exit abnormal (worth keeping for debugging)?
 * killed (timeout/manual) → abnormal; known non-zero exit → abnormal;
 * exit 0 or unknown (undefined/null) → normal (favor the privacy default).
 */
function isAbnormalExit(exitInfo) {
  const info = exitInfo || {};
  if (info.killed) return true;
  if (info.exitCode === 0 || info.exitCode == null) return false;
  return true;
}

/** Should the log be archived past cleanup, given retention + exit? */
function shouldArchiveLog(retention, exitInfo) {
  if (retention === 'off') return false;
  if (retention === 'all') return true;
  return isAbnormalExit(exitInfo); // 'errors'
}

/**
 * Cap output.log growth. Given bytes already written and the next chunk,
 * return the slice to actually write, the new running total, and whether the
 * one-time truncation notice should be emitted now.
 */
function applyLogCap(written, chunk, maxBytes) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (written >= maxBytes) return { data: Buffer.alloc(0), written, truncated: false };
  const room = maxBytes - written;
  if (buf.length <= room) {
    return { data: buf, written: written + buf.length, truncated: false };
  }
  return { data: buf.subarray(0, room), written: maxBytes, truncated: true };
}

/**
 * Choose which archived logs to delete to honor maxRetained.
 * entries: [{ id, mtimeMs }]; returns the ids to remove (oldest first).
 */
function selectLogsToPrune(entries, maxRetained) {
  if (!Array.isArray(entries) || entries.length <= maxRetained) return [];
  const sorted = [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs);
  return sorted.slice(0, sorted.length - maxRetained).map(e => e.id);
}

module.exports = {
  resolveLogRetention, isAbnormalExit, shouldArchiveLog, applyLogCap,
  selectLogsToPrune, VALID_RETENTION,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/job-log.test.js`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/job-log.js test/job-log.test.js
git commit -m "feat(logs): pure job-log retention + cap decision module"
```

---

## Task 2: Config defaults + env overrides

**Files:**
- Modify: `src/config-loader.js` (`DEFAULTS.runtime` ~line 12; `ENV_OVERRIDES` ~line 100)
- Test: `test/config-loader.test.js`

- [ ] **Step 1: Write the failing test**

`test/config-loader.test.js` already exists and drives the real public API through a `withTmpHome` helper with `loadDispatcherConfig({ skipMigration: true })`. Append these two `test(...)` blocks at the end of the file (do NOT add new exports to `config-loader.js` — `DEFAULTS`/`applyEnvOverrides` are intentionally private; test through the loader like every other test in this file):

```js
test('runtime defaults include job-log knobs', withTmpHome(async () => {
  const { loadDispatcherConfig } = require('../src/config-loader.js');
  const cfg = loadDispatcherConfig({ skipMigration: true });
  assert.strictEqual(cfg.runtime.job_log_retention, 'errors');
  assert.strictEqual(cfg.runtime.job_log_max_bytes, 5242880);
  assert.strictEqual(cfg.runtime.job_log_max_retained, 50);
}));

test('J41_JOB_LOG_* env overrides apply with correct types', withTmpHome(async () => {
  const { loadDispatcherConfig } = require('../src/config-loader.js');
  process.env.J41_JOB_LOG_RETENTION = 'all';
  process.env.J41_JOB_LOG_MAX_BYTES = '1048576';
  process.env.J41_JOB_LOG_MAX_RETAINED = '10';
  try {
    const cfg = loadDispatcherConfig({ skipMigration: true });
    assert.strictEqual(cfg.runtime.job_log_retention, 'all');
    assert.strictEqual(cfg.runtime.job_log_max_bytes, 1048576);
    assert.strictEqual(typeof cfg.runtime.job_log_max_bytes, 'number');
    assert.strictEqual(cfg.runtime.job_log_max_retained, 10);
  } finally {
    delete process.env.J41_JOB_LOG_RETENTION;
    delete process.env.J41_JOB_LOG_MAX_BYTES;
    delete process.env.J41_JOB_LOG_MAX_RETAINED;
  }
}));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config-loader.test.js`
Expected: FAIL — `cfg.runtime.job_log_retention` is `undefined` (the two new tests fail; existing tests still pass).

- [ ] **Step 3: Add the defaults**

In `src/config-loader.js`, extend `DEFAULTS.runtime` (currently ends with `webhook_url: ''`):

```js
  runtime: {
    max_concurrent: 0,
    keep_containers: false,
    require_finalize: false,
    skip_status_check: false,
    allow_local_upstream: false,
    health_port: 9842,
    control_api_port: 9843,
    webhook_url: '',
    job_log_retention: 'errors',   // 'off' | 'errors' | 'all'
    job_log_max_bytes: 5242880,    // 5 MB per output.log
    job_log_max_retained: 50,      // archived logs kept under jobs/_logs/
  },
```

Add to the `ENV_OVERRIDES` array (after the existing `runtime.*` rows):

```js
  ['J41_JOB_LOG_RETENTION',    'runtime.job_log_retention',    'string'],
  ['J41_JOB_LOG_MAX_BYTES',    'runtime.job_log_max_bytes',    'int'],
  ['J41_JOB_LOG_MAX_RETAINED', 'runtime.job_log_max_retained', 'int'],
```

No export changes are needed: `loadDispatcherConfig` already merges `DEFAULTS` and applies `ENV_OVERRIDES` (via `applyEnvOverrides(merged)` at ~line 406), so the new keys flow through automatically.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/config-loader.test.js`
Expected: PASS.

- [ ] **Step 5: Verify no regression in the full suite**

Run: `node --test test/*.test.js`
Expected: PASS — all tests (now including job-log) green.

- [ ] **Step 6: Commit**

```bash
git add src/config-loader.js test/config-loader.test.js
git commit -m "feat(config): add runtime.job_log_retention/max_bytes/max_retained knobs"
```

---

## Task 3: Docker write path — persist `output.log` + capture exit code

**Files:**
- Modify: `src/cli.js` — top-of-file requires; new `makeCappedLogWriter` helper; `startJobContainer` log-stream block (the `// Stream container logs to dispatcher stdout for debugging` try block, currently ~line 5629).

- [ ] **Step 1: Add the require**

Near the other local requires at the top of `src/cli.js` (e.g. beside `const { findMainnetSecurityViolations, resolveIsMainnet } = require('./mainnet-guard.js');`), add:

```js
const { resolveLogRetention, shouldArchiveLog, applyLogCap, selectLogsToPrune } = require('./job-log.js');
```

- [ ] **Step 2: Add the capped-writer helper**

Add this function in `src/cli.js` above `async function startJobContainer` (it is reused by the local path in Task 4):

```js
// Returns a write(text) fn that appends to logStream but never lets the file
// exceed maxBytes; emits a single truncation notice when the cap is first hit.
function makeCappedLogWriter(logStream, maxBytes) {
  let written = 0;
  let noticed = false;
  return (text) => {
    const r = applyLogCap(written, Buffer.from(text), maxBytes);
    written = r.written;
    if (r.data.length) logStream.write(r.data);
    if (r.truncated && !noticed) {
      noticed = true;
      logStream.write(`\n[output.log truncated at ${maxBytes} bytes]\n`);
    }
  };
}
```

- [ ] **Step 3: Replace the Docker log-stream block**

In `startJobContainer`, replace the existing block:

```js
    // Stream container logs to dispatcher stdout for debugging
    try {
      const logStream = await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        timestamps: false,
      });
      const shortId = job.id.substring(0, 8);
      logStream.on('data', (chunk) => {
        // Docker multiplexed stream: first 8 bytes are header, rest is payload
        const lines = chunk.toString('utf8').replace(/[\x00-\x08]/g, '').trim();
        if (lines) {
          for (const line of lines.split('\n')) {
            const clean = line.trim();
            if (clean) console.log(`  [${shortId}] ${clean}`);
          }
        }
      });
      logStream.on('error', () => {}); // ignore stream errors when container exits
    } catch (e) {
      // Non-fatal: log streaming is for debugging only
    }
```

with:

```js
    // Stream container logs to the dispatcher console AND a per-job output.log,
    // so `logs`/`logs -f`/the TUI tail work for container jobs (parity with the
    // local-exec path). Best-effort: log failures never affect the job.
    try {
      const logStream = await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        timestamps: false,
      });
      const shortId = job.id.substring(0, 8);
      const logPath = path.join(jobDir, 'output.log');
      const fileStream = fs.createWriteStream(logPath, { flags: 'a' });
      fileStream.on('error', () => {}); // disk full / racey rm — non-fatal
      fileStream.write(`[${new Date().toISOString()}] Container started — agent: ${agentInfo.id}, container: ${container?.name || '?'}\n`);
      const writeCapped = makeCappedLogWriter(fileStream, cfg.runtime.job_log_max_bytes);

      // Capture the container's exit status for retention decisions at teardown.
      container.wait().then((r) => {
        const a = state.active.get(job.id);
        if (a) a._exitCode = r && r.StatusCode;
      }).catch(() => {});

      logStream.on('data', (chunk) => {
        // Docker multiplexed stream: first 8 bytes are header, rest is payload
        const lines = chunk.toString('utf8').replace(/[\x00-\x08]/g, '').trim();
        if (lines) {
          writeCapped(lines + '\n');
          for (const line of lines.split('\n')) {
            const clean = line.trim();
            if (clean) console.log(`  [${shortId}] ${clean}`);
          }
        }
      });
      logStream.on('end', () => {
        try { fileStream.end(`[${new Date().toISOString()}] Container exited\n`); } catch { /* already closed */ }
      });
      logStream.on('error', () => { try { fileStream.end(); } catch { /* noop */ } });

      const activeEntry = state.active.get(job.id);
      if (activeEntry) activeEntry._logStream = fileStream;
    } catch (e) {
      // Non-fatal: log streaming is for debugging only
    }
```

- [ ] **Step 4: Verify syntax**

Run: `node --check src/cli.js`
Expected: no output (exit 0).

- [ ] **Step 5: Verify the suite still passes**

Run: `node --test test/*.test.js`
Expected: PASS (unchanged count from Task 2; cli.js has no unit tests).

- [ ] **Step 6: Commit**

```bash
git add src/cli.js
git commit -m "feat(logs): persist container job logs to output.log with size cap"
```

---

## Task 4: Local write path — apply the cap + stash exit code

**Files:**
- Modify: `src/cli.js` — `startJobLocal` stdout/stderr handlers (~line 5824) and its `child.on('exit', ...)` handler (~line 5839).

- [ ] **Step 1: Wrap the local writes with the cap**

In `startJobLocal`, the current block is:

```js
    const shortId = job.id.substring(0, 8);
    const logPath = path.join(jobDir, 'output.log');
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    logStream.write(`[${new Date().toISOString()}] Job started — agent: ${agentInfo.id}, PID: ${child.pid}\n`);

    child.stdout.on('data', (data) => {
      const text = data.toString();
      logStream.write(text);
      text.trim().split('\n').forEach(line => {
        if (line.trim()) console.log(`  [${shortId}] ${line.trim()}`);
      });
    });
    child.stderr.on('data', (data) => {
      const text = data.toString();
      logStream.write(text);
      text.trim().split('\n').forEach(line => {
        if (line.trim()) console.error(`  [${shortId}] ${line.trim()}`);
      });
    });
```

Replace it with (introduce `writeCapped`, swap the two `logStream.write(text)` calls):

```js
    const shortId = job.id.substring(0, 8);
    const logPath = path.join(jobDir, 'output.log');
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    logStream.write(`[${new Date().toISOString()}] Job started — agent: ${agentInfo.id}, PID: ${child.pid}\n`);
    const writeCapped = makeCappedLogWriter(logStream, cfg.runtime.job_log_max_bytes);

    child.stdout.on('data', (data) => {
      const text = data.toString();
      writeCapped(text);
      text.trim().split('\n').forEach(line => {
        if (line.trim()) console.log(`  [${shortId}] ${line.trim()}`);
      });
    });
    child.stderr.on('data', (data) => {
      const text = data.toString();
      writeCapped(text);
      text.trim().split('\n').forEach(line => {
        if (line.trim()) console.error(`  [${shortId}] ${line.trim()}`);
      });
    });
```

- [ ] **Step 2: Stash the exit code/signal on the active entry**

The current exit handler is:

```js
    child.on('exit', (code, signal) => {
      logStream.write(`[${new Date().toISOString()}] Job process exited\n`);
      logStream.end();
```

Insert the stash right after the banner write:

```js
    child.on('exit', (code, signal) => {
      logStream.write(`[${new Date().toISOString()}] Job process exited\n`);
      logStream.end();
      const a = state.active.get(job.id);
      if (a) { a._exitCode = code; a._killed = !!signal; }
```

(Leave the rest of the handler — the crash-counter / `container.died` emit — unchanged.)

- [ ] **Step 3: Verify syntax**

Run: `node --check src/cli.js`
Expected: no output (exit 0).

- [ ] **Step 4: Commit**

```bash
git add src/cli.js
git commit -m "feat(logs): cap local output.log + record exit status for retention"
```

---

## Task 5: Teardown archival + timeout kill flag

**Files:**
- Modify: `src/cli.js` — the container timeout timer (~line 5655); `stopJobContainer` cleanup (~line 5718); `stopJobLocal` cleanup (~line 5980).

- [ ] **Step 1: Mark timed-out jobs as killed**

In `startJobContainer`, the timeout timer currently is:

```js
    const _timeoutTimer = setTimeout(async () => {
      const active = state.active.get(job.id);
      if (active) {
        console.log(`⏰ Job ${job.id} timeout, killing container`);
        await stopJobContainer(state, job.id);
      }
    }, JOB_TIMEOUT_MS + 60000);
```

Set `_killed` before teardown:

```js
    const _timeoutTimer = setTimeout(async () => {
      const active = state.active.get(job.id);
      if (active) {
        active._killed = true;
        console.log(`⏰ Job ${job.id} timeout, killing container`);
        await stopJobContainer(state, job.id);
      }
    }, JOB_TIMEOUT_MS + 60000);
```

- [ ] **Step 2: Archive on container teardown**

In `stopJobContainer`, the current cleanup is:

```js
  // Cleanup job dir (retain for debugging if requested)
  const jobDir = path.join(JOBS_DIR, jobId);
  if (fs.existsSync(jobDir) && !cfg.runtime.keep_containers) {
    fs.rmSync(jobDir, { recursive: true });
  }
```

Replace with (close the log stream, archive if warranted, then remove):

```js
  // Flush the per-job log stream before we archive/remove the dir.
  if (active._logStream) {
    try { active._logStream.end(); } catch { /* already closed */ }
  }

  // Cleanup job dir (retain for debugging if requested)
  const jobDir = path.join(JOBS_DIR, jobId);
  archiveJobLog(jobDir, jobId, { exitCode: active._exitCode, killed: active._killed });
  if (fs.existsSync(jobDir) && !cfg.runtime.keep_containers) {
    fs.rmSync(jobDir, { recursive: true });
  }
```

- [ ] **Step 3: Add the shared `archiveJobLog` helper**

Add this function in `src/cli.js` above `async function stopJobContainer` (reused by `stopJobLocal`):

```js
// Archive a finished job's output.log to JOBS_DIR/_logs/<jobId>.log when the
// retention policy says to keep it, then prune to job_log_max_retained.
// Best-effort: never throws into the cleanup path.
function archiveJobLog(jobDir, jobId, exitInfo) {
  try {
    const retention = resolveLogRetention(cfg);
    const logPath = path.join(jobDir, 'output.log');
    if (!fs.existsSync(logPath) || !shouldArchiveLog(retention, exitInfo)) return;
    const archiveDir = path.join(JOBS_DIR, '_logs');
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(logPath, path.join(archiveDir, `${jobId}.log`));
    const entries = fs.readdirSync(archiveDir)
      .filter(f => f.endsWith('.log'))
      .map(f => ({ id: f.slice(0, -4), mtimeMs: fs.statSync(path.join(archiveDir, f)).mtimeMs }));
    for (const id of selectLogsToPrune(entries, cfg.runtime.job_log_max_retained)) {
      fs.rmSync(path.join(archiveDir, `${id}.log`), { force: true });
    }
  } catch (e) {
    console.error(`[Logs] archive failed for ${jobId}: ${e.message}`);
  }
}
```

- [ ] **Step 4: Archive on local teardown**

In `stopJobLocal`, the current cleanup is:

```js
  const jobDir = path.join(JOBS_DIR, jobId);
  if (fs.existsSync(jobDir) && !cfg.runtime.keep_containers) {
    fs.rmSync(jobDir, { recursive: true });
  }
```

Replace with:

```js
  const jobDir = path.join(JOBS_DIR, jobId);
  archiveJobLog(jobDir, jobId, { exitCode: active._exitCode, killed: active._killed });
  if (fs.existsSync(jobDir) && !cfg.runtime.keep_containers) {
    fs.rmSync(jobDir, { recursive: true });
  }
```

> NOTE: `stopJobLocal` already binds `const active = state.active.get(jobId);` near its top (it returns early if missing), so `active._exitCode`/`active._killed` are in scope. Confirm this before editing; if the local variable has a different name, use that name.

- [ ] **Step 5: Verify syntax**

Run: `node --check src/cli.js`
Expected: no output (exit 0).

- [ ] **Step 6: Commit**

```bash
git add src/cli.js
git commit -m "feat(logs): archive failed-job logs on teardown per retention policy"
```

---

## Task 6: Surface archived logs in the `logs` command

**Files:**
- Modify: `src/cli.js` — the `logs` command action (~line 3955): the no-arg lister (~3964) and the with-arg resolver (~3992-4012).

- [ ] **Step 1: Include archives in the lister**

In the no-arg branch, after the existing loop that prints live job dirs (right before the closing `console.log('\n  View: ...')` lines at ~3982), add an archived-logs section:

```js
      const archiveDir = path.join(JOBS_DIR, '_logs');
      if (fs.existsSync(archiveDir)) {
        const archived = fs.readdirSync(archiveDir).filter(f => f.endsWith('.log'));
        if (archived.length) {
          console.log(`\n── Archived Logs (${archived.length}) ──\n`);
          for (const f of archived.slice(-20)) {
            const p = path.join(archiveDir, f);
            const stat = fs.statSync(p);
            const size = (stat.size / 1024).toFixed(1);
            console.log(`  ${f.slice(0, -4).substring(0, 8)}  ${stat.mtime.toISOString().substring(0, 19)}  ${size}KB  [archived]`);
          }
        }
      }
```

(The live-dir scan at ~3964 filters on `output.log` existing inside each subdir, so the `_logs` directory is naturally skipped — no change needed there.)

- [ ] **Step 2: Fall back to the archive in the viewer**

The current resolver is:

```js
    const fullJobId = matches[0];
    const logPath = path.join(JOBS_DIR, fullJobId, 'output.log');

    if (!fs.existsSync(logPath)) {
      console.error(`❌ No log file for job ${fullJobId}`);
      // Show what files exist
      const files = fs.readdirSync(path.join(JOBS_DIR, fullJobId));
      console.log(`   Files: ${files.join(', ')}`);
      process.exit(1);
    }
```

Replace with a version that resolves a live `output.log` OR an archived stem (and supports a prefix that only matches an archive):

```js
    // Resolve to a live job dir's output.log or an archived _logs/<id>.log.
    const archiveDir = path.join(JOBS_DIR, '_logs');
    let fullJobId = matches[0];
    let logPath = matches.length ? path.join(JOBS_DIR, fullJobId, 'output.log') : null;

    if (!logPath || !fs.existsSync(logPath)) {
      // Try archives, matching by prefix on the <id>.log stem.
      const archived = fs.existsSync(archiveDir)
        ? fs.readdirSync(archiveDir).filter(f => f.endsWith('.log') && f.startsWith(jobId))
        : [];
      if (archived.length === 1) {
        fullJobId = archived[0].slice(0, -4);
        logPath = path.join(archiveDir, archived[0]);
      } else if (archived.length > 1) {
        console.error(`❌ Ambiguous prefix "${jobId}" — matches ${archived.length} archived logs:`);
        archived.forEach(m => console.error(`   ${m.slice(0, -4)}`));
        process.exit(1);
      }
    }

    if (!logPath || !fs.existsSync(logPath)) {
      console.error(`❌ No log file for job "${jobId}"`);
      process.exit(1);
    }
```

> NOTE: this replaces the use of the earlier `matches`/`fullJobId` resolution for the *log-path* only. The earlier prefix-match block (`const matches = fs.readdirSync(JOBS_DIR).filter(d => d.startsWith(jobId));` and its ambiguity guard) still runs first for live job dirs. If `matches.length === 0` for live dirs, that block currently `process.exit(1)`s with "No job found" before reaching here — adjust it so a zero live-dir match falls through to the archive lookup instead of exiting. Concretely: in the earlier guard, replace `if (matches.length === 0) { console.error(...); process.exit(1); }` with `if (matches.length === 0 && !fs.existsSync(path.join(JOBS_DIR, '_logs'))) { console.error(...); process.exit(1); }` and let an empty `matches` flow through (the new resolver handles the archive-only case and the final not-found error).

- [ ] **Step 3: Verify syntax**

Run: `node --check src/cli.js`
Expected: no output (exit 0).

- [ ] **Step 4: Verify the full suite passes**

Run: `node --test test/*.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.js
git commit -m "feat(logs): surface archived job logs in the logs command"
```

---

## Task 7: Live smoke verification (controller, on testnet)

**Files:** none (verification only).

This task is run by the controller, not a subagent. It exercises the cli.js plumbing that has no unit coverage.

- [ ] **Step 1: Full suite + syntax**

Run: `node --test test/*.test.js && node --check src/cli.js`
Expected: all tests PASS; syntax OK.

- [ ] **Step 2: Live run (best-effort, requires a hirable agent)**

With the dispatcher running on testnet and a job dispatched to a container agent:
- `node src/cli.js logs` → the running job appears in the live list.
- `node src/cli.js logs <id> -f` → lines stream as the container logs.
- Kill the job (timeout or manual stop) → after teardown, `node src/cli.js logs` shows it under "Archived Logs", and `node src/cli.js logs <id>` prints the archived content.
- Run a job that completes cleanly under default `errors` retention → confirm it is NOT archived.
- Set `J41_JOB_LOG_RETENTION=all`, run a clean job → confirm it IS archived.

If no live job can be dispatched (backend/agent unavailable), record that Step 2 was skipped and rely on Steps 1 + code review; do not claim it passed.

- [ ] **Step 3: Final whole-branch review**

Dispatch the final code reviewer over the whole branch diff vs `main`, then proceed to `superpowers:finishing-a-development-branch`.

---

## Notes for the implementer

- `cfg` is module-scoped in `src/cli.js` (already used as `cfg.runtime.keep_containers`), so `cfg.runtime.job_log_*` is available in all the functions above without threading it through.
- Do NOT touch `src/control-api.js` or the HTTP control API.
- `JOBS_DIR`, `path`, `fs`, `state` are already in scope in `cli.js`.
- Keep all logging best-effort: a thrown error in the log/archival code must never abort job execution or cleanup.
