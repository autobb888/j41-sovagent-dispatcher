'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { rentalAccessView, rentalAccessPrintLines } = require('../src/ssh-host');

test('rental-access prints host, port, and user and writes the key only with --yes', () => {
  const cli = fs.readFileSync('src/cli.js', 'utf8');
  const start = cli.indexOf(".command('rental-access <buyer-agent-id> <job-id>')");
  const end = cli.indexOf(".command('complete <buyer-agent-id> <job-id>')", start);
  assert.ok(start > 0 && end > start);
  const block = cli.slice(start, end);
  assert.match(block, /--out <file>/);
  assert.match(block, /getRentalAccess\(jobId\)/);
  assert.equal(/\$\{[^}]*privateKey/.test(block), false);
  assert.equal(/console\.log\([^)\n]*privateKey/.test(block), false);
  assert.equal(/say\([^)\n]*privateKey/.test(block), false);
  const preview = block.indexOf('if (!options.yes)');
  const write = block.indexOf('fs.writeFileSync(options.out, view.privateKey');
  assert.ok(preview > 0 && write > preview);
});

test('print lines never include the private key', () => {
  const view = rentalAccessView({
    data: { ssh: { host: '203.0.113.10', port: 22, user: 'renter', privateKey: 'SECRETKEYMATERIAL' } },
  });
  assert.equal(view.host, '203.0.113.10');
  assert.equal(view.port, 22);
  assert.equal(view.user, 'renter');
  assert.equal(view.privateKey, 'SECRETKEYMATERIAL');
  const lines = rentalAccessPrintLines(view);
  assert.deepEqual(lines, ['Host: 203.0.113.10', 'Port: 22', 'User: renter']);
  assert.equal(lines.join('\n').includes('SECRETKEYMATERIAL'), false);
  const src = fs.readFileSync('src/ssh-host.js', 'utf8');
  const fn = src.slice(src.indexOf('function rentalAccessPrintLines'), src.indexOf('function rentalSshFromAccess'));
  assert.equal(fn.includes('privateKey'), false);
});
