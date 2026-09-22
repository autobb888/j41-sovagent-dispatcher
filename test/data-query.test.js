'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { planDataQuery, runDataQuery } = require('../src/data-query');

const APPLES = {
  dataset: 'orchardapples',
  query: { q: '', color: '', kind: '' },
  count: 4,
  items: [
    { kind: 'Red Delicious', color: 'red', taste: 'sweet' },
    { kind: 'Granny Smith', color: 'green', taste: 'tart' },
    { kind: 'Fuji', color: 'red', taste: 'sweet' },
    { kind: 'Pink Lady', color: 'pink', taste: 'tart' },
  ],
};

test('equality filters the apples items and is sent to the seller URL', () => {
  const plan = planDataQuery({ where: ['color=red', 'taste=sweet'], select: 'kind,taste', limit: 20 });
  assert.equal(plan.ok, true);
  const params = new URLSearchParams(plan.serverQuery);
  assert.equal(params.get('color'), 'red');
  assert.equal(params.get('taste'), 'sweet');
  assert.equal(params.get('limit'), '20');
  assert.equal(params.get('offset'), null);
  const result = runDataQuery({ body: JSON.stringify(APPLES), ...plan });
  assert.equal(result.scanned, 4);
  assert.equal(result.matched, 2);
  assert.deepEqual(result.rows, [
    { kind: 'Red Delicious', taste: 'sweet' },
    { kind: 'Fuji', taste: 'sweet' },
  ]);
});

test('a comparison stays local and does not ask the server for a page', () => {
  const plan = planDataQuery({ where: ['kind>=Fuji'], q: 'tart' });
  assert.equal(plan.ok, true);
  const params = new URLSearchParams(plan.serverQuery);
  assert.equal(params.get('q'), 'tart');
  assert.equal(params.get('kind'), null);
  assert.equal(params.get('limit'), null);
  const result = runDataQuery({ body: JSON.stringify(APPLES), ...plan });
  assert.deepEqual(result.rows.map((row) => row.kind), ['Granny Smith', 'Pink Lady']);
});

test('contains, sort, and offset page the rows', () => {
  const plan = planDataQuery({ where: ['color~=red'], sort: '-kind', limit: 1, offset: 1 });
  const result = runDataQuery({ body: JSON.stringify(APPLES), ...plan });
  assert.equal(result.matched, 2);
  assert.equal(result.returned, 1);
  assert.equal(result.rows[0].kind, 'Fuji');
});

test('a top-level array is a collection, and a non-JSON body is refused', () => {
  const rows = runDataQuery({
    body: JSON.stringify([{ id: 1 }, { id: 2 }]),
    where: [],
    q: '',
    select: null,
    sort: null,
    limit: 20,
    offset: 0,
  });
  assert.equal(rows.matched, 2);
  const bad = runDataQuery({ body: '<html>', where: [], limit: 20, offset: 0 });
  assert.equal(bad.code, 'QUERY_NOT_JSON');
});

test('field names cannot be a URL, a prototype key, or an empty where', () => {
  assert.equal(planDataQuery({ where: ['color=http://127.0.0.1/'] }).code, 'QUERY_BAD_WHERE');
  assert.equal(planDataQuery({ where: ['__proto__=x'] }).code, 'QUERY_BAD_WHERE');
  assert.equal(planDataQuery({ where: ['color='] }).code, 'QUERY_BAD_WHERE');
  assert.equal(planDataQuery({ select: 'constructor' }).code, 'QUERY_BAD_SELECT');
  assert.equal(planDataQuery({ limit: 500 }).code, 'QUERY_BAD_LIMIT');
});

test('the query command is a data read, and hire of data stays refused', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const start = cli.indexOf(".command('query <seller>')");
  assert.ok(start > cli.indexOf(".command('browse <seller>')"));
  const block = cli.slice(start, cli.indexOf(".command('job-chat", start));
  assert.match(block, /planDataQuery/);
  assert.match(block, /browseSeller/);
  assert.doesNotMatch(block, /createJob/);
  assert.match(cli, /DATA_NOT_HIREABLE/);
});
