'use strict';

const crypto = require('crypto');

function mintDatasetToken({ buyer, jobId, hash, exp, secret }) {
  const payload = Buffer.from(JSON.stringify({
    buyer: String(buyer),
    jobId: String(jobId),
    hash: String(hash),
    exp: Number(exp),
  })).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

function readDatasetToken(token, secret) {
  const raw = String(token || '');
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expect = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!body || !body.buyer || !body.jobId || !body.hash || !body.exp) return null;
    return body;
  } catch {
    return null;
  }
}

module.exports = { mintDatasetToken, readDatasetToken };
