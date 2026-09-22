'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  assertDataSetupAllowed,
  parseDataSetupUrls,
  applyDataAgentConfig,
  buildDataVdxfFields,
  firstDataEndpoint,
  dataEndpointRefusal,
  planDataSetup,
  dataSetupNextLines,
} = require('../src/data-setup');

const CLI = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
const DASH = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');

function cliBlock(cmd) {
  const start = CLI.indexOf(`.command('${cmd}')`);
  assert.ok(start > 0, `missing ${cmd}`);
  const end = CLI.indexOf('\n  .command(', start + 1);
  return CLI.slice(start, end === -1 ? start + 8000 : end);
}

test('assertDataSetupAllowed refuses non-data kinds', () => {
  assert.throws(
    () => assertDataSetupAllowed({ kind: 'agent', identity: 'alice.agentplatform@' }),
    /DATA_SETUP_WRONG_KIND/,
  );
  assert.throws(
    () => assertDataSetupAllowed({ kind: 'model', identity: 'kimi.agentplatform@' }),
    /DATA_SETUP_WRONG_KIND/,
  );
  assert.doesNotThrow(() => assertDataSetupAllowed({ kind: 'data', identity: 'corpus.agentplatform@' }));
});

test('assertDataSetupAllowed refuses mixed api-endpoint / gpu-rental slots', () => {
  assert.throws(
    () => assertDataSetupAllowed({ kind: 'data', agentConfig: { apiEndpointUrl: 'http://127.0.0.1:11434/v1' } }),
    /DATA_SLOT_CONFLICT/,
  );
  assert.throws(
    () => assertDataSetupAllowed({ kind: 'data', agentConfig: { serviceType: 'gpu-rental' } }),
    /DATA_SLOT_CONFLICT/,
  );
});

test('parseDataSetupUrls requires HTTP(S) website and/or networkEndpoints', () => {
  assert.throws(() => parseDataSetupUrls({}), /DATA_SETUP_NO_ENDPOINT/);
  assert.throws(() => parseDataSetupUrls({ website: 'ftp://x' }), /DATA_SETUP_BAD_URL/);
  assert.throws(() => parseDataSetupUrls({ website: 'https://foo.trycloudflare.com' }), /DESCRIPTION_EPHEMERAL_URL/);
  const own = parseDataSetupUrls({
    website: 'https://foo.trycloudflare.com/j41/datasets/orchard-apples.json',
    allowHosts: ['foo.trycloudflare.com'],
  });
  assert.equal(own.website, 'https://foo.trycloudflare.com/j41/datasets/orchard-apples.json');
  assert.throws(() => parseDataSetupUrls({ website: 'http://127.0.0.1/data' }), /DESCRIPTION_EPHEMERAL_URL/);
  assert.throws(() => parseDataSetupUrls({ networkEndpoints: 'http://192.168.1.9/x' }), /DESCRIPTION_EPHEMERAL_URL/);
  assert.throws(() => parseDataSetupUrls({ website: 'http://169.254.169.254/latest' }), /DESCRIPTION_EPHEMERAL_URL/);
  assert.throws(() => parseDataSetupUrls({ website: 'http://[::1]/data' }), /DESCRIPTION_EPHEMERAL_URL/);
  assert.throws(() => parseDataSetupUrls({ website: 'http://127.0.0.2/data' }), /DESCRIPTION_EPHEMERAL_URL/);
  const ok = parseDataSetupUrls({ website: 'https://data.example/apples.json' });
  assert.equal(ok.website, 'https://data.example/apples.json');
  const both = parseDataSetupUrls({
    website: 'https://web.example',
    networkEndpoints: 'https://ep.example/a, https://ep.example/b',
  });
  assert.deepEqual(both.networkEndpoints, ['https://ep.example/a', 'https://ep.example/b']);
});

test('applyDataAgentConfig persists website + networkEndpoints without a labour serviceType', () => {
  const next = applyDataAgentConfig({ foo: 1 }, {
    website: 'https://data.example',
    networkEndpoints: ['https://ep.example'],
  });
  assert.equal(next.website, 'https://data.example');
  assert.deepEqual(next.networkEndpoints, ['https://ep.example']);
  assert.equal(next.foo, 1);
  assert.equal(next.serviceType, undefined);
  assert.equal(next.dataEndpointLocalOnly, true);
  const written = applyDataAgentConfig(next, { onChain: true });
  assert.equal(written.dataEndpointLocalOnly, undefined);
  assert.equal(written.website, 'https://data.example');
});

