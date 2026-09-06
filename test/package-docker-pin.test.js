'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const pkg = require(path.join(__dirname, '..', 'package.docker.json'));

test('package.docker.json pins json-canonicalize 2.0.0 three ways', () => {
  assert.equal(pkg.dependencies['json-canonicalize'], '2.0.0');
  assert.equal(pkg.resolutions['json-canonicalize'], '2.0.0');
  assert.equal(pkg.overrides['json-canonicalize'], '2.0.0');
});

test('package.docker.json leaves docker SDK at 2.14.1', () => {
  assert.equal(pkg.dependencies['@junction41/sovagent-sdk'], '2.14.1');
});
