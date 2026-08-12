'use strict';
/**
 * Static scope check over every source file.
 *
 * The bug this exists for: `kickWatchdog?.()` in the `start` action, referencing a
 * const declared inside `gracefulShutdown`. Optional chaining guards a null value,
 * never an undeclared binding — so it threw ReferenceError on the flagship upgrade
 * path, aborted startup, and left a process that reported `/health: ok` forever
 * while doing nothing. It survived three adversarial review rounds and 1057 tests,
 * because the failing path had never executed in any version that shipped.
 *
 * Runtime tests cannot cover this in a codebase whose largest functions are
 * unexported closures. A static walk covers all of it, always.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { checkFile } = require('./helpers/scope-check.js');

function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(full));
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('no source file references an identifier that is not in scope', () => {
  const files = sourceFiles(path.join(__dirname, '..', 'src'));
  assert.ok(files.length > 20, `expected to scan the whole tree, found ${files.length} files`);

  const findings = [];
  for (const f of files) {
    for (const p of checkFile(f)) {
      findings.push(`${path.relative(path.join(__dirname, '..'), f)}:${p.line}:${p.col + 1} — '${p.name}'`);
    }
  }
  assert.deepEqual(findings, [],
    `undeclared identifiers found:\n  ${findings.join('\n  ')}`);
});

test('the checker actually detects the shape it was written for', () => {
  // A checker that reports "all clear" because it is broken is worse than none.
  // Plant the exact bug — a call to an identifier declared inside another function,
  // through optional chaining, which is what made the original look safe.
  const tmp = path.join(require('os').tmpdir(), `scope-selftest-${process.pid}.js`);
  fs.writeFileSync(tmp, `
    'use strict';
    function outer() { const helper = () => {}; helper('ok'); }
    function elsewhere() { helper?.('this one is a ReferenceError'); }
    module.exports = { outer, elsewhere };
  `);
  try {
    const found = checkFile(tmp);
    assert.equal(found.length, 1, 'the planted bug must be found');
    assert.equal(found[0].name, 'helper');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('the checker does not cry wolf on ordinary constructs', () => {
  const tmp = path.join(require('os').tmpdir(), `scope-clean-${process.pid}.js`);
  fs.writeFileSync(tmp, `
    'use strict';
    const { a, b: { c } = {}, ...rest } = require('x');
    let counter = 0;
    for (const [k, v] of Object.entries(rest)) { counter += v ? 1 : 0; }
    for (var i = 0; i < 3; i++) { setTimeout(() => console.log(i, a, c), i); }
    try { hoisted(); } catch (err) { console.error(err.message); } finally { counter = 0; }
    function hoisted() { return \`\${counter}\${typeof globalThis}\`; }
    class T extends Object { constructor(z = counter) { super(); this.z = z; } get v() { return this.z; } }
    module.exports = { T, hoisted, counter };
  `);
  try {
    assert.deepEqual(checkFile(tmp), [], 'no false positives on normal code');
  } finally {
    fs.unlinkSync(tmp);
  }
});
