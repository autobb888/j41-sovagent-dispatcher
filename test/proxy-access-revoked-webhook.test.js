'use strict';
/**
 * H7 — platform `proxy.access_revoked` must actually revoke the dispatcher-minted
 * proxy key. J41 emits this on the seller's registered /webhook/:agentId URL
 * (DELETE /v1/me/api-access/:grantId). The dedicated POST /j41/api-access/revoke
 * route is never called from J41, so a silent default: in handleWebhookEvent
 * left keys live after the buyer revoked.
 *
 * Two properties:
 *   1. The switch arm exists and delegates to onApiAccessRevoke (source-level,
 *      same pattern as review-webhook-batching.test.js).
 *   2. The handler actually calls it with seller + buyer from the webhook
 *      payload / agentInfo (behavioral).
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const CLI = fs.readFileSync(require.resolve('../src/cli.js'), 'utf8');
const { handleWebhookEvent } = require('../src/cli.js');

function revokeCase() {
  const start = CLI.indexOf("case 'proxy.access_revoked'");
  assert.ok(start > -1, "the proxy.access_revoked case must exist");
  const end = CLI.indexOf("case '", start + 30);
  return CLI.slice(start, end === -1 ? start + 1500 : end);
}

test('proxy.access_revoked delegates to onApiAccessRevoke, not a silent default', () => {
  const block = revokeCase();
  assert.match(block, /onApiAccessRevoke/,
    'without this call the minted proxy key stays live after buyer revoke');
  assert.match(block, /buyerVerusId/,
    'the platform payload names the buyer, not an apiKey');
});

test('handleWebhookEvent calls onApiAccessRevoke with seller + buyer', async () => {
  const calls = [];
  const state = {
    agents: [{ id: 'agent-1', iAddress: 'iSELLER', identity: 'seller.sovcompute@' }],
    emitEvent() {},
    proxyContext: {
      onApiAccessRevoke: async (p) => { calls.push(p); return { revoked: 2 }; },
    },
  };
  await handleWebhookEvent(state, 'agent-1', {
    event: 'proxy.access_revoked',
    data: { grantId: 'g1', buyerVerusId: 'iBUYER', reason: 'buyer_initiated' },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sellerVerusId, 'iSELLER');
  assert.equal(calls[0].buyerVerusId, 'iBUYER');
  assert.equal(calls[0].apiKey, undefined);
});

test('handleWebhookEvent no-ops without proxyContext instead of throwing', async () => {
  const state = {
    agents: [{ id: 'agent-1', iAddress: 'iSELLER', identity: 'seller@' }],
    emitEvent() {},
  };
  await handleWebhookEvent(state, 'agent-1', {
    event: 'proxy.access_revoked',
    data: { buyerVerusId: 'iBUYER' },
  });
});

test('handleWebhookEvent ignores revoke events missing buyerVerusId', async () => {
  const calls = [];
  const state = {
    agents: [{ id: 'agent-1', iAddress: 'iSELLER', identity: 'seller@' }],
    emitEvent() {},
    proxyContext: {
      onApiAccessRevoke: async (p) => { calls.push(p); return { revoked: 1 }; },
    },
  };
  await handleWebhookEvent(state, 'agent-1', {
    event: 'proxy.access_revoked',
    data: { grantId: 'g1', reason: 'buyer_initiated' },
  });
  assert.equal(calls.length, 0);
});
