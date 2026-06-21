const test = require('node:test');
const assert = require('node:assert/strict');
const { formatUpstreamHealthTag } = require('../src/tui/health-tag');
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('formatUpstreamHealthTag: null/undefined → empty string', () => {
  assert.equal(formatUpstreamHealthTag(null, 1000), '');
  assert.equal(formatUpstreamHealthTag(undefined, 1000), '');
});

test('formatUpstreamHealthTag: healthy shows age in seconds', () => {
  const out = plain(formatUpstreamHealthTag({ healthy: true, lastCheck: 1000 }, 5000));
  assert.match(out, /\[healthy 4s ago\]/);
});

test('formatUpstreamHealthTag: down with error', () => {
  const out = plain(formatUpstreamHealthTag({ healthy: false, error: 'ECONNREFUSED' }, 5000));
  assert.match(out, /\[DOWN — ECONNREFUSED\]/);
});

test('formatUpstreamHealthTag: down with no error falls back to status', () => {
  const out = plain(formatUpstreamHealthTag({ healthy: false, status: 503 }, 5000));
  assert.match(out, /\[DOWN — status 503\]/);
});

test('formatUpstreamHealthTag: healthy without lastCheck does not throw', () => {
  assert.doesNotThrow(() => formatUpstreamHealthTag({ healthy: true }, 5000));
  assert.match(plain(formatUpstreamHealthTag({ healthy: true }, 5000)), /\[healthy\]/);
});
