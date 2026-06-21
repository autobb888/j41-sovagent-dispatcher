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
