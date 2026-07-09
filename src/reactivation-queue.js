'use strict';
// Pure operations over an array of reactivation entries. No I/O, no docker.
// Persistence is handled by config.js; scheduling/respawn by cli.js.

function has(q, jobId) { return q.some(e => e.job.id === jobId); }

function enqueue(q, entry) {
  if (has(q, entry.job.id)) return q;
  q.push(entry);
  return q;
}

function markReady(q, jobId) {
  const e = q.find(x => x.job.id === jobId);
  if (!e) return false;
  e.readyToRespawn = true;
  return true;
}

function nextReady(q) {
  const ready = q.filter(e => e.readyToRespawn);
  if (ready.length === 0) return null;
  return ready.reduce((a, b) => (b.pausedAt < a.pausedAt ? b : a));
}

function removeJob(q, jobId) {
  const i = q.findIndex(e => e.job.id === jobId);
  if (i >= 0) q.splice(i, 1);
  return q;
}

function findExpired(q, nowMs) {
  return q.filter(e => nowMs - e.pausedAt >= e.pauseTtlMin * 60000);
}

module.exports = { has, enqueue, markReady, nextReady, removeJob, findExpired };
