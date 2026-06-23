# Docker Job-Log Persistence + Privacy-Aware Retention — Design

**Date:** 2026-06-22
**Status:** Approved (design); pending implementation plan
**Component:** `@junction41/dispatcher` — `src/cli.js`, new `src/job-log.js`, `src/config-loader.js`

## Problem

Container job logs are never persisted. `startJobContainer` (`src/cli.js` ~5629)
streams the container's logs to the dispatcher's `console.log` only — it never
writes them to disk. The `logs` command (`src/cli.js` ~3950) lists/views/tails by
reading `JOBS_DIR/<jobId>/output.log`, so **Docker jobs are invisible to `logs`
and undebuggable in production**. The local-exec path (`startJobLocal` ~5812)
already writes `output.log`; only the container path is missing it.

This also blocks the deferred TUI per-job log tail (Phase 1.5), which would read
the same `output.log`.

## Privacy context (why logs were absent)

The no-logs posture was a deliberate privacy choice. But:

- `output.log` captures only the agent process's **stdout/stderr** —
  operational diagnostics (lifecycle, canary checks, budget math, retry/error
  lines, chat *metadata* like `sender=… bytes=123`), plus **80-char truncated**
  previews of buyer messages (`job-agent.js:701`) and the buyer VerusID
  (`job-agent.js:238`). It does **not** contain deliverables or images —
  those go to the workspace dir and to the platform via `deliverJob`, never to
  stdout.
- That truncated buyer content **already** scrolls across the dispatcher
  operator's own terminal today via `console.log`. The data already lives on the
  operator's machine. Writing it to a `0600` file under the same operator's
  `~/.j41` discloses it to no one new — the real privacy boundary is
  operator↔buyer, and the operator already holds this data.
- Nothing here ships in the npm package or leaves the box.

The privacy goal is therefore reframed as **minimize standing data**, not
"never write logs." Retention is the lever.

## Goal

- Persist container job logs to `output.log` during a run (closes the P0; makes
  `logs`, `logs -f`, and the future TUI tail work for all jobs).
- Govern post-cleanup retention with a privacy-preserving default: keep failed
  jobs only.
- Cap `output.log` size so a misbehaving executor cannot fill the disk.

Non-goals: redacting buyer VerusID / content previews from the persisted file
(possible later toggle, YAGNI now); changing what the agent prints to stdout;
shipping logs anywhere off-box; the TUI tail itself (separate follow-up,
unblocked by this).

## Architecture

### A. New pure module `src/job-log.js` (no I/O — unit-tested)

