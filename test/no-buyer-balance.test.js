'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const NAMES = ['credit-meter', 'deposit-watcher', 'buyer-deposit', 'deposit-credit'];

test('production source does not require the buyer-balance rail', () => {
  const root = path.join(__dirname, '../src');
  const files = walk(root);
  assert.ok(files.some((f) => f.endsWith(`${path.sep}cli.js`)));
  assert.ok(files.some((f) => f.endsWith(`${path.sep}dashboard.js`)));
  assert.ok(files.some((f) => f.endsWith(`${path.sep}control.js`)));
  assert.ok(files.some((f) => f.endsWith(`${path.sep}webhook-server.js`)));
  assert.ok(files.some((f) => f.endsWith(`${path.sep}proxy-handler.js`)));
  assert.ok(files.some((f) => f.endsWith(`${path.sep}buyer-proxy-url.js`)));
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const name of NAMES) {
      assert.equal(text.includes(`require('./${name}`), false, `${file} requires ${name}`);
      assert.equal(text.includes(`require("./${name}`), false, `${file} requires ${name}`);
    }
  }
  const api = fs.readFileSync(path.join(root, 'control-api.js'), 'utf8');
  assert.doesNotMatch(api, /\/v1\/deposits/);
  const cli = fs.readFileSync(path.join(root, 'cli.js'), 'utf8');
  assert.doesNotMatch(cli, /\.command\(['`]deposit /);
  assert.doesNotMatch(cli, /\.command\(['`]report-deposit/);
  assert.doesNotMatch(cli, /\.command\(['`]deposits/);
  const webhook = fs.readFileSync(path.join(root, 'webhook-server.js'), 'utf8');
  assert.doesNotMatch(webhook, /\/j41\/deposit\/report/);
  const urls = fs.readFileSync(path.join(root, 'buyer-proxy-url.js'), 'utf8');
  assert.doesNotMatch(urls, /depositReportUrl/);
});
