'use strict';
const { runProviderContract } = require('./support/provider-contract');
const { FakeProvider } = require('./support/fake-provider');

runProviderContract({ name: 'fake', makeProvider: () => new FakeProvider({ id: 'fake:1' }), spec: {} });