```js
'use strict';

const VALID_RETENTION = ['off', 'errors', 'all'];

/** Resolve retention mode from config; invalid/missing → 'errors'. */
function resolveLogRetention(cfg) {
  const v = cfg && cfg.runtime && cfg.runtime.job_log_retention;
  return VALID_RETENTION.includes(v) ? v : 'errors';
}

/**
 * Was the job's exit abnormal (→ worth keeping for debugging)?
 * killed (timeout/manual) → abnormal; known non-zero exit → abnormal;
 * exitCode 0 or unknown (undefined/null) → normal (favor the privacy default).
 */
function isAbnormalExit(exitInfo) {
  const { exitCode, killed } = exitInfo || {};
  if (killed) return true;
  if (exitCode === 0 || exitCode == null) return false;
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
 *  - under cap:        write whole chunk
 *  - crosses cap:      write the partial slice that reaches the cap + notice
 *  - already at/over:  write nothing, no repeat notice
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

### B. `src/cli.js` — Docker write path (`startJobContainer` ~5629)

Replace the console-only streaming block with a tee to `output.log`:

- `const logPath = path.join(jobDir, 'output.log');`
- `const logStream = fs.createWriteStream(logPath, { flags: 'a' });`
- Write a start banner: `[<ISO>] Container started — agent: <id>, container: <name>`.
- Track bytes: keep `let logBytes = 0` and a `let capNoticeWritten = false`
  closure (or store on the active entry).
- In the existing `logStream.on('data')` handler, after computing the cleaned
  text, run it through `applyLogCap(logBytes, cleanedBuf, cfg.runtime.job_log_max_bytes)`,
  write `data` to the file, update `logBytes`, and on first `truncated` write a
  single `\n[output.log truncated at <max> bytes]\n` notice. Console output is
  unchanged.
- Attach exit capture: `container.wait().then(r => { const a = state.active.get(job.id); if (a) a._exitCode = r && r.StatusCode; }).catch(() => {});`
- Close the file on the container log stream's `end`/`error` and write an
  `[<ISO>] Container exited` banner.
- Store `logStream` on the active entry (`active._logStream`) so teardown can end
  it if still open.

All wrapped in try/catch; failure to write logs is non-fatal (job proceeds).

### C. `src/cli.js` — timeout path (~5655)

Before calling `stopJobContainer`, set `const a = state.active.get(job.id); if (a) a._killed = true;` so retention sees an abnormal exit.

### D. `src/cli.js` — teardown archival (`stopJobContainer` ~5718 and `stopJobLocal` ~5980)

Before the existing `fs.rmSync(jobDir, ...)`:

```js
try {
  const retention = resolveLogRetention(cfg);
  const logPath = path.join(jobDir, 'output.log');
  if (fs.existsSync(logPath) &&
      shouldArchiveLog(retention, { exitCode: active._exitCode, killed: active._killed })) {
    const archiveDir = path.join(JOBS_DIR, '_logs');
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(logPath, path.join(archiveDir, `${jobId}.log`));
    // prune
    const entries = fs.readdirSync(archiveDir)
      .filter(f => f.endsWith('.log'))
      .map(f => ({ id: f.slice(0, -4), mtimeMs: fs.statSync(path.join(archiveDir, f)).mtimeMs }));
    for (const id of selectLogsToPrune(entries, cfg.runtime.job_log_max_retained)) {
      fs.rmSync(path.join(archiveDir, `${id}.log`), { force: true });
    }
  }
} catch (e) {
  console.error(`[Logs] archive failed for ${jobId}: ${e.message}`); // non-fatal
}
```

`stopJobContainer` must end `active._logStream` first if still open. The
`_killed`/`_exitCode` fields are read from `active`. For the local path,
`startJobLocal`'s `child.on('exit', (code, signal) => …)` already has the code —
stash `active._exitCode = code` and `active._killed = !!signal` there.

### E. `src/cli.js` — local write path (`startJobLocal` ~5820)

Apply `applyLogCap` to its existing `logStream.write(text)` calls (stdout and
stderr handlers) using the same `cfg.runtime.job_log_max_bytes`, for parity and
disk safety. Stash the exit code/ signal on the active entry (see D).

### F. `src/cli.js` — `logs` command (~3950)

- **Lister (no job-id):** in addition to scanning `JOBS_DIR/<dir>/output.log`,
  enumerate `JOBS_DIR/_logs/*.log` and list those as `[archived]` rows (by
  filename stem, with size + mtime). Exclude the literal `_logs` entry from the
  job-dir scan.
- **Viewer/tailer (with job-id):** resolve `JOBS_DIR/<fullJobId>/output.log`
  first; if absent, fall back to `JOBS_DIR/_logs/<fullJobId>.log`. Prefix
  matching also considers archived stems.

### G. `src/config-loader.js` — defaults + env overrides

Add to `DEFAULTS.runtime`:

```js
job_log_retention: 'errors',     // 'off' | 'errors' | 'all'
job_log_max_bytes: 5242880,      // 5 MB per output.log
job_log_max_retained: 50,        // archived logs kept under _logs/
```

Add to `ENV_OVERRIDES`:

```js
['J41_JOB_LOG_RETENTION',    'runtime.job_log_retention',    'string'],
['J41_JOB_LOG_MAX_BYTES',    'runtime.job_log_max_bytes',    'int'],
['J41_JOB_LOG_MAX_RETAINED', 'runtime.job_log_max_retained', 'int'],
```

## Data flow

1. Job starts → `jobDir/output.log` opened (append), start banner written.
2. Container/process stdout+stderr → cleaned → capped → appended to `output.log`
   (and echoed to console as today). Live `logs -f` tails the growing file.
3. Job ends → exit code captured (`container.wait()` / `child.exit`); timeout/
   manual kill sets `_killed`.
4. Teardown → if `shouldArchiveLog`, copy `output.log` → `_logs/<jobId>.log` and
   prune to `job_log_max_retained`; then `jobDir` removed as today (unless
   `keep_containers`).
5. `logs` reads live `output.log` for active jobs, `_logs/<jobId>.log` for
   archived ones.

## Error handling

- All fs operations are best-effort/try-caught; logging never blocks job
  cleanup or delivery.
- `applyLogCap` bounds `output.log` at `job_log_max_bytes`; the truncation notice
  is written exactly once.
- `resolveLogRetention` coerces invalid/missing config to `errors` (never throws).
- Unknown exit code under `errors` retention is treated as a normal exit (not
  archived) — favors the privacy default; the explicit `_killed` flag and
  `container.wait()` status cover the real abnormal cases.
- Archive/prune failures are logged non-fatally.

## Testing

- **`test/job-log.test.js`** (pure, no mocks):
  - `resolveLogRetention`: each valid value passes through; missing/invalid/`undefined` cfg → `errors`.
  - `isAbnormalExit`: truth table — `{killed:true}`→true; `{exitCode:1}`→true; `{exitCode:0}`→false; `{}`/`{exitCode:null}`→false; `{exitCode:137,killed:true}`→true.
  - `shouldArchiveLog`: `off`→always false; `all`→always true; `errors`→matches `isAbnormalExit`.
  - `applyLogCap`: whole chunk under cap; partial slice crossing cap + `truncated:true`; already-at-cap → empty write, `truncated:false`; exact-fit boundary; string and Buffer inputs.
  - `selectLogsToPrune`: under/at cap → `[]`; over cap → oldest-first ids removed, count correct; ties stable.
- **`test/config-loader.test.js`** (regression): new `runtime` defaults present; `J41_JOB_LOG_RETENTION/_MAX_BYTES/_MAX_RETAINED` env overrides apply with correct types.
- **cli.js plumbing**: `node --check src/cli.js`; controller live smoke on testnet — run a job, `logs -f` it live, kill it, confirm `_logs/<jobId>.log` archived; run a clean job under default `errors`, confirm it is NOT archived; set `job_log_retention=all`, confirm a clean job IS archived.

## Success criteria

- A running Docker job's logs appear via `logs <id>` and stream via `logs <id> -f`.
- Failed/killed Docker + local jobs leave a `_logs/<jobId>.log` archive under the
  default `errors` retention; clean jobs do not.
- `off` retains zero standing data (parity with today); `all` keeps every job.
- `output.log` never exceeds `job_log_max_bytes`; archives never exceed
  `job_log_max_retained`.
- `src/job-log.js` has full unit coverage; full suite green; no changes to the
  HTTP control API.