test('buildDataVdxfFields maps website → profileWebsite and JSON-stringifies endpoints', () => {
  const fields = buildDataVdxfFields({
    website: 'https://data.example',
    networkEndpoints: ['https://ep.example'],
    description: '10 apples JSON',
  });
  assert.equal(fields.profileWebsite, 'https://data.example');
  assert.equal(fields.networkEndpoints, JSON.stringify(['https://ep.example']));
  assert.equal(fields.description, '10 apples JSON');
});

test('planDataSetup refuses ephemeral description copy', () => {
  assert.throws(() => planDataSetup({
    keys: { kind: 'data', identity: 'pippin.agentplatform@' },
    website: 'https://data.example',
    description: 'https://dead.trycloudflare.com/apples.json',
  }), /DESCRIPTION_EPHEMERAL_URL/);
});

test('dataSetupNextLines is listings --kind data + browse, never start', () => {
  const lines = dataSetupNextLines('pippin.agentplatform@').join('\n');
  assert.match(lines, /listings --kind data/);
  assert.match(lines, /browse pippin\.agentplatform@/);
  assert.doesNotMatch(lines, /\bstart\b/);
});

test('--no-register Next says browse will not see the URL until on-chain write', () => {
  const lines = dataSetupNextLines('pippin.agentplatform@', { localOnly: true, agentId: 'data-1' }).join('\n');
  assert.match(lines, /data-setup data-1 --website/);
  assert.match(lines, /browse will not see this URL until/);
  assert.match(lines, /drop --no-register/);
  assert.doesNotMatch(lines, /listings --kind data/);
  assert.doesNotMatch(lines, /\bstart\b/);
});

test('firstDataEndpoint / dataEndpointRefusal fail closed on missing or ephemeral URLs', () => {
  assert.equal(firstDataEndpoint({}), null);
  assert.equal(dataEndpointRefusal({}).code, 'data.endpoint');
  assert.equal(firstDataEndpoint({ website: 'https://data.example' }), 'https://data.example');
  assert.equal(dataEndpointRefusal({ website: 'https://data.example' }), null);
  assert.equal(dataEndpointRefusal({ website: 'https://x.trycloudflare.com' }).code, 'data.endpoint');
  const localOnly = dataEndpointRefusal({ website: 'https://data.example', dataEndpointLocalOnly: true });
  assert.equal(localOnly.code, 'data.endpoint');
  assert.match(localOnly.message, /local-only|browse will not see/);
});

test('cli.js registers data-setup next to api-setup as a VDXF rind, not registerService', () => {
  const block = cliBlock('data-setup <agent-id>');
  assert.match(block, /--website/);
  assert.match(block, /--network-endpoints/);
  assert.match(block, /--no-register/);
  assert.match(block, /removeAndRewriteVdxfFields/);
  assert.match(block, /is not registered on-chain/);
  assert.match(block, /listings --kind data|dataSetupNextLines/);
  assert.match(block, /browse will not see this URL until/);
  assert.match(block, /localOnly:\s*true/);
  assert.match(block, /onChain:\s*true/);
  assert.doesNotMatch(block, /registerService/);
  assert.doesNotMatch(block, /j41-dispatcher start/);
  const apiStart = CLI.indexOf(".command('api-setup <agent-id>')");
  const dataStart = CLI.indexOf(".command('data-setup <agent-id>')");
  assert.ok(dataStart > apiStart, 'data-setup must sit next to api-setup');
});

test('setup complete Next is kind-aware', () => {
  const setupAt = CLI.indexOf(".command('setup <agent-id> <identity-name>')");
  const setup = CLI.slice(setupAt, CLI.indexOf(".command('providers')", setupAt));
  const summary = setup.slice(setup.indexOf('Setup Complete'));
  assert.match(summary, /doneKind === 'compute'/);
  assert.match(summary, /rental-setup \$\{agentId\}/);
  assert.match(summary, /doneKind === 'model'/);
  assert.match(summary, /api-setup \$\{agentId\}/);
  assert.match(summary, /start --webhook-url/);
  assert.match(summary, /doneKind === 'data'/);
  assert.match(summary, /data-setup \$\{agentId\} --website/);
  assert.match(summary, /Next: j41-dispatcher start/);
});

