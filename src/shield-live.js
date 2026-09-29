'use strict';

/**
 * Disk, parameter files, and the Sapling library behind the round trip.
 * The seed file is mode 0600. Scan uses the viewing key. The spending key is
 * derived for the prove and is not returned.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { PARAM_SHA256, COIN_TYPE } = require('./shield-proof');
const { runOwnNoteProof } = require('./shield-run');

const PARAM_URLS = {
  spend: 'https://verus.io/zcparams/sapling-spend.params',
  output: 'https://verus.io/zcparams/sapling-output.params',
};
const PARAM_NAMES = {
  spend: 'sapling-spend.params',
  output: 'sapling-output.params',
};

function outputScriptFor(rAddress, networkName) {
  const utxolib = require('@bitgo/utxo-lib');
  const network = networkName === 'verus' ? utxolib.networks.verus : utxolib.networks.verustest;
  return utxolib.address.toOutputScript(rAddress, network).toString('hex');
}

function accountFile(agentsDir, agentId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(agentId) || agentId.includes('..')) {
    throw new Error('Invalid agent ID format');
  }
  return path.join(agentsDir, agentId, 'sapling-account.json');
}

function readStoredAccount(file) {
  if (!fs.existsSync(file)) return null;
  try {
    if ((fs.statSync(file).mode & 0o777) !== 0o600) fs.chmodSync(file, 0o600);
  } catch {}
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || parsed.v !== 1 || parsed.coinType !== COIN_TYPE || parsed.account !== 0) return { invalid: true };
  if (typeof parsed.seedHex !== 'string' || !/^[0-9a-f]{128}$/i.test(parsed.seedHex)) return { invalid: true };
  const birthdayHeight = Number.isInteger(parsed.birthdayHeight) ? parsed.birthdayHeight : null;
  return { seedHex: parsed.seedHex, birthdayHeight };
}

function writeStoredAccount(file, account) {
  if (fs.existsSync(file)) {
    throw new Error('The shielded account file is already present and cannot be replaced.');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = JSON.stringify({
    v: 1,
    coinType: COIN_TYPE,
    account: 0,
    seedHex: account.seedHex,
    birthdayHeight: account.birthdayHeight,
  });
  fs.writeFileSync(file, body, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function paramFile(dir, kind) {
  return path.join(dir, PARAM_NAMES[kind]);
}

function paramsMatch(dir) {
  try {
    return sha256File(paramFile(dir, 'spend')) === PARAM_SHA256.spend
      && sha256File(paramFile(dir, 'output')) === PARAM_SHA256.output;
  } catch {
    return false;
  }
}

function readParams(dir) {
  if (!paramsMatch(dir)) return null;
  return {
    spend: new Uint8Array(fs.readFileSync(paramFile(dir, 'spend'))),
    output: new Uint8Array(fs.readFileSync(paramFile(dir, 'output'))),
  };
}

function fetchToFile(url, dest, redirects) {
  if (redirects > 3) return Promise.reject(new Error('parameter download redirected too many times'));
  const lib = url.startsWith('http://') ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.get(url, { headers: { 'User-Agent': 'j41-dispatcher' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(fetchToFile(next, dest, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`parameter download returned ${res.statusCode}`));
        return;
      }
      const tmp = `${dest}.partial`;
      const out = fs.createWriteStream(tmp, { mode: 0o600 });
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => {
          fs.renameSync(tmp, dest);
          resolve();
        });
      });
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(300000, () => req.destroy(new Error('parameter download timed out')));
  });
}

async function ensureParams(dir) {
  if (paramsMatch(dir)) return { ok: true };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const kind of ['spend', 'output']) {
    const dest = paramFile(dir, kind);
    if (fs.existsSync(dest) && sha256File(dest) === PARAM_SHA256[kind]) continue;
    await fetchToFile(PARAM_URLS[kind], dest, 0);
    if (sha256File(dest) !== PARAM_SHA256[kind]) {
      fs.rmSync(dest, { force: true });
      return { ok: false, code: 'SHIELD_PARAMS', message: 'The Sapling parameter file did not match its SHA-256.' };
    }
  }
  return { ok: true };
}

function lightwalletdTarget(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (text.startsWith('http://')) return { address: text.slice('http://'.length), insecure: true };
  if (text.startsWith('https://')) return { address: text.slice('https://'.length), insecure: false };
  return { address: text, insecure: false };
}

function safeMessage(error) {
  const text = String((error && error.message) || 'shielded call failed');
  if (/[0-9a-f]{64,}/i.test(text)) return 'The shielded call failed.';
  return text;
}

let libraryPromise = null;
function loadLibrary() {
  if (!libraryPromise) {
    libraryPromise = (async () => {
      const sapling = await import('@chainvue/verus-sapling');
      const lwd = await import('@chainvue/verus-sapling/lightwalletd');
      const entry = path.dirname(require.resolve('@chainvue/verus-sapling'));
      const root = [entry, path.resolve(entry, '..'), path.resolve(entry, '../..')]
        .find((candidate) => fs.existsSync(path.join(candidate, 'crate/pkg/verus_sapling_prover_bg.wasm')));
      const wasm = root && path.join(root, 'crate/pkg/verus_sapling_prover_bg.wasm');
      if (!wasm) throw new Error('The Sapling prover wasm is not in the installed package.');
      await sapling.initSapling(fs.readFileSync(wasm));
      return { sapling, LightwalletdClient: lwd.LightwalletdClient };
    })().catch((error) => {
      libraryPromise = null;
      throw error;
    });
  }
  return libraryPromise;
}

function makeDeps(opts) {
  let seedHex = null;
  let viewHex = null;
  let client = null;
  return {
    readAccount: async () => {
      const stored = readStoredAccount(opts.accountFile);
      if (stored && stored.invalid) {
        const error = new Error('The shielded account file is not a coin-type 133 account.');
        error.code = 'SHIELD_ACCOUNT';
        throw error;
      }
      return stored;
    },
    writeAccount: async (account) => writeStoredAccount(opts.accountFile, account),
    randomSeed: () => crypto.randomBytes(64).toString('hex'),
    ready: async () => ensureParams(opts.paramsDir),
    prepare: async (account) => {
      const lib = await loadLibrary();
      const derived = await lib.sapling.deriveSaplingAccount({
        seedHex: account.seedHex,
        coinType: COIN_TYPE,
        account: 0,
      });
      seedHex = account.seedHex;
      viewHex = derived.dfvkHex;
      return { address: derived.address, addressHex: derived.addressHex };
    },
    tip: async () => {
      const info = await opts.client.getChainInfo();
      const tip = info && (info.blockHeight != null ? info.blockHeight : info.blocks);
      return Number(tip);
    },
    utxos: async () => {
      const body = await opts.client.getUtxos();
      return body && Array.isArray(body.utxos) ? body.utxos : [];
    },
    scan: async (fromHeight) => {
      const lib = await loadLibrary();
      const lwd = await lightClient();
      const notes = await lib.sapling.detectNotes(lwd, (spec) => lib.sapling.detectNotesWasm(spec), {
        key: { dfvkHex: viewHex },
        fromHeight: Math.max(1, fromHeight),
      });
      return notes.map((note) => ({
        txid: note.txid,
        outputIndex: note.outputIndex,
        valueSats: Number(note.valueSats),
        height: note.height,
      }));
    },
    shield: async (spec) => {
      const lib = await loadLibrary();
      const params = readParams(opts.paramsDir);
      if (!params) throw new Error('The Sapling parameters are not available.');
      await lib.sapling.verifyCanonicalParams(params);
      return lib.sapling.shieldT2z(JSON.stringify(spec), params);
    },
    spend: async (request) => {
      const lib = await loadLibrary();
      const derived = await lib.sapling.deriveSaplingAccount({ seedHex, coinType: COIN_TYPE, account: 0 });
      const params = readParams(opts.paramsDir);
      if (!params) throw new Error('The Sapling parameters are not available.');
      const lwd = await lightClient();
      const built = await lib.sapling.buildShieldedSpend(
        lwd,
        (spec) => lib.sapling.spendShielded(spec, params),
        {
          note: {
            txid: request.txid,
            outputIndex: request.outputIndex,
            valueSats: BigInt(request.valueSats),
            extskHex: derived.extskHex,
          },
          transparentOutputs: [{ valueSats: BigInt(request.returnedSats), scriptHex: request.scriptHex }],
          feeSats: BigInt(request.feeSats),
          shieldedOutputs: [],
        },
      );
      return built.hex;
    },
    broadcast: async (hex) => opts.client.broadcast(hex),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };

  async function lightClient() {
    if (client) return client;
    const target = lightwalletdTarget(opts.lightwalletdUrl);
    if (!target) throw new Error('A lightwalletd host:port is required.');
    const lib = await loadLibrary();
    client = new lib.LightwalletdClient(target.address, { insecure: target.insecure });
    return client;
  }
}

async function liveShieldProof(opts) {
  try {
    return await runOwnNoteProof({
      network: opts.network,
      coinType: COIN_TYPE,
      amountSats: opts.amountSats,
      feeSats: opts.feeSats,
      lightwalletdUrl: opts.lightwalletdUrl,
      rAddress: opts.rAddress,
      outputScriptHex: opts.outputScriptHex,
      wif: opts.wif,
      yes: opts.yes === true,
    }, makeDeps(opts));
  } catch (error) {
    return {
      ok: false,
      code: error && error.code ? error.code : 'SHIELD_FAILED',
      broadcast: false,
      hire: false,
      message: safeMessage(error),
    };
  }
}

/** Notes this account can see, from its birthday. The viewing key is not returned. */
async function scanNotes(opts) {
  const deps = makeDeps({
    accountFile: opts.accountFile,
    paramsDir: opts.paramsDir,
    lightwalletdUrl: opts.lightwalletdUrl,
    client: opts.client || null,
  });
  const account = await deps.readAccount();
  if (!account) {
    const error = new Error('This identity has no shielded account yet.');
    error.code = 'Z_ADDRESS_NOT_SET';
    throw error;
  }
  const prepared = await deps.prepare(account);
  const fromHeight = opts.fromHeight != null ? opts.fromHeight : (account.birthdayHeight || 1);
  const notes = await deps.scan(fromHeight);
  return {
    notes,
    addressHex: prepared.addressHex,
    changeAddress: prepared.address,
  };
}

module.exports = {
  outputScriptFor,
  accountFile,
  readStoredAccount,
  writeStoredAccount,
  paramsMatch,
  ensureParams,
  readParams,
  loadLibrary,
  liveShieldProof,
  lightwalletdTarget,
  scanNotes,
};
