'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ALIAS = path.join(ROOT, 'packages', 'j41-dispatcher-alias');
const scoped = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const alias = JSON.parse(fs.readFileSync(path.join(ALIAS, 'package.json'), 'utf8'));

test('alias package is named j41-dispatcher and pins the same version as scoped', () => {
  assert.equal(scoped.name, '@junction41/dispatcher');
  assert.equal(alias.name, 'j41-dispatcher');
  assert.equal(alias.version, scoped.version);
  assert.equal(alias.dependencies['@junction41/dispatcher'], scoped.version);
});

test('alias bin and postinstall files exist', () => {
  assert.ok(fs.existsSync(path.join(ALIAS, 'bin', 'j41-dispatcher.js')));
  assert.ok(fs.existsSync(path.join(ALIAS, 'bin', 'postinstall.js')));
  const bin = fs.readFileSync(path.join(ALIAS, 'bin', 'j41-dispatcher.js'), 'utf8');
  assert.match(bin, /@junction41\/dispatcher\/src\/cli\.js/);
});
