'use strict';
/**
 * Buyer query for a SovData JSON collection.
 *
 * The seller hosts the document. Equality filters are also sent on the
 * listing URL so a site that already understands them (the apples listing
 * echoes q, color, and kind) can shrink the body. Rows are filtered again
 * locally, so a static file that ignores the query string still answers.
 * This is not a hire and it does not crawl links.
 */

const MAX_SCANNED_ROWS = 5000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BANNED = new Set(['__proto__', 'constructor', 'prototype']);
const ROW_KEYS = ['items', 'data', 'rows', 'results'];

function bad(code, message) {
  return { ok: false, code, message };
}

function safeField(name) {
  return FIELD.test(name) && !BANNED.has(name);
}

function parseWhere(expr) {
  const s = String(expr || '').trim();
  const m = s.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|!=|~=|=|>|<)\s*(.+)$/);
  if (!m || !safeField(m[1])) {
    return bad('QUERY_BAD_WHERE', 'where must look like color=red or taste~=tart');
  }
  const value = m[3].trim();
  if (!value) return bad('QUERY_BAD_WHERE', 'where value is empty');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return bad('QUERY_BAD_WHERE', 'where value must not be a URL');
  }
  return { ok: true, field: m[1], op: m[2], value };
}

function parseSelect(raw) {
  if (raw == null || String(raw).trim() === '') return { ok: true, fields: null };
  const fields = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (!fields.length || fields.some((f) => !safeField(f))) {
    return bad('QUERY_BAD_SELECT', '--select needs comma-separated field names');
  }
  return { ok: true, fields };
}

function parseSort(raw) {
  if (raw == null || String(raw).trim() === '') return { ok: true, field: null, desc: false };
  const s = String(raw).trim();
  const desc = s.startsWith('-');
  const field = desc ? s.slice(1) : s;
  if (!safeField(field)) return bad('QUERY_BAD_SORT', '--sort needs a field name, or -field');
  return { ok: true, field, desc };
}

function parseLimit(raw) {
  if (raw == null || raw === '') return { ok: true, limit: DEFAULT_LIMIT };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    return bad('QUERY_BAD_LIMIT', `--limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return { ok: true, limit: n };
}

function parseOffset(raw) {
  if (raw == null || raw === '') return { ok: true, offset: 0 };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return bad('QUERY_BAD_OFFSET', '--offset must be an integer >= 0');
  return { ok: true, offset: n };
}

function cell(row, field) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(row, field)) return undefined;
  return row[field];
}

function asNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function compare(op, left, rightRaw) {
  if (left === undefined || left === null) return false;
  if (op === '~=') return String(left).toLowerCase().includes(String(rightRaw).toLowerCase());
  const ln = asNumber(left);
  const rn = asNumber(rightRaw);
  const numeric = ln !== null && rn !== null;
  const L = numeric ? ln : String(left);
  const R = numeric ? rn : String(rightRaw);
  if (op === '=') return L === R;
  if (op === '!=') return L !== R;
  if (op === '>') return L > R;
  if (op === '<') return L < R;
  if (op === '>=') return L >= R;
  if (op === '<=') return L <= R;
  return false;
}

function rowMatchesQ(row, q) {
  if (!q) return true;
  const needle = String(q).toLowerCase();
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return String(row).toLowerCase().includes(needle);
  }
  return Object.keys(row).some((key) => {
    if (!safeField(key)) return false;
    const value = row[key];
    return value != null && String(value).toLowerCase().includes(needle);
  });
}

function extractRows(body) {
  let parsed;
  try { parsed = JSON.parse(String(body == null ? '' : body)); } catch {
    return bad('QUERY_NOT_JSON', 'Listing body is not JSON');
  }
  if (Array.isArray(parsed)) return { ok: true, rows: parsed };
  if (parsed && typeof parsed === 'object') {
    for (const key of ROW_KEYS) {
      if (Array.isArray(parsed[key])) return { ok: true, rows: parsed[key] };
    }
  }
  return bad('QUERY_NO_ROWS', 'JSON has no items, data, rows, or results array');
}

function project(row, fields) {
  if (!fields) return row;
  const out = {};
  if (!row || typeof row !== 'object' || Array.isArray(row)) return out;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(row, field)) out[field] = row[field];
  }
  return out;
}

function serverQueryString({ where, q, limit, offset }) {
  const params = new URLSearchParams();
  const comparisons = (where || []).some((w) => w.op !== '=');
  for (const w of where || []) {
    if (w.op === '=') params.set(w.field, w.value);
  }
  if (q) params.set('q', q);
  // A comparison has to see every row the 1 MB cap returned. Sending limit
  // in that case would let a cooperating server hide the rows we still need.
  if (!comparisons) {
    if (limit != null) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
  }
  const s = params.toString();
  return s || null;
}

function planDataQuery(opts = {}) {
  const where = [];
  for (const expr of opts.where || []) {
    const parsed = parseWhere(expr);
    if (!parsed.ok) return parsed;
    where.push(parsed);
  }
  const select = parseSelect(opts.select);
  if (!select.ok) return select;
  const sort = parseSort(opts.sort);
  if (!sort.ok) return sort;
  const limit = parseLimit(opts.limit);
  if (!limit.ok) return limit;
  const offset = parseOffset(opts.offset);
  if (!offset.ok) return offset;
  const q = opts.q != null && String(opts.q).trim() !== '' ? String(opts.q).trim() : '';
  if (q && (q.length > 200 || /^[a-z][a-z0-9+.-]*:\/\//i.test(q))) {
    return bad('QUERY_BAD_Q', '--q must be a short search string, not a URL');
  }
  return {
    ok: true,
    where,
    q,
    select: select.fields,
    sort: sort.field ? { field: sort.field, desc: sort.desc } : null,
    limit: limit.limit,
    offset: offset.offset,
    serverQuery: serverQueryString({ where, q, limit: limit.limit, offset: offset.offset }),
  };
}

function runDataQuery({ body, where, q, select, sort, limit, offset } = {}) {
  const extracted = extractRows(body);
  if (!extracted.ok) return extracted;
  let rows = extracted.rows;
  if (rows.length > MAX_SCANNED_ROWS) {
    return bad(
      'QUERY_TOO_MANY',
      `Listing has ${rows.length} rows. The cap is ${MAX_SCANNED_ROWS}. Add an equality --where so the seller can filter first.`,
    );
  }
  const scanned = rows.length;
  rows = rows.filter((row) => {
    if (!rowMatchesQ(row, q)) return false;
    return (where || []).every((w) => compare(w.op, cell(row, w.field), w.value));
  });
  const matched = rows.length;
  if (sort && sort.field) {
    const { field, desc } = sort;
    rows = rows.slice().sort((a, b) => {
      const av = cell(a, field);
      const bv = cell(b, field);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const an = asNumber(av);
      const bn = asNumber(bv);
      let cmp = 0;
      if (an !== null && bn !== null) cmp = an - bn;
      else cmp = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
      return desc ? -cmp : cmp;
    });
  }
  const page = rows.slice(offset || 0, (offset || 0) + limit).map((row) => project(row, select));
  return { ok: true, scanned, matched, returned: page.length, rows: page };
}

module.exports = {
  MAX_SCANNED_ROWS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  planDataQuery,
  runDataQuery,
  extractRows,
  serverQueryString,
};