test('quickstart Next is kind-aware (data is data-setup, not start)', () => {
  const qAt = CLI.indexOf(".command('quickstart')");
  const q = CLI.slice(qAt, CLI.indexOf(".command('init')", qAt));
  assert.match(q, /kind === 'compute'/);
  assert.match(q, /rental-setup \$\{localId\}/);
  assert.match(q, /kind === 'model'/);
  assert.match(q, /api-setup \$\{localId\}/);
  assert.match(q, /start --webhook-url/);
  assert.match(q, /kind === 'data'/);
  assert.match(q, /data-setup \$\{localId\} --website/);
});

test('api-setup success Next is start --webhook-url and names poll-mode', () => {
  const api = cliBlock('api-setup <agent-id>');
  assert.match(api, /start --webhook-url \$\{publicUrl\}/);
  assert.match(api, /Poll mode \(bare start\) will not bind the proxy/);
});

test('listings data footer prints browse <seller>', () => {
  const listAt = CLI.indexOf(".command('listings')");
  const list = CLI.slice(listAt, CLI.indexOf(".command('pay", listAt));
  assert.match(list, /browse <seller>/);
});

test('TUI [2] Sign up Next: data → data-setup not [5]; model → [18] then webhook start', () => {
  const addAt = DASH.indexOf('async function addAgentScreen');
  const add = DASH.slice(addAt, DASH.indexOf('\nasync function ', addAt + 10));
  assert.match(add, /data-setup --website \(not \[5\] Configure Services\)/);
  assert.match(add, /\[18\] API Endpoint Setup, then start --webhook-url/);
  assert.match(add, /await dataSetupScreen\(inquirer, agentId\)/);
  assert.match(add, /apiEndpointSetupScreen/);
  assert.doesNotMatch(add, /Use \[5\] Configure Services to attach the data policy/);
  assert.match(add, /kind !== 'agent'/);
  assert.match(add, /--profile-name/);
});

test('setup / register / finalize strip labour services unless kind=agent', () => {
  assert.match(CLI, /labourServicesOrEmpty/);
  assert.match(CLI, /labourServicesAllowed\(keys && keys\.kind/);
  const setupAt = CLI.indexOf(".command('setup <agent-id> <identity-name>')");
  const setup = CLI.slice(setupAt, CLI.indexOf(".command('providers')", setupAt));
  assert.match(setup, /labourServicesOrEmpty\(keys\.kind \|\| options\.kind/);
  const api = cliBlock('api-setup <agent-id>');
  assert.match(api, /assertApiSetupKind/);
  assert.match(api, /API_SETUP_WRONG_KIND|assertApiSetupKind/);
});

test('TUI [5] diverts kind=data to data-setup and kind=model away from labour add', () => {
  const svcAt = DASH.indexOf('async function configureServicesScreen');
  const svc = DASH.slice(svcAt, DASH.indexOf('\nasync function ', svcAt + 10));
  assert.match(svc, /listingKindOf\(keys\) === 'data'/);
  assert.match(svc, /Labour services and API endpoints are refused/);
  assert.match(svc, /await dataSetupScreen\(inquirer, agentId\)/);
  assert.match(svc, /listingKindOf\(keys\) === 'model'/);
  assert.match(svc, /Labour "Add agent service" is refused/);
  assert.match(svc, /\[18\] API Endpoint Setup/);
});

test('TUI Hire prints filled browse for data and access/chat/deposit for model (no ECDH)', () => {
  const hireAt = DASH.indexOf('async function hireScreen');
  const hire = DASH.slice(hireAt, DASH.indexOf('\nasync function ', hireAt + 10));
  assert.match(hire, /const seller = r\.seller \|\| r\.qualifiedName/);
  assert.match(hire, /Browse: j41-dispatcher browse \$\{seller\}/);
  assert.match(hire, /Browse: j41-dispatcher browse \$\{sellerId\}/);
  assert.doesNotMatch(hire, /Browse: j41-dispatcher browse \$\{sellerName\}/);
  assert.match(hire, /access \$\{buyerId\} \$\{seller\}/);
  assert.match(hire, /deposit \$\{buyerId\} \$\{seller\} --amount/);
  assert.match(hire, /Print-argv only — no ECDH in TUI/);
  assert.doesNotMatch(hire, /requestApiAccess|openAccessEnvelope/);
});
