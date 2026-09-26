'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
/** Platform job-file cap. A larger zip is refused rather than truncated. */
const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;
const PACKAGE_FILENAME = 'delivery.zip';
const LONG_NOTICE = 'Full delivery is delivery.zip. This notice is not the package.';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function entryName(name) {
  const norm = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = norm.split('/');
  if (!norm || parts.some((part) => !part || part === '.' || part === '..')) {
    const err = new Error(`Refusing zip entry "${name}"`);
    err.code = 'PACKAGE_BAD_NAME';
    throw err;
  }
  return norm;
}

/**
 * Stored-method zip (no compression). Starts with PK so the platform
 * accepts it as a .zip. Any file type can sit inside.
 */
function buildStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entryName(entry.name), 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(Buffer.concat([local, name, data]));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += locals[locals.length - 1].length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function badZip(message) {
  const err = new Error(message || 'Not a zip package');
  err.code = 'PACKAGE_BAD_ZIP';
  return err;
}

function zipName(buf, start, len) {
  try {
    return entryName(buf.slice(start, start + len).toString('utf8'));
  } catch (e) {
    if (e.code === 'PACKAGE_BAD_NAME') throw badZip('Zip entry name is not inside the package');
    throw e;
  }
}

/**
 * Stored zip only. Local headers and the central directory must name the
 * same bytes. A data descriptor or a deflated entry is rejected: sizes in
 * those zips are not the bytes that follow the local name.
 */
function readStoredZip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const locals = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const sig = buf.readUInt32LE(pos);
    if (sig === 0x02014b50 || sig === 0x06054b50) break;
    if (sig !== 0x04034b50 || pos + 30 > buf.length) throw badZip();
    const flags = buf.readUInt16LE(pos + 6);
    const method = buf.readUInt16LE(pos + 8);
    const crc = buf.readUInt32LE(pos + 14);
    const compSize = buf.readUInt32LE(pos + 18);
    const size = buf.readUInt32LE(pos + 22);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    if ((flags & 0x0008) !== 0) throw badZip('Zip entry uses a data descriptor');
    if (method !== 0 || compSize !== size) throw badZip('Zip entry is compressed');
    const nameStart = pos + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart + size > buf.length) throw badZip();
    const name = zipName(buf, nameStart, nameLen);
    const data = Buffer.from(buf.slice(dataStart, dataStart + size));
    if ((crc32(data) >>> 0) !== crc) throw badZip(`Zip entry "${name}" failed CRC`);
    locals.push({ name, data, crc, size, method, offset: pos });
    pos = dataStart + size;
  }
  if (pos + 4 > buf.length) throw badZip();
  const next = buf.readUInt32LE(pos);
  if (next === 0x06054b50) {
    if (locals.length !== 0) throw badZip();
    return [];
  }
  if (next !== 0x02014b50) throw badZip();
  let count = 0;
  while (pos + 4 <= buf.length && buf.readUInt32LE(pos) === 0x02014b50) {
    if (pos + 46 > buf.length) throw badZip();
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOff = buf.readUInt32LE(pos + 42);
    const nameStart = pos + 46;
    if (nameStart + nameLen + extraLen + commentLen > buf.length) throw badZip();
    if ((flags & 0x0008) !== 0 || method !== 0 || compSize !== size) throw badZip('Zip entry is compressed');
    const name = zipName(buf, nameStart, nameLen);
    const local = locals[count];
    if (!local || local.name !== name || local.crc !== crc || local.size !== size
      || local.method !== method || local.offset !== localOff) {
      throw badZip(`Zip central directory disagrees with "${name}"`);
    }
    count += 1;
    pos = nameStart + nameLen + extraLen + commentLen;
  }
  if (count !== locals.length || pos + 22 > buf.length || buf.readUInt32LE(pos) !== 0x06054b50) throw badZip();
  if (buf.readUInt16LE(pos + 10) !== locals.length) throw badZip();
  return locals.map(({ name, data }) => ({ name, data }));
}

function stripCanary(data, token) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data == null ? '' : data);
  if (!token) return buf;
  const needle = Buffer.from(String(token));
  if (!needle.length || buf.length < needle.length || buf.indexOf(needle) === -1) return buf;
  const redacted = Buffer.from('[redacted]');
  const parts = [];
  let start = 0;
  let idx = buf.indexOf(needle, start);
  while (idx !== -1) {
    parts.push(buf.subarray(start, idx), redacted);
    start = idx + needle.length;
    idx = buf.indexOf(needle, start);
  }
  parts.push(buf.subarray(start));
  return Buffer.concat(parts);
}

function insideBoundary(rootReal, boundary) {
  if (!boundary) return true;
  let boundReal;
  try { boundReal = fs.realpathSync(boundary); } catch { return false; }
  const prefix = boundReal.endsWith(path.sep) ? boundReal : boundReal + path.sep;
  return rootReal.startsWith(prefix);
}

