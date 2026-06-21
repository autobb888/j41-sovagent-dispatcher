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
      const tok = j.tokens && j.tokens.totalTokens != null ? String(j.tokens.totalTokens) : '-';
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
      if (done) return;
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
