'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CLI = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');

for (const ev of ['job.accepted', 'job.completed', 'job.delivered']) {
  test(`${ev} is emitted to the event bus`, () => {
    const re = new RegExp(`emitEvent\\?\\.\\(\\s*['"]${ev.replace('.', '\\.')}['"]`);
    assert.match(CLI, re, `no state.emitEvent for ${ev}`);
  });
}

test('job.delivered is not emitted inside the webhook case handler (no double with the generic emit)', () => {
  const start = CLI.indexOf("case 'job.delivered':");
  assert.ok(start > -1);
  const next = CLI.indexOf('case ', start + 20);
  const block = CLI.slice(start, next === -1 ? start + 1200 : next);
  assert.equal(/emitEvent/.test(block), false, 'case job.delivered still emits (double with generic path)');
});

test('job.accepted and job.delivered are emitted in the poll path (before handleWebhookEvent)', () => {
  const hwe = CLI.indexOf('async function handleWebhookEvent');
  assert.ok(hwe > -1);
  const pollPart = CLI.slice(0, hwe);
  assert.match(pollPart, /emitEvent\?\.\(\s*['"]job\.accepted['"]/, 'no poll-mode job.accepted emit');
  assert.match(pollPart, /emitEvent\?\.\(\s*['"]job\.delivered['"]/, 'no poll-mode job.delivered emit');
});