function readRegularFile(full) {
  let listed;
  try { listed = fs.lstatSync(full); } catch { return null; }
  if (!listed.isFile()) return null;
  let fd;
  try { fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (e) {
    if (e.code === 'ELOOP' || e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

/**
 * Files the worker wrote under the job out/ directory.
 * Buyer inputs live in files/ and are not included.
 * A symlink at out/ itself is not a directory: following it packages the
 * job canary. Symlinks inside the walk are skipped, and each file is
 * opened with O_NOFOLLOW after a fresh lstat. Sizes are summed before
 * any read so a huge tree fails closed instead of being loaded.
 */
function listOutputFiles(root, opts = {}) {
  if (!root) return [];
  let st;
  try { st = fs.lstatSync(root); } catch { return []; }
  if (!st.isDirectory()) return [];
  let rootReal;
  try { rootReal = fs.realpathSync(root); } catch { return []; }
  if (!insideBoundary(rootReal, opts.boundary)) return [];
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : MAX_PACKAGE_BYTES;
  const pending = [];
  let total = 0;
  let tooBig = false;
  const walk = (dir, prefix) => {
    if (tooBig) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (tooBig) return;
      if (ent.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!ent.isFile()) continue;
      if (ent.name === 'canary.token') continue;
      let listed;
      try { listed = fs.lstatSync(full); } catch { continue; }
      if (!listed.isFile()) continue;
      total += listed.size;
      if (total > maxBytes) {
        tooBig = true;
        return;
      }
      pending.push({ name: rel, full });
    }
  };
  walk(root, '');
  if (tooBig) {
    const err = new Error('Delivery is over 25MB');
    err.code = 'PACKAGE_TOO_LARGE';
    throw err;
  }
  const out = [];
  for (const file of pending) {
    const data = readRegularFile(file.full);
    if (!data) continue;
    out.push({ name: file.name, data: stripCanary(data, opts.canary) });
  }
  return out;
}

/** Previous delivery.zip uploads to delete after the new one is accepted. */
function packageIdsToReplace(files, filename, keep) {
  const name = String(filename || '');
  const keepId = keep && keep.id ? String(keep.id) : '';
  const keepHash = keep && (keep.checksum || keep.hash) ? String(keep.checksum || keep.hash).toLowerCase() : '';
  if (!keepId && !keepHash) return [];
  const ids = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || !file.id || file.filename !== name) continue;
    if (keepId && String(file.id) === keepId) continue;
    if (!keepId && keepHash && String(file.checksum || '').toLowerCase() === keepHash) continue;
    ids.push(String(file.id));
  }
  return ids;
}

/**
 * The seller's finished work as one zip. `answer.txt` is the written reply.
 * Anything else is a file from out/ (a drawing, a CAD export, a csv).
 * The hash is sha256 of the zip bytes. `sealed` stays false until a buyer
 * z-address exists. The viewing key never leaves the buyer.
 */
function buildDeliveryPackage(content, files, opts = {}) {
  const canary = opts && opts.canary;
  const bodyBuf = stripCanary(Buffer.from(typeof content === 'string' ? content : '', 'utf8'), canary);
  const body = bodyBuf.toString('utf8');
  const extras = Array.isArray(files) ? files : [];
  const entries = [];
  if (body) entries.push({ name: 'answer.txt', data: bodyBuf });
  for (const file of extras) entries.push({ name: file.name, data: stripCanary(file.data, canary) });
  if (entries.length === 0) {
    return {
      filename: PACKAGE_FILENAME,
      body: Buffer.alloc(0),
      hash: null,
      notice: '',
      sealed: false,
      upload: false,
      tooBig: false,
    };
  }
  let rawBytes = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    rawBytes += data.length;
  }
  if (rawBytes > MAX_PACKAGE_BYTES) {
    return {
      filename: PACKAGE_FILENAME,
      body: Buffer.alloc(0),
      hash: null,
      notice: '',
      sealed: false,
      upload: false,
      tooBig: true,
    };
  }
  const zip = buildStoredZip(entries);
  if (zip.length > MAX_PACKAGE_BYTES) {
    return {
      filename: PACKAGE_FILENAME,
      body: Buffer.alloc(0),
      hash: null,
      notice: '',
      sealed: false,
      upload: false,
      tooBig: true,
    };
  }
  const hash = crypto.createHash('sha256').update(zip).digest('hex');
  return {
    filename: PACKAGE_FILENAME,
    body: zip,
    hash,
    notice: LONG_NOTICE,
    sealed: false,
    upload: true,
    tooBig: false,
  };
}

module.exports = {
  MAX_PACKAGE_BYTES,
  PACKAGE_FILENAME,
  LONG_NOTICE,
  buildStoredZip,
  readStoredZip,
  listOutputFiles,
  packageIdsToReplace,
  stripCanary,
  buildDeliveryPackage,
};
