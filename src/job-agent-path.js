'use strict';
/**
 * Locate this install's job-agent.js and, when needed, expose it at the
 * path @junction41/secure-setup 0.3.0 hardcodes (global scoped package).
 * The unscoped alias nests the scoped package, so that hardcoded path 404s.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function resolveJobAgentJs(opts = {}) {
  const exists = opts.existsSync || ((p) => fs.existsSync(p));
  const fromDir = opts.fromDir || path.join(__dirname, 'job-agent.js');
  if (exists(fromDir)) return fromDir;
  try {
    const resolved = require.resolve('@junction41/dispatcher/src/job-agent.js');
    if (exists(resolved)) return resolved;
  } catch { /* not a scoped global */ }
  try {
    const aliasPkg = require.resolve('j41-dispatcher/package.json');
    const nested = path.join(path.dirname(aliasPkg), 'node_modules', '@junction41', 'dispatcher', 'src', 'job-agent.js');
    if (exists(nested)) return nested;
  } catch { /* alias not installed */ }
  return null;
}

function npmGlobalPrefix(opts = {}) {
  if (opts.npmPrefix) return opts.npmPrefix;
  const run = opts.execSync || execSync;
  try {
    return String(run('npm prefix -g', { encoding: 'utf8', timeout: 5000 })).trim();
  } catch {
    return null;
  }
}

function secureSetupSearchPaths(opts = {}) {
  const prefix = npmGlobalPrefix(opts);
  const paths = [
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', '@junction41', 'dispatcher', 'src', 'job-agent.js'),
    '/usr/lib/node_modules/@junction41/dispatcher/src/job-agent.js',
    '/usr/local/lib/node_modules/@junction41/dispatcher/src/job-agent.js',
  ];
  if (prefix) {
    paths.push(path.join(prefix, 'lib', 'node_modules', '@junction41', 'dispatcher', 'src', 'job-agent.js'));
  }
  return paths;
}

function packageRootFromJobAgent(jobAgentPath) {
  return path.resolve(path.dirname(jobAgentPath), '..');
}

function ensureJobAgentVisibleToSecureSetup(opts = {}) {
  const exists = opts.existsSync || ((p) => fs.existsSync(p));
  const mkdir = opts.mkdirSync || ((p, o) => fs.mkdirSync(p, o));
  const symlink = opts.symlinkSync || ((t, p) => fs.symlinkSync(t, p));
  const lstat = opts.lstatSync || ((p) => fs.lstatSync(p));
  const job = resolveJobAgentJs(opts);
  if (!job) return { ok: false, reason: 'not-found' };
  const search = opts.searchPaths || secureSetupSearchPaths(opts);
  const visible = search.find((p) => exists(p));
  if (visible) return { ok: true, reason: 'already-visible', path: visible };

  const prefix = npmGlobalPrefix(opts);
  if (!prefix) return { ok: false, reason: 'no-npm-prefix', job };
  const dest = path.join(prefix, 'lib', 'node_modules', '@junction41', 'dispatcher');
  const destJob = path.join(dest, 'src', 'job-agent.js');
  if (exists(destJob)) return { ok: true, reason: 'already-visible', path: destJob };

  const pkgRoot = packageRootFromJobAgent(job);
  const unlink = opts.unlinkSync || ((p) => fs.unlinkSync(p));
  const rmdir = opts.rmdirSync || ((p) => fs.rmdirSync(p));
  const readdir = opts.readdirSync || ((p) => fs.readdirSync(p));
  // lstat, not existsSync: a dangling symlink is "absent" to existsSync and
  // then symlink() throws EEXIST.
  let destSt = null;
  try { destSt = lstat(dest); } catch { destSt = null; }
  try {
    if (destSt) {
      if (destSt.isSymbolicLink()) {
        try { unlink(dest); } catch (e) {
          return { ok: false, reason: 'dest-exists', dest, error: e.message };
        }
      } else if (destSt.isDirectory()) {
        let names;
        try { names = readdir(dest); } catch (e) {
          return { ok: false, reason: 'dest-exists', dest, error: e.message };
        }
        if (!Array.isArray(names) || names.length > 0) {
          return { ok: false, reason: 'dest-exists', dest };
        }
        try { rmdir(dest); } catch (e) {
          return { ok: false, reason: 'dest-exists', dest, error: e.message };
        }
      } else {
        return { ok: false, reason: 'dest-exists', dest };
      }
    }
    mkdir(path.dirname(dest), { recursive: true });
    symlink(pkgRoot, dest);
    return { ok: true, reason: 'symlinked', dest, target: pkgRoot };
  } catch (e) {
    return { ok: false, reason: 'symlink-failed', error: e.message, dest, target: pkgRoot };
  }
}

module.exports = {
  resolveJobAgentJs,
  npmGlobalPrefix,
  secureSetupSearchPaths,
  ensureJobAgentVisibleToSecureSetup,
  packageRootFromJobAgent,
};
