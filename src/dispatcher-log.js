'use strict';
/**
 * Tee `start` stdout/stderr to ~/.j41/dispatcher/dispatcher.log.
 * TUI Start already points the child at this file; do not duplicate then.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function dispatcherLogPath(homedir) {
  return path.join(homedir || os.homedir(), '.j41', 'dispatcher', 'dispatcher.log');
}

function stdoutIsLogFile(logPath, fstatSync, statSync) {
  try {
    const stOut = (fstatSync || fs.fstatSync).call(fs, 1);
    const stLog = (statSync || fs.statSync)(logPath);
    return stOut.dev === stLog.dev && stOut.ino === stLog.ino;
  } catch {
    return false;
  }
}

function attachDispatcherLog(opts = {}) {
  const homedir = opts.homedir || os.homedir();
  const logPath = dispatcherLogPath(homedir);
  const mkdirSync = opts.mkdirSync || ((p, o) => fs.mkdirSync(p, o));
  const openSync = opts.openSync || ((p, flags, mode) => fs.openSync(p, flags, mode));
  const writeSync = opts.writeSync || ((fd, chunk) => fs.writeSync(fd, chunk));
  const closeSync = opts.closeSync || ((fd) => fs.closeSync(fd));
  mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW;
  let fd;
  try {
    fd = openSync(logPath, flags, 0o600);
  } catch (e) {
    return { ok: false, path: logPath, error: e.message };
  }
  if (stdoutIsLogFile(logPath, opts.fstatSync, opts.statSync)) {
    try { closeSync(fd); } catch { /* ignore */ }
    return { ok: true, path: logPath, tee: false };
  }
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  const origOut = stdout.write.bind(stdout);
  const origErr = stderr.write.bind(stderr);
  const tee = (chunk) => {
    try {
      writeSync(fd, typeof chunk === 'string' ? chunk : chunk);
    } catch { /* a log write must never break start */ }
  };
  stdout.write = (chunk, enc, cb) => { tee(chunk); return origOut(chunk, enc, cb); };
  stderr.write = (chunk, enc, cb) => { tee(chunk); return origErr(chunk, enc, cb); };
  return { ok: true, path: logPath, tee: true, fd };
}

module.exports = { dispatcherLogPath, stdoutIsLogFile, attachDispatcherLog };
