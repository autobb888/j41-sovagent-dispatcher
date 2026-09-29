'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { publishIdentityZAddress } = require('../src/z-address-run');
const { accountFile, readStoredAccount } = require('../src/shield-live');

const HEX = 'ab'.repeat(43);

function tempAgents() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'j41-zaddr-'));
}

test('without yes a missing account is a preview and does not post', async () => {
  const agentsDir = tempAgents();
  let posted = 0;
  let derived = 0;
  const result = await publishIdentityZAddress({
    agentsDir,
    agentId: 'buyer-1',
    yes: false,
    derive: async () => { derived += 1; return { addressHex: HEX }; },
    post: async () => { posted += 1; },
  });
  assert.deepEqual(result, { ok: true, code: 'Z_ADDRESS_PREVIEW', posted: false, addressHex: null });
  assert.equal(posted, 0);
  assert.equal(derived, 0);
  assert.equal(fs.existsSync(accountFile(agentsDir, 'buyer-1')), false);
  assert.equal('seedHex' in result, false);
  fs.rmSync(agentsDir, { recursive: true, force: true });
});

test('yes creates a mode 0600 account and posts only the address', async () => {
  const agentsDir = tempAgents();
  const seen = [];
  const bodies = [];
  const result = await publishIdentityZAddress({
    agentsDir,
    agentId: 'buyer-1',
    yes: true,
    birthdayHeight: 12,
    derive: async (seedHex) => {
      seen.push(seedHex);
      return { addressHex: HEX };
    },
    post: async (body) => { bodies.push(body); },
  });
  const file = accountFile(agentsDir, 'buyer-1');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const stored = readStoredAccount(file);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], stored.seedHex);
  assert.match(stored.seedHex, /^[0-9a-f]{128}$/);
  assert.equal(stored.birthdayHeight, 12);
  assert.deepEqual(bodies, [{ addressHex: HEX }]);
  assert.equal(Object.keys(bodies[0]).join(','), 'addressHex');
  assert.equal(result.ok, true);
  assert.equal(result.posted, true);
  assert.equal(result.addressHex, HEX);
  assert.equal('seedHex' in result, false);
  assert.equal('extskHex' in result, false);
  assert.equal('dfvkHex' in result, false);
  fs.rmSync(agentsDir, { recursive: true, force: true });
});

test('a second yes does not replace the seed', async () => {
  const agentsDir = tempAgents();
  const derive = async () => ({ addressHex: HEX });
  const post = async () => ({ data: { stored: true } });
  await publishIdentityZAddress({ agentsDir, agentId: 'buyer-1', yes: true, derive, post, birthdayHeight: 4 });
  const file = accountFile(agentsDir, 'buyer-1');
  const seed = JSON.parse(fs.readFileSync(file, 'utf8')).seedHex;
  const again = await publishIdentityZAddress({
    agentsDir,
    agentId: 'buyer-1',
    yes: true,
    derive,
    post,
    birthdayHeight: 99,
  });
  assert.equal(again.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).seedHex, seed);
  assert.equal(readStoredAccount(file).birthdayHeight, 4);
  assert.equal('seedHex' in again, false);
  fs.rmSync(agentsDir, { recursive: true, force: true });
});

test('derive returning extskHex throws before post', async () => {
  const agentsDir = tempAgents();
  const bodies = [];
  await assert.rejects(
    () => publishIdentityZAddress({
      agentsDir,
      agentId: 'buyer-1',
      yes: true,
      derive: async () => ({ addressHex: HEX, extskHex: 'cd'.repeat(32) }),
      post: async (body) => { bodies.push(body); },
    }),
    (error) => {
      assert.match(String(error && error.message), /key/);
      return true;
    },
  );
  assert.equal(bodies.length, 0);
  fs.rmSync(agentsDir, { recursive: true, force: true });
});
