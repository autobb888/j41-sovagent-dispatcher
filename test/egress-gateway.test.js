'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { isolatedGatewayIp } = require('../src/egress-proxy.js');

test('isolatedGatewayIp falls back to 172.18.0.1 when inspect fails', () => {
  assert.equal(isolatedGatewayIp(() => { throw new Error('no docker'); }), '172.18.0.1');
});
test('isolatedGatewayIp parses the docker inspect output', () => {
  assert.equal(isolatedGatewayIp(() => '172.20.0.1\n'), '172.20.0.1');
});
