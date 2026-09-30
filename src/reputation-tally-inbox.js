'use strict';

const fs = require('fs');

// Dev-machine note from Task 1. i-addresses are read from it, not typed here.
const NOTE_PATH = '/home/bigbox/code/junction41/src/validation/vdxf-keys.tally-note.json';
const RECORD_ID = 'iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad';

const FORBIDDEN_FIELDS = [
  'buyer',
  'buyerVerusId',
  'zaddress',
  'address',
  'jobHash',
  'amount',
  'completedAt',
];

let cachedKeys = null;

function reputationTallyKeys() {
  if (cachedKeys) return cachedKeys;
  const note = JSON.parse(fs.readFileSync(NOTE_PATH, 'utf8'));
  const recordId = note && note.recordCheck && note.recordCheck.vdxfid;
  if (recordId !== RECORD_ID) {
    throw new Error('reputation tally note record id is not iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad');
  }
  const tally = note.tally && note.tally.vdxfid;
  const prose = note.prose && note.prose.vdxfid;
  if (typeof tally !== 'string' || tally.length === 0 || typeof prose !== 'string' || prose.length === 0) {
    throw new Error('reputation tally note is missing tally or prose');
  }
  cachedKeys = { tally, prose, recordId };
  return cachedKeys;
}

function readVdxfMap(item) {
  if (item && item.vdxfData != null && typeof item.vdxfData !== 'string') {
    if (typeof item.vdxfData !== 'object' || Array.isArray(item.vdxfData)) {
      throw new Error('reputation_tally vdxfData is not an object');
    }
    return item.vdxfData;
  }
  const raw = item && (item.vdxf_data != null ? item.vdxf_data : item.vdxfData);
  if (typeof raw === 'string') {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('reputation_tally vdxf_data is not an object');
    }
    return parsed;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  throw new Error('reputation_tally inbox item has no vdxf data');
}

function assertPublishable(hex, label) {
  const text = Buffer.from(hex, 'hex').toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`reputation_tally ${label} is not JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`reputation_tally ${label} is not an object`);
  }
  for (const field of FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(parsed, field)) {
      throw new Error(`reputation_tally ${label} carries forbidden field ${field}`);
    }
  }
}

function planReputationTallyAdditions(item, keys) {
  if (!keys || typeof keys.tally !== 'string' || keys.tally.length === 0) {
    throw new Error('reputation_tally keys.tally is required');
  }
  const data = readVdxfMap(item);
  const tallyHex = data[keys.tally];
  if (typeof tallyHex !== 'string' || tallyHex.length === 0) {
    throw new Error('reputation_tally inbox item is missing the tally hex');
  }
  assertPublishable(tallyHex, 'tally');
  const additions = { [keys.tally]: [tallyHex] };
  if (typeof keys.prose === 'string' && keys.prose.length > 0) {
    const proseHex = data[keys.prose];
    if (typeof proseHex === 'string' && proseHex.length > 0) {
      assertPublishable(proseHex, 'prose');
      additions[keys.prose] = [proseHex];
    }
  }
  return additions;
}

async function acceptReputationTallyItem(item, deps) {
  const additions = planReputationTallyAdditions(item, deps && deps.keys);
  if (deps && typeof deps.writeIdentityAdditions === 'function') {
    await deps.writeIdentityAdditions(additions);
    return { accepted: true };
  }
  throw new Error('reputation_tally write is not wired');
}

module.exports = {
  planReputationTallyAdditions,
  acceptReputationTallyItem,
  reputationTallyKeys,
};
