'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  resolveBrowseUrl,
  joinBrowsePath,
  browseListing,
  browseSeller,
} = require('../src/buyer-browse');
const { assertHireAllowed } = require('../src/hire');

const DEAD_TUNNEL = 'https://dead.trycloudflare.com/apples';
const DESC = `${DEAD_TUNNEL} — 10 apples JSON`;

test('resolveBrowseUrl never uses description (trycloudflare or "10 apples")', () => {
  assert.equal(resolveBrowseUrl({ description: DESC }), null);
  assert.equal(resolveBrowseUrl({
    description: DESC,
    profile: { description: 'https://also-dead.trycloudflare.com' },
  }), null);
  assert.equal(
    resolveBrowseUrl({ website: 'https://data.example', description: DESC }),
    'https://data.example',
  );
});

test('resolveBrowseUrl order is networkEndpoints[0], website, typed endpoints[].url', () => {
  assert.equal(
    resolveBrowseUrl({
      networkEndpoints: ['https://ep.example/'],
      website: 'https://web.example',
      endpoints: [{ url: 'https://typed.example/' }],
      description: DESC,
    }),
    'https://ep.example/',
  );
  assert.equal(
    resolveBrowseUrl({
      website: 'https://web.example',
      endpoints: [{ url: 'https://typed.example/' }],
      description: DESC,
    }),
    'https://web.example',
  );
  assert.equal(
    resolveBrowseUrl({
      endpoints: [
        { url: 'ssh://gpu.example', protocol: 'ssh' },
        { url: 'https://typed.example/' },
      ],
      description: DESC,
    }),
    'https://typed.example/',
  );
  assert.equal(
    resolveBrowseUrl({
      profile: { network: { endpoints: ['https://vdxf.example'] }, profile: { website: 'https://nested.example' } },
    }),
    'https://vdxf.example',
  );
  assert.equal(
    resolveBrowseUrl({ profile: { website: 'https://nested-web.example' } }),
    'https://nested-web.example',
  );
});

test('joinBrowsePath appends --path only when the URL has no path', () => {
  assert.equal(joinBrowsePath('https://data.example', '/apples'), 'https://data.example/apples');
  assert.equal(joinBrowsePath('https://data.example/', '/apples'), 'https://data.example/apples');
  assert.equal(joinBrowsePath('https://data.example/apples', '/oranges'), 'https://data.example/apples');
  assert.equal(joinBrowsePath('https://data.example', 'apples'), 'https://data.example/apples');
  assert.equal(joinBrowsePath('https://data.example/apples', null), 'https://data.example/apples');
});

test('description-only trycloudflare is not fetched; BROWSE_NO_ENDPOINT', async () => {
  let fetched = 0;
  const r = await browseListing({
    listing: { description: DESC, kind: 'data' },
    path: '/apples',
    fetchImpl: async () => { fetched += 1; return { ok: true, status: 200, text: async () => 'nope' }; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BROWSE_NO_ENDPOINT');
  assert.equal(fetched, 0);
});

test('website /apples is GET; "10 apples" in description does not affect the URL', async () => {
  const urls = [];
  const r = await browseListing({
    listing: {
      website: 'https://data.example',
      description: DESC,
    },
    path: '/apples',
    fetchImpl: async (url) => {
      urls.push(String(url));
      return { ok: true, status: 200, text: async () => '{"apples":10}' };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://data.example/apples');
  assert.equal(r.body, '{"apples":10}');
  assert.equal(r.status, 200);
  assert.deepEqual(urls, ['https://data.example/apples']);
  assert.ok(!urls.some((u) => /trycloudflare/i.test(u)));
});

test('networkEndpoints[0] wins over website; path is not joined onto an existing path', async () => {
  const urls = [];
  const r = await browseListing({
    listing: {
      networkEndpoints: ['https://ep.example/apples'],
      website: 'https://web.example',
      description: DESC,
    },
    path: '/oranges',
    fetchImpl: async (url) => {
      urls.push(String(url));
      return { ok: true, status: 200, text: async () => 'ok' };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://ep.example/apples');
  assert.deepEqual(urls, ['https://ep.example/apples']);
});

test('HTTP non-2xx is BROWSE_HTTP_<status>', async () => {
  const r = await browseListing({
    listing: { website: 'https://data.example/apples' },
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => 'missing' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BROWSE_HTTP_404');
});

test('browseSeller fetches listing then GETs website, never description trycloudflare', async () => {
  const urls = [];
  const r = await browseSeller({
    seller: 'pippinapples.agentplatform@',
    path: '/apples',
    apiUrl: 'https://api.example',
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).includes('/v1/agents/')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              website: 'https://data.example',
              description: DESC,
            },
          }),
        };
      }
      return { ok: true, status: 200, text: async () => '{"apples":10}' };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://data.example/apples');
  assert.equal(r.body, '{"apples":10}');
  assert.ok(urls.some((u) => u.includes('/v1/agents/')));
  assert.ok(!urls.some((u) => /trycloudflare/i.test(u)));
});

test('browseSeller refuses labour/model/compute listings', async () => {
  for (const kind of ['agent', 'model', 'compute']) {
    const r = await browseSeller({
      listing: { kind, website: 'https://not-data.example' },
      fetchImpl: async () => { throw new Error('must not GET'); },
    });
    assert.equal(r.ok, false, kind);
    assert.equal(r.code, 'BROWSE_NOT_DATA', kind);
  }
});

test('DATA_NOT_HIREABLE is unchanged', () => {
  const data = assertHireAllowed({ sellerKind: 'data', serviceType: 'agent', serviceId: 's1' });
  assert.equal(data.ok, false);
  assert.equal(data.code, 'DATA_NOT_HIREABLE');
});

test('CLI registers browse <seller> --path --json and does not GET description', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const start = cli.indexOf(".command('browse <seller>')");
  assert.ok(start > -1, 'browse command must exist');
  const end = cli.indexOf(".command('", start + 10);
  const block = cli.slice(start, end > start ? end : start + 2000);
  assert.match(block, /--path/);
  assert.match(block, /--json/);
  assert.match(block, /buyer-browse/);
  assert.doesNotMatch(block, /listing\.description/);
});
