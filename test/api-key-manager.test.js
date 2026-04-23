const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point api-key-manager at a temp HOME before loading it
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-api-key-test-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;

const { mintApiKey, validateApiKey, findKeyOwner, revokeApiKey, listActiveKeys, recordUsage } =
  require('../src/api-key-manager');

const AGENT = 'agent-test-1';
const BUYER = 'iBuyer123';

test('mintApiKey returns sk-<6>-<64> format and persists', () => {
  const record = mintApiKey(AGENT, BUYER);
  assert.match(record.key, /^sk-[0-9a-f]{6}-[0-9a-f]{64}$/);
  assert.equal(record.buyerVerusId, BUYER);
  assert.equal(record.revoked, false);

  const file = path.join(TEST_HOME, '.j41', 'dispatcher', 'agents', AGENT, 'api-keys.json');
  assert.ok(fs.existsSync(file));
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, 'api-keys.json must be 0600');
});

test('validateApiKey accepts fresh key, rejects garbage', () => {
  const record = mintApiKey(AGENT, BUYER);
  assert.ok(validateApiKey(AGENT, record.key));
  assert.equal(validateApiKey(AGENT, 'sk-nope-nope'), null);
});

test('validateApiKey rejects expired key', () => {
  const record = mintApiKey(AGENT, BUYER, -1000); // already expired
  assert.equal(validateApiKey(AGENT, record.key), null);
});

test('revokeApiKey flips revoked flag; subsequent validate returns null', () => {
  const record = mintApiKey(AGENT, BUYER);
  revokeApiKey(AGENT, record.key);
  assert.equal(validateApiKey(AGENT, record.key), null);
});

test('findKeyOwner resolves agentId from key without knowing agentId up front', () => {
  const record = mintApiKey(AGENT, BUYER);
  const owner = findKeyOwner(record.key);
  assert.ok(owner, 'owner should be found');
  assert.equal(owner.agentId, AGENT);
  assert.equal(owner.record.key, record.key);
});

test('findKeyOwner returns null for unknown key', () => {
  assert.equal(findKeyOwner('sk-aaaaaa-' + 'b'.repeat(64)), null);
});

test('listActiveKeys excludes revoked and expired entries', () => {
  const active = mintApiKey(AGENT, BUYER);
  const expired = mintApiKey(AGENT, BUYER, -1000);
  const revoked = mintApiKey(AGENT, BUYER);
  revokeApiKey(AGENT, revoked.key);

  const keys = listActiveKeys(AGENT).map(k => k.key);
  assert.ok(keys.includes(active.key));
  assert.ok(!keys.includes(expired.key));
  assert.ok(!keys.includes(revoked.key));
});

test('recordUsage increments counters', () => {
  const record = mintApiKey(AGENT, BUYER);
  recordUsage(AGENT, record.key, 100, 50);
  recordUsage(AGENT, record.key, 200, 25);
  const after = validateApiKey(AGENT, record.key);
  assert.equal(after.usage.requests, 2);
  assert.equal(after.usage.inputTokens, 300);
  assert.equal(after.usage.outputTokens, 75);
});
