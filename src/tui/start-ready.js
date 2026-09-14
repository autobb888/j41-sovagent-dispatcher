'use strict';

/**
 * Dashboard Start readiness: THIS child's [Health] line after a log seek,
 * then GET that URL. Never a leftover line, never a leftover :9842 200,
 * never the identity-summary banner (printed before security gates).
 */
const fs = require('fs');
const http = require('http');

const HEALTH_LINE_RE = /\[Health\] (http:\/\/127\.0\.0\.1:\d+\/health)/;

function seekLogEnd(logPath, statSync) {
  try {
    return (statSync || fs.statSync)(logPath).size;
  } catch {
    return 0;
  }
}

function readLogSlice(logPath, offset) {
  let fd;
  try {
    fd = fs.openSync(logPath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { text: '', size };
    const len = size - offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    return { text: buf.toString('utf8'), size };
  } catch {
    return { text: '', size: offset };
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function defaultHttpGet(url) {
  return new Promise((resolve) => {
    try {
      const req = http.get(url, (res) => {
        res.resume();
        resolve({ statusCode: res.statusCode });
      });
      req.on('error', () => resolve({ statusCode: 0 }));
      req.setTimeout(2000, () => {
        try { req.destroy(); } catch { /* ignore */ }
        resolve({ statusCode: 0 });
      });
    } catch {
      resolve({ statusCode: 0 });
    }
  });
}

/**
 * Watch dispatcher.log from `startOffset` (captured BEFORE spawn) until this
 * child logs `[Health] http://127.0.0.1:<port>/health` and GET that URL is 200,
 * or the child exits, or timeoutMs elapses.
 *
 * GET is confirmation AFTER the new line — never a standalone probe of :9842.
 *
 * @returns {Promise<{ok: true, url: string} | {ok: false, reason: 'exit'|'timeout', code?: number}>}
 */
async function waitForDispatcherReady(opts) {
  const logPath = opts.logPath;
  let offset = Number.isFinite(opts.startOffset) ? opts.startOffset : seekLogEnd(logPath);
  const child = opts.child;
  const timeoutMs = opts.timeoutMs == null ? 60_000 : opts.timeoutMs;
  const pollMs = opts.pollMs == null ? 100 : opts.pollMs;
  const httpGet = opts.httpGet || defaultHttpGet;
  const now = opts.now || Date.now;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  let exited = false;
  let exitCode;
  const onExit = (code) => { exited = true; exitCode = code; };
  // Attach before reading exitCode so a death between the two is not missed.
  if (child && typeof child.once === 'function') {
    child.once('exit', onExit);
  }
  if (child && typeof child.exitCode === 'number') {
    exited = true;
    exitCode = child.exitCode;
  }

  const deadline = now() + timeoutMs;
  let leftover = '';
  let healthUrl = null;
  try {
    while (now() < deadline) {
      if (exited) return { ok: false, reason: 'exit', code: exitCode };
      const slice = readLogSlice(logPath, offset);
      if (slice.text) {
        leftover += slice.text;
        offset = slice.size;
        const parts = leftover.split('\n');
        leftover = parts.pop();
        for (const line of parts) {
          const m = line.match(HEALTH_LINE_RE);
          if (m) {
            healthUrl = m[1];
            break;
          }
        }
      }
      if (healthUrl) {
        const res = await httpGet(healthUrl);
        if (res && res.statusCode === 200) {
          if (exited) return { ok: false, reason: 'exit', code: exitCode };
          return { ok: true, url: healthUrl };
        }
      }
      await sleep(pollMs);
    }
    if (exited) return { ok: false, reason: 'exit', code: exitCode };
    return { ok: false, reason: 'timeout' };
  } finally {
    if (child && typeof child.removeListener === 'function') {
      child.removeListener('exit', onExit);
    }
  }
}

module.exports = { seekLogEnd, waitForDispatcherReady, HEALTH_LINE_RE };
