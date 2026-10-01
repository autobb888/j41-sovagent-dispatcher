'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const PIN = 'github:VerusCoin/verus-typescript-primitives#27e6c076def4416c20a568e31e4c406b10612807';

test('seal-open is registered and writes only after --yes', () => {
  const cli = fs.readFileSync('src/cli.js', 'utf8');
  const start = cli.indexOf(".command('seal-open <agent-id> <job-id>')");
  const end = cli.indexOf(".command('extend <buyer-agent-id> <job-id>')", start);
  assert.ok(start > 0 && end > start);
  const block = cli.slice(start, end);
  assert.match(block, /--out <dir>/);
  assert.match(block, /\.option\('--yes'/);
  const preview = block.indexOf('if (!options.yes)');
  const open = block.indexOf('openSealedPackage(');
  assert.ok(preview > 0 && open > preview);
  assert.equal(block.includes('.ivk'), false);
  assert.equal(/console\.log\([^)]*ivk/.test(block), false);
  assert.equal(/say\([^)]*ivk/.test(block), false);
});

test('package.json pins verus-typescript-primitives to the SDK commit', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(pkg.dependencies['verus-typescript-primitives'], PIN);
  assert.equal(fs.existsSync('package-lock.json'), false);
});
