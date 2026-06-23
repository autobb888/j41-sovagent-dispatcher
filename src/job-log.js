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
