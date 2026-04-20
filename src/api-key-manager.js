/**
 * API Key Manager — mints, validates, revokes per-buyer API keys.
 * Keys stored in ~/.j41/dispatcher/agents/<id>/api-keys.json (0o600).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const AGENTS_DIR = path.join(os.homedir(), '.j41', 'dispatcher', 'agents');

function keysPath(agentId) {
  return path.join(AGENTS_DIR, agentId, 'api-keys.json');
}

function loadKeys(agentId) {
  const p = keysPath(agentId);
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return { keys: [] };
}

function saveKeys(agentId, data) {
  const p = keysPath(agentId);
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Mint a new API key for a buyer.
 * Format: sk-<6 hex chars>-<64 hex chars>
 */
function mintApiKey(agentId, buyerVerusId, expiresInMs = 30 * 24 * 60 * 60 * 1000) {
  const shortId = crypto.randomBytes(3).toString('hex');
  const secret = crypto.randomBytes(32).toString('hex');
  const key = `sk-${shortId}-${secret}`;

  const record = {
    key,
    buyerVerusId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    revoked: false,
    revokedAt: null,
    usage: { requests: 0, inputTokens: 0, outputTokens: 0 },
  };

  const data = loadKeys(agentId);
  data.keys.push(record);
  saveKeys(agentId, data);

  return record;
}

/**
 * Validate an API key. Returns the record if valid, null if not.
 */
function validateApiKey(agentId, key) {
  const data = loadKeys(agentId);
  const record = data.keys.find(k => k.key === key);
  if (!record) return null;
  if (record.revoked) return null;
  if (new Date(record.expiresAt) < new Date()) return null;
  return record;
}

/**
 * Find which agent owns a key (searches all agents).
 * Returns { agentId, record } or null.
 */
function findKeyOwner(key) {
  try {
    const agents = fs.readdirSync(AGENTS_DIR);
    for (const agentId of agents) {
      const record = validateApiKey(agentId, key);
      if (record) return { agentId, record };
    }
  } catch {}
  return null;
}

/**
 * Revoke a key.
 */
function revokeApiKey(agentId, key) {
  const data = loadKeys(agentId);
  const record = data.keys.find(k => k.key === key);
  if (!record) return false;
  record.revoked = true;
  record.revokedAt = new Date().toISOString();
  saveKeys(agentId, data);
  return true;
}

/**
 * List active (non-revoked, non-expired) keys for an agent.
 */
function listActiveKeys(agentId) {
  const data = loadKeys(agentId);
  const now = new Date();
  return data.keys.filter(k => !k.revoked && new Date(k.expiresAt) > now);
}

/**
 * Record usage on a key (increment counters).
 */
function recordUsage(agentId, key, inputTokens, outputTokens) {
  const data = loadKeys(agentId);
  const record = data.keys.find(k => k.key === key);
  if (!record) return;
  record.usage.requests++;
  record.usage.inputTokens += inputTokens;
  record.usage.outputTokens += outputTokens;
  saveKeys(agentId, data);
}

module.exports = { mintApiKey, validateApiKey, findKeyOwner, revokeApiKey, listActiveKeys, recordUsage };
