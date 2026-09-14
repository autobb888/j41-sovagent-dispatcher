'use strict';
/**
 * F6 — setup --template must merge markup, workspaceCapability, and session
 * duration (seconds, not minutes) into the profile. CLI flags still win.
 * HOME is a tmp dir — never the real ~/.j41.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-tpl-'));
process.env.HOME = TMP_HOME;

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeTemplateIntoOptions, buildFullProfile } = require('../src/cli.js');

test.after(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

const CODE_REVIEW = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'templates', 'code-review', 'config.json'),
  'utf8',
));

test('setup --template code-review profile includes markup: 5 and workspaceCapability', () => {
  const options = mergeTemplateIntoOptions(CODE_REVIEW, {});
  const profile = buildFullProfile(options, {});
  assert.equal(profile.markup, 5);
  assert.ok(profile.workspaceCapability);
  assert.equal(profile.workspaceCapability.workspace, true);
  assert.deepEqual(profile.workspaceCapability.modes, ['supervised', 'standard']);
  assert.deepEqual(profile.workspaceCapability.tools, ['read_file', 'write_file', 'list_directory']);
  assert.equal(options.workspace, true);
  assert.equal(options.workspaceCapability, undefined);
});

test('template session.duration is seconds with no * 60', () => {
  const options = mergeTemplateIntoOptions({
    profile: { session: { duration: 7200 } },
  }, {});
  assert.equal(options.sessionDuration, 7200);
  const profile = buildFullProfile(options, {});
  assert.equal(profile.session.duration, 7200);
});

test('template session tokenLimit and messageLimit merge into options', () => {
  const options = mergeTemplateIntoOptions({
    profile: { session: { duration: 7200, tokenLimit: 200000, messageLimit: 100 } },
  }, {});
  assert.equal(options.sessionTokenLimit, 200000);
  assert.equal(options.sessionMessageLimit, 100);
  const profile = buildFullProfile(options, {});
  assert.equal(profile.session.tokenLimit, 200000);
  assert.equal(profile.session.messageLimit, 100);
});

test('CLI flags win over template markup and session duration', () => {
  const options = mergeTemplateIntoOptions(CODE_REVIEW, {
    markup: 10,
    sessionDuration: 3600,
    sessionTokenLimit: 1,
    sessionMessageLimit: 2,
  });
  assert.equal(options.markup, 10);
  assert.equal(options.sessionDuration, 3600);
  assert.equal(options.sessionTokenLimit, 1);
  assert.equal(options.sessionMessageLimit, 2);
  const profile = buildFullProfile(options, {});
  assert.equal(profile.markup, 10);
});

test('CLI --session-duration minutes coerce * 60 to seconds', () => {
  const cli = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
  assert.match(cli, /function parseSessionMinutes\(/);
  assert.match(cli, /parseInt\(v, 10\);/);
  assert.match(cli, /n \* 60/);
  assert.equal((cli.match(/parseSessionMinutes/g) || []).length >= 4, true, 'helper + three --session-duration flags');
  const setup = cli.slice(cli.indexOf(".command('setup <agent-id>"), cli.indexOf(".command('start')", cli.indexOf(".command('setup <agent-id>")));
  assert.match(setup, /--session-duration <min>.*parseSessionMinutes/);
});

test('workspace-reviewer profile.workspace maps to options.workspace, not workspaceCapability', () => {
  const tpl = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'templates', 'workspace-reviewer', 'config.json'),
    'utf8',
  ));
  const options = mergeTemplateIntoOptions(tpl, {});
  assert.equal(options.workspace, true);
  assert.equal(options.workspaceCapability, undefined);
  const profile = buildFullProfile(options, {});
  assert.ok(profile.workspaceCapability);
  assert.equal(profile.workspaceCapability.workspace, true);
});

test('interactive onboarding still converts minutes to seconds', () => {
  const cli = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
  const io = cli.slice(cli.indexOf('async function interactiveOnboarding('), cli.indexOf('function saveProfile('));
  assert.match(io, /Max session duration \(minutes\)/);
  assert.match(io, /parseInt\(sessionDuration\) \* 60/);
  const merge = cli.slice(cli.indexOf('function mergeTemplateIntoOptions('), cli.indexOf('function parseSessionMinutes('));
  assert.match(merge, /options\.sessionDuration = sess\.duration/);
  assert.doesNotMatch(merge, /sess\.duration \* 60/);
});
