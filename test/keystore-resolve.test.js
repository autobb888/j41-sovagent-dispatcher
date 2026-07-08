'use strict';

const test = require('node:test');
const assert = require('node:assert');
const ks = require('../src/keystore.js');

test('resolvePassphrase returns the env passphrase without prompting', async () => {
  const v = await ks.resolvePassphrase({ env: { J41_KEYS_PASSPHRASE: 'envpass' }, promptFn: () => { throw new Error('should not prompt'); } });
  assert.equal(v, 'envpass');
});

test('resolvePassphrase throws ENOPASS when no source and no TTY prompt', async () => {
  await assert.rejects(
    ks.resolvePassphrase({ env: {}, promptFn: undefined }),
    (e) => e.code === 'ENOPASS',
  );
});
