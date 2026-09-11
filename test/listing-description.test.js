'use strict';
/**
 * Data listing descriptions must not hold ephemeral tunnel / LAN URLs.
 * Live bytes go in website / networkEndpoints. "10 apples" is not an IP.
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  descriptionHasEphemeralUrl,
  isDataListing,
  refuseDataListingDescriptions,
} = require('../src/listing-description.js');

const CLI = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
const DASH = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');

test('descriptionHasEphemeralUrl allows "10 apples" and pippinapples copy', () => {
  assert.equal(descriptionHasEphemeralUrl('pippinapples — 10 apples JSON'), false);
  assert.equal(descriptionHasEphemeralUrl('10 apples'), false);
  assert.equal(descriptionHasEphemeralUrl('10.'), false);
  assert.equal(descriptionHasEphemeralUrl('Fetch 10. items as JSON'), false);
  assert.equal(descriptionHasEphemeralUrl(''), false);
  assert.equal(descriptionHasEphemeralUrl(null), false);
});

test('descriptionHasEphemeralUrl refuses trycloudflare, ngrok, localhost, RFC1918 dotted quads', () => {
  assert.equal(descriptionHasEphemeralUrl('trycloudflare.com'), true);
  assert.equal(descriptionHasEphemeralUrl('https://foo.trycloudflare.com/data.json'), true);
  assert.equal(descriptionHasEphemeralUrl('ngrok tunnel'), true);
  assert.equal(descriptionHasEphemeralUrl('http://localhost:8080'), true);
  assert.equal(descriptionHasEphemeralUrl('127.0.0.1'), true);
  assert.equal(descriptionHasEphemeralUrl('10.0.0.1'), true);
  assert.equal(descriptionHasEphemeralUrl('192.168.1.1'), true);
  assert.equal(descriptionHasEphemeralUrl('172.16.0.1'), true);
  assert.equal(descriptionHasEphemeralUrl('172.31.255.255'), true);
});

test('descriptionHasEphemeralUrl does not treat nearby public / non-RFC1918 as LAN', () => {
  assert.equal(descriptionHasEphemeralUrl('11.0.0.1'), false);
  assert.equal(descriptionHasEphemeralUrl('172.15.0.1'), false);
  assert.equal(descriptionHasEphemeralUrl('172.32.0.1'), false);
  assert.equal(descriptionHasEphemeralUrl('192.169.1.1'), false);
});

test('isDataListing is kind=data or parent sovdata@', () => {
  assert.equal(isDataListing('data', 'pippinapples.agentplatform@'), true);
  assert.equal(isDataListing('agent', 'corpus.sovdata@'), true);
  assert.equal(isDataListing('agent', 'alice.agentplatform@'), false);
  assert.equal(isDataListing('model', 'kimi.agentplatform@'), false);
});

test('refuseDataListingDescriptions returns DESCRIPTION_EPHEMERAL_URL only for data + ephemeral text', () => {
  const ok = refuseDataListingDescriptions({
    kind: 'data',
    identity: 'pippinapples.agentplatform@',
    descriptions: ['pippinapples — 10 apples JSON'],
  });
  assert.equal(ok, null);

  const bad = refuseDataListingDescriptions({
    kind: 'data',
    identity: 'pippinapples.agentplatform@',
    descriptions: ['https://dead.trycloudflare.com/apples.json'],
  });
  assert.ok(bad);
  assert.equal(bad.code, 'DESCRIPTION_EPHEMERAL_URL');
  assert.match(bad.message, /DESCRIPTION_EPHEMERAL_URL/);
  assert.match(bad.message, /profile-website|network-endpoints/);

  const labour = refuseDataListingDescriptions({
    kind: 'agent',
    identity: 'alice.agentplatform@',
    descriptions: ['https://foo.trycloudflare.com'],
  });
  assert.equal(labour, null, 'labour listings may still describe a URL; this gate is data-only');
});

test('register/setup/finalize/update-profile call the data-description gate', () => {
  const registerAt = CLI.indexOf(".command('register <agent-id>");
  const register = CLI.slice(registerAt, CLI.indexOf(".command('finalize <agent-id>"));
  const finalize = CLI.slice(CLI.indexOf(".command('finalize <agent-id>"), CLI.indexOf(".command('recover <agent-id>"));
  const setupAt = CLI.indexOf(".command('setup <agent-id>");
  const setup = CLI.slice(setupAt, CLI.indexOf(".command('start')", setupAt));
  const update = CLI.slice(CLI.indexOf(".command('update-profile <agent-id>"), CLI.indexOf(".command('inspect <agent-id>"));

  for (const [name, body] of [['register', register], ['finalize', finalize], ['setup', setup], ['update-profile', update]]) {
    assert.match(body, /assertDataDescriptions|refuseDataListingDescriptions/, `${name} must refuse ephemeral URLs in data descriptions`);
  }
});

test('setup post-profile gate prefers stored keys.kind over commander --kind default', () => {
  const setupAt = CLI.indexOf(".command('setup <agent-id>");
  const setup = CLI.slice(setupAt, CLI.indexOf(".command('start')", setupAt));
  const postProfile = setup.slice(setup.indexOf('Step 3/4'));
  assert.match(postProfile, /assertDataDescriptions\(keys\.kind\s*\|\|\s*options\.kind/,
    're-running setup on a data listing without --kind data must still refuse DESCRIPTION_EPHEMERAL_URL');
  assert.equal(/assertDataDescriptions\(options\.kind\s*\|\|\s*keys\.kind/.test(postProfile), false,
    'options.kind defaults to agent, so stored kind must come first');
});

test('TUI Configure Services refuses ephemeral URLs on data listings', () => {
  const screen = DASH.slice(DASH.indexOf('async function configureServicesScreen'), DASH.indexOf('async function bountiesMenuScreen'));
  assert.match(screen, /descriptionHasEphemeralUrl|refuseDataListingDescriptions/);
  assert.match(screen, /DESCRIPTION_EPHEMERAL_URL/);
});
