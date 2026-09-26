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

function readStoredZip(buf) {
  const out = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const sig = buf.readUInt32LE(pos);
    if (sig === 0x02014b50 || sig === 0x06054b50) break;
    if (sig !== 0x04034b50) {
      const err = new Error('Not a zip package');
      err.code = 'PACKAGE_BAD_ZIP';
      throw err;
    }
    const method = buf.readUInt16LE(pos + 8);
    const crc = buf.readUInt32LE(pos + 14);
    const size = buf.readUInt32LE(pos + 22);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const nameStart = pos + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const name = entryName(buf.slice(nameStart, nameStart + nameLen).toString('utf8'));
    const data = Buffer.from(buf.slice(dataStart, dataStart + size));
    if (method !== 0) {
      const err = new Error(`Zip entry "${name}" is compressed`);
      err.code = 'PACKAGE_BAD_ZIP';
      throw err;
    }
    if ((crc32(data) >>> 0) !== crc) {
      const err = new Error(`Zip entry "${name}" failed CRC`);
      err.code = 'PACKAGE_BAD_ZIP';
      throw err;
    }
    out.push({ name, data });
    pos = dataStart + size;
  }
  return out;
}

/**
 * Files the worker wrote under the job out/ directory.
 * Buyer inputs live in files/ and are not included. Symlinks are skipped.
 */
function listOutputFiles(root) {
  if (!root || !fs.existsSync(root)) return [];
  const acc = [];
  const walk = (dir, prefix) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, rel);
      else if (ent.isFile()) acc.push({ name: rel, data: fs.readFileSync(full) });
    }
  };
  walk(root, '');
  return acc;
}

/**
 * The seller's finished work as one zip. `answer.txt` is the written reply.
 * Anything else is a file from out/ (a drawing, a CAD export, a csv).
 * The hash is sha256 of the zip bytes. `sealed` stays false until a buyer
 * z-address exists. The viewing key never leaves the buyer.
 */
function buildDeliveryPackage(content, files) {
  const body = typeof content === 'string' ? content : '';
  const extras = Array.isArray(files) ? files : [];
  const entries = [];
  if (body) entries.push({ name: 'answer.txt', data: Buffer.from(body, 'utf8') });
  for (const file of extras) entries.push({ name: file.name, data: file.data });
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
  buildDeliveryPackage,
};
