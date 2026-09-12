'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { buildDepositReportMessage } = require('@junction41/sovagent-sdk/dist/index.js');
const {
  planBuyerDeposit,
  resolveDepositDestination,
  resolveDepositReportUrl,
  buildSignedDepositReport,
  postDepositReport,
  waitForDepositCredit,
  classifyDepositReport,
  depositNoPublicUrlMessage,
  parseDepositAmount,
} = require('../src/buyer-deposit');
const { mintBuyerProxyBase, isDispatcherProxyBase } = require('../src/buyer-proxy-url');

const CLI_PATH = path.join(__dirname, '../src/cli.js');
const CLI = fs.readFileSync(CLI_PATH, 'utf8');
const BUYER_DEPOSIT_SRC = fs.readFileSync(path.join(__dirname, '../src/buyer-deposit.js'), 'utf8');
const SPEND_SRC = fs.readFileSync(path.join(__dirname, '../src/spend-policy.js'), 'utf8');

function depositSrc() {
  const start = CLI.indexOf(".command('deposit <buyer-id> <seller>')");
  assert.ok(start > -1, 'deposit command not found in cli.js');
  const end = CLI.indexOf(".command('report-deposit <buyer-id> <seller>')", start);
  assert.ok(end > start, 'could not bound the deposit action');
  return CLI.slice(start, end);
}

function reportDepositSrc() {
  const start = CLI.indexOf(".command('report-deposit <buyer-id> <seller>')");
  assert.ok(start > -1, 'report-deposit command not found in cli.js');
  const end = CLI.indexOf('async function confirmHire', start);
  assert.ok(end > start, 'could not bound the report-deposit action');
  return CLI.slice(start, end);
}

function walletSendSrc() {
  const start = CLI.indexOf(".command('wallet [action] [args...]')");
  assert.ok(start > -1, 'wallet command not found');
  return CLI.slice(start, start + 8000);
}

function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms > 0 ? ms : 1; },
  };
}

// ── planBuyerDeposit / destination ──

test('planBuyerDeposit refuses an in-flight stamp and --force passes', () => {
  const now = 1_000_000;
  const blocked = planBuyerDeposit({
    pending: { txid: 'abc', at: now - 60_000, kind: 'deposit' },
    now,
    force: false,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'PAY_PENDING');
  const forced = planBuyerDeposit({
    pending: { txid: 'abc', at: now - 60_000, kind: 'deposit' },
    now,
    force: true,
  });
  assert.equal(forced.ok, true);
  assert.equal(planBuyerDeposit({ pending: null, now, force: false }).ok, true);
});

test('planBuyerDeposit / resolveDepositDestination deny seller R-address as toAddress', () => {
  const iAddress = 'iSellerIaddrXXXXXXXXXXXXXXXXXXXXXXX';
  const rAddress = 'RSellerRaddrXXXXXXXXXXXXXXXXXXXXXXX';
  const dest = resolveDepositDestination({
    payInfo: { address: rAddress, iAddress },
    listing: { payaddress: rAddress },
  });
  assert.equal(dest.ok, true);
  assert.equal(dest.toAddress, iAddress);
  assert.deepEqual(dest.expectedRecipients, [iAddress]);
  assert.ok(!dest.expectedRecipients.includes(rAddress));

  const rOnly = resolveDepositDestination({
    payInfo: { address: rAddress },
    listing: { payaddress: rAddress },
  });
  assert.equal(rOnly.ok, false);
  assert.equal(rOnly.code, 'DEPOSIT_NOT_SELLER');

  const planned = planBuyerDeposit({
    pending: null,
    now: 1,
    force: false,
    toAddress: rAddress,
    iAddress,
    sellerRAddress: rAddress,
  });
  assert.equal(planned.ok, false);
  assert.equal(planned.code, 'DEPOSIT_NOT_SELLER');
});

test('402 topupAddress / listing payaddress is not the autonomous toAddress unless it is the i-address', () => {
  const iAddress = 'iSellerIaddrXXXXXXXXXXXXXXXXXXXXXXX';
  const topup = 'RTopupHintXXXXXXXXXXXXXXXXXXXXXXXX';
  const dest = resolveDepositDestination({
    payInfo: { iAddress, address: 'RSeller' },
    listing: { payaddress: topup },
    topupAddress: topup,
  });
  assert.equal(dest.toAddress, iAddress);
  assert.ok(!dest.expectedRecipients.includes(topup));

  const payIsI = resolveDepositDestination({
    payInfo: { iAddress },
    listing: { payaddress: iAddress },
  });
  assert.deepEqual(payIsI.expectedRecipients, [iAddress]);
});

test('parseDepositAmount uses parseVrscAmount and has no silent 10 VRSC default', () => {
  const ok = parseDepositAmount('1.5');
  assert.equal(ok.ok, true);
  assert.equal(ok.amount, '1.5');
  assert.equal(ok.sats, 150000000);
  assert.equal(parseDepositAmount(undefined).ok, false);
  assert.equal(parseDepositAmount('').ok, false);
  assert.equal(parseDepositAmount('0').ok, false);
  assert.doesNotMatch(BUYER_DEPOSIT_SRC, /suggested_topup/);
  assert.doesNotMatch(BUYER_DEPOSIT_SRC, /parseFloat\s*\([^)]*\)\s*\*\s*1e8/);
});

// ── report URL first-win ──

test('NVIDIA grant origin is not used as the deposit report URL', async () => {
  let fetched = false;
  const r = await resolveDepositReportUrl({
    grant: { endpointUrl: 'https://integrate.api.nvidia.com/v1' },
    listing: null,
    fetchImpl: async () => { fetched = true; return { ok: true, json: async () => ({ service: 'dispatcher' }) }; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DEPOSIT_NO_PUBLIC_URL');
  assert.equal(fetched, false);
  assert.doesNotMatch(String(r.url || ''), /nvidia/i);
});

test('NVIDIA grant + same-host listing hint is refused (health not used as a rewrite)', async () => {
  let fetched = false;
  const r = await resolveDepositReportUrl({
    grant: { endpointUrl: 'https://integrate.api.nvidia.com/v1' },
    listing: { website: 'https://integrate.api.nvidia.com/v1' },
    fetchImpl: async () => { fetched = true; return { ok: true, json: async () => ({ service: 'dispatcher' }) }; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DEPOSIT_NO_PUBLIC_URL');
  assert.equal(fetched, false);
});

test('listing hint without dispatcher /j41/health → DEPOSIT_NO_PUBLIC_URL, no report POST', async () => {
  const urls = [];
  const r = await resolveDepositReportUrl({
    grant: { endpointUrl: 'https://integrate.api.nvidia.com/v1' },
    listing: { networkEndpoints: ['https://marketing.example/'] },
    fetchImpl: async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ service: 'nginx' }) };
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DEPOSIT_NO_PUBLIC_URL');
  assert.ok(urls.every((u) => u.endsWith('/j41/health')), 'only health is probed, never /j41/deposit/report');
  assert.ok(!urls.some((u) => u.includes('/deposit/report')));
});

test('dispatcher grant path-check wins without minting NVIDIA or probing health', async () => {
  const r = await resolveDepositReportUrl({
    grant: { endpointUrl: 'https://foo.example/j41/proxy/v1' },
    listing: { website: 'https://integrate.api.nvidia.com/v1' },
    fetchImpl: async () => { throw new Error('should not fetch'); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://foo.example/j41/deposit/report');
});

test('listing hint with dispatcher health mints report URL (NVIDIA grant falls through)', async () => {
  const r = await resolveDepositReportUrl({
    grant: { endpointUrl: 'https://integrate.api.nvidia.com/v1' },
    listing: { networkEndpoints: ['https://foo.example/website'] },
    fetchImpl: async (url) => {
      assert.equal(String(url), 'https://foo.example/j41/health');
      return { ok: true, json: async () => ({ service: 'dispatcher', status: 'ok' }) };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://foo.example/j41/deposit/report');
});

test('isDispatcherProxyBase(mintBuyerProxyBase(hint)) is NOT used as a gate', () => {
  assert.equal(isDispatcherProxyBase(mintBuyerProxyBase('https://example.com')), true);
  assert.equal(isDispatcherProxyBase(mintBuyerProxyBase('https://integrate.api.nvidia.com/v1')), true);
  assert.doesNotMatch(
    BUYER_DEPOSIT_SRC,
    /isDispatcherProxyBase\s*\(\s*mintBuyerProxyBase/,
    'tautology must not be the listing gate',
  );
});

test('DEPOSIT_NO_PUBLIC_URL copy points at access + publicUrl / --webhook-url', () => {
  const msg = depositNoPublicUrlMessage('buyer-1', 'seller.agentplatform@');
  assert.match(msg, /j41-dispatcher access buyer-1 seller\.agentplatform@/);
  assert.match(msg, /publicUrl/);
  assert.match(msg, /--webhook-url/);
  assert.match(msg, /Poll-only/);
});

// ── signed report ──

test('buildSignedDepositReport field order matches SDK J41-DEPOSIT-REPORT', () => {
  const r = buildSignedDepositReport({
    buyerVerusId: 'buyer@',
    sellerVerusId: 'seller@',
    txid: 'abc',
    amount: '1.5',
    nonce: 'n1',
    timestamp: 1700000000,
    signMessage: () => 'sig',
  });
  const expected = buildDepositReportMessage({
    buyerVerusId: 'buyer@',
    sellerVerusId: 'seller@',
    txid: 'abc',
    amount: '1.5',
    nonce: 'n1',
    timestamp: 1700000000,
  });
  assert.equal(r.message, expected);
  assert.equal(
    r.message,
    'J41-DEPOSIT-REPORT|Buyer:buyer@|Seller:seller@|Txid:abc|Amt:1.5|Nonce:n1|Ts:1700000000|I attest I sent this deposit and claim its credit.',
  );
  assert.equal(r.amount, '1.5');
  assert.equal(r.signature, 'sig');
});

// ── --wait protocol ──

test('classifyDepositReport: credited / already processed / replay / pending', () => {
  assert.equal(classifyDepositReport({ status: 200, body: { credited: true } }).kind, 'credited');
  assert.equal(classifyDepositReport({
    status: 200, body: { credited: false, message: 'Deposit already processed' },
  }).kind, 'already_processed');
  assert.equal(classifyDepositReport({ status: 409, body: { code: 'REPLAY', message: 'nonce used' } }).kind, 'replay');
  const pending = classifyDepositReport({
    status: 200, body: { credited: false, message: 'Waiting for 1 more confirmation(s) (0/1)' },
  });
  assert.equal(pending.kind, 'pending');
  assert.equal(pending.accepted, true);
  const bad = classifyDepositReport({ status: 403, body: { code: 'BAD_SIGNATURE', message: 'nope' } });
  assert.equal(bad.kind, 'error');
  assert.equal(bad.accepted, false);
});

test('first POST REPLAY with no prior accepted report → DEPOSIT_REPLAY', async () => {
  const r = await waitForDepositCredit({
    txid: 'tx-replay',
    amount: '5',
    wait: true,
    buildReport: async () => ({ nonce: 'n1', txid: 'tx-replay', amount: '5' }),
    postReport: async () => ({ status: 409, body: { code: 'REPLAY', message: 'Deposit report nonce has already been used' } }),
    getTxStatus: async () => { throw new Error('should not poll'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DEPOSIT_REPLAY');
  assert.equal(r.credited, false);
});

test('first POST 403 SENDER_MISMATCH → ok:false credited:false, not credited:true', async () => {
  const r = await waitForDepositCredit({
    txid: 'tx-mismatch',
    amount: '0.05',
    wait: true,
    buildReport: async () => ({ nonce: 'n1', txid: 'tx-mismatch', amount: '0.05' }),
    postReport: async () => ({
      status: 403,
      body: {
        code: 'SENDER_MISMATCH',
        message: 'Funding transaction sender does not match the claiming buyer',
        credited: false,
      },
    }),
    getTxStatus: async () => { throw new Error('should not poll after hard seller refuse'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SENDER_MISMATCH');
  assert.equal(r.credited, false);
  assert.notEqual(r.code, null);
  assert.equal(!!r.credited, false);
});

test('second POST SENDER_MISMATCH is not swallowed as DEPOSIT_WAIT_TIMEOUT', async () => {
  const posts = [];
  const clock = makeClock();
  let confs = 0;
  const r = await waitForDepositCredit({
    txid: 'tx-mismatch-2',
    amount: '5',
    wait: true,
    timeoutMs: 180000,
    intervalMs: 5000,
    now: clock.now,
    sleep: async (ms) => { confs = 1; await clock.sleep(ms); },
    getTxStatus: async () => ({ confirmations: confs }),
    requiredConfirmations: () => 1,
    txConfirmations: (st) => Number(st.confirmations) || 0,
    buildReport: async () => ({ nonce: `n${posts.length + 1}`, txid: 'tx-mismatch-2', amount: '5' }),
    postReport: async (body) => {
      posts.push(body);
      if (posts.length === 1) {
        return { status: 200, body: { credited: false, message: 'Waiting for 1 more confirmation(s) (0/1)' } };
      }
      return {
        status: 403,
        body: { code: 'SENDER_MISMATCH', message: 'Funding transaction sender does not match the claiming buyer', credited: false },
      };
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SENDER_MISMATCH');
  assert.equal(r.credited, false);
  assert.notEqual(r.code, 'DEPOSIT_WAIT_TIMEOUT');
  assert.equal(posts.length, 2);
});

test('REPLAY after an accepted report this invocation is success', async () => {
  const posts = [];
  const clock = makeClock();
  let confs = 0;
  const r = await waitForDepositCredit({
    txid: 'tx-ok',
    amount: '5',
    wait: true,
    timeoutMs: 180000,
    intervalMs: 5000,
    now: clock.now,
    sleep: clock.sleep,
    getTxStatus: async () => ({ confirmations: confs }),
    requiredConfirmations: () => 1,
    txConfirmations: (st) => Number(st.confirmations) || 0,
    buildReport: async () => ({ nonce: `n${posts.length + 1}`, txid: 'tx-ok', amount: '5' }),
    postReport: async (body) => {
      posts.push(body);
      if (posts.length === 1) {
        confs = 1;
        return { status: 200, body: { credited: false, message: 'Waiting for 1 more confirmation(s) (0/1)' } };
      }
      return { status: 409, body: { code: 'REPLAY', message: 'Deposit report nonce has already been used' } };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.code, null);
  assert.equal(r.credited, false, 'REPLAY after a pending first POST is not a meter credit');
  assert.equal(r.alreadyReported, true);
  assert.equal(r.pending, false);
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0].nonce, posts[1].nonce);
});

test('--wait: first POST pending → poll getTxStatus → second POST new nonce credits', async () => {
  const posts = [];
  const statuses = [];
  const clock = makeClock();
  let confs = 0;
  const r = await waitForDepositCredit({
    txid: 'tx-wait',
    amount: '5',
    wait: true,
    timeoutMs: 180000,
    intervalMs: 5000,
    now: clock.now,
    sleep: async (ms) => { confs = 1; await clock.sleep(ms); },
    getTxStatus: async () => {
      statuses.push(confs);
      return { confirmations: confs };
    },
    requiredConfirmations: () => 1,
    txConfirmations: (st) => Number(st.confirmations) || 0,
    buildReport: async () => ({ nonce: `nonce-${posts.length}`, txid: 'tx-wait', amount: '5' }),
    postReport: async (body) => {
      posts.push(body);
      if (posts.length === 1) {
        return { status: 200, body: { credited: false, message: 'Waiting for 1 more confirmation(s) (0/1)' } };
      }
      return { status: 200, body: { credited: true, message: 'Deposit confirmed and credited' } };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.credited, true);
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0].nonce, posts[1].nonce);
  assert.ok(statuses.length >= 1, 'polled local getTxStatus');
});

test('Deposit already processed after first accepted report is success', async () => {
  const r = await waitForDepositCredit({
    txid: 'tx-done',
    amount: '1',
    wait: true,
    buildReport: async () => ({ nonce: 'n1', txid: 'tx-done', amount: '1' }),
    postReport: async () => ({ status: 200, body: { credited: false, message: 'Deposit already processed' } }),
    getTxStatus: async () => { throw new Error('should not poll'); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.credited, true);
});

test('DEPOSIT_WAIT_TIMEOUT is ok:true credited:false pending:true', async () => {
  const clock = makeClock();
  const r = await waitForDepositCredit({
    txid: 'tx-to',
    amount: '5',
    wait: true,
    timeoutMs: 100,
    intervalMs: 50,
    now: clock.now,
    sleep: clock.sleep,
    getTxStatus: async () => ({ confirmations: 0 }),
    requiredConfirmations: () => 1,
    txConfirmations: () => 0,
    buildReport: async () => ({ nonce: 'fresh', txid: 'tx-to', amount: '5' }),
    postReport: async () => ({
      status: 200,
      body: { credited: false, message: 'Waiting for 1 more confirmation(s) (0/1)' },
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'DEPOSIT_WAIT_TIMEOUT');
  assert.equal(r.credited, false);
  assert.equal(r.pending, true);
});

test('postDepositReport POSTs the signed JSON body to the report URL', async () => {
  const calls = [];
  const classified = await postDepositReport(
    'https://foo.example/j41/deposit/report',
    {
      buyerVerusId: 'buyer@',
      sellerVerusId: 'seller@',
      txid: 'deadbeef',
      amount: '1.5',
      nonce: 'n1',
      timestamp: 1,
      signature: 'sig',
    },
    async (url, init) => {
      calls.push({ url, init });
      return { status: 200, ok: true, json: async () => ({ credited: true, message: 'ok' }) };
    },
  );
  assert.equal(calls[0].url, 'https://foo.example/j41/deposit/report');
  assert.equal(calls[0].init.method, 'POST');
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.amount, '1.5');
  assert.equal(sent.txid, 'deadbeef');
  assert.equal(sent.signature, 'sig');
  assert.equal(classified.kind, 'credited');
});

// ── CLI wiring ──

test('CLI registers deposit and report-deposit --wait', () => {
  const dep = depositSrc();
  const rep = reportDepositSrc();
  assert.match(dep, /\.option\('--wait'/);
  assert.match(rep, /\.option\('--wait'/);
  assert.match(dep, /\.option\('--force'/);
  assert.match(dep, /J41_HEADLESS_MAINNET_PAY/);
  assert.match(CLI, /Broadcast .+ VRSC to .+ i-address as API credit/);
});

test('deposit broadcasts sendMultiPayment single i-address output, not wallet send', () => {
  const dep = depositSrc();
  assert.match(dep, /sendMultiPayment\(/);
  assert.doesNotMatch(dep, /executeSend\(/);
  assert.doesNotMatch(dep, /walletSend\(/);
  assert.match(dep, /saveWalletPending\([\s\S]*kind:\s*'deposit'/);
  const send = dep.indexOf('sendMultiPayment(');
  const gate = dep.indexOf('gateExternalSend(');
  const plan = dep.indexOf('planHirePayment(') !== -1 ? dep.indexOf('planHirePayment(') : dep.indexOf('planBuyerDeposit(');
  assert.ok(plan > -1, 'pending gate missing');
  assert.ok(gate > -1 && send > -1 && gate < send, 'gateExternalSend must run BEFORE sendMultiPayment');
  assert.ok(plan < send, 'PAY_PENDING gate must run before broadcast');
  const gateCall = dep.slice(gate, send);
  assert.match(gateCall, /kind:\s*'deposit'/);
  assert.match(gateCall, /expectedRecipients/);
  assert.match(dep, /effectiveLimits\(\)\.maxSendsPerJob/);
  assert.doesNotMatch(gateCall, /jobPrice:\s*amountNumber\s*,/,
    'autonomous deposit must not share the single-pay jobPrice === amount ceiling');
});

test('deposit JSON keeps the full txid; human line truncates to 16', () => {
  const dep = depositSrc();
  assert.match(dep, /substring\(0,\s*16\)/);
  const jsonBlock = dep.slice(dep.indexOf('ok: true'));
  assert.match(jsonBlock, /\btxid,/);
  assert.ok(!/txid:\s*String\(txid\)\.substring/.test(jsonBlock));
});

test('DEPOSIT_WAIT_TIMEOUT warns and does not set exitCode 1', () => {
  const dep = depositSrc();
  assert.match(dep, /DEPOSIT_WAIT_TIMEOUT/);
  const timeoutAt = dep.indexOf('DEPOSIT_WAIT_TIMEOUT');
  const after = dep.slice(timeoutAt, timeoutAt + 800);
  assert.doesNotMatch(after, /exitCode\s*=\s*1/);
  assert.match(CLI, /credited:\s*false/);
  assert.match(CLI, /pending:\s*true/);
});

test('report-deposit timeout copy does not claim a broadcast', () => {
  const rep = reportDepositSrc();
  assert.match(rep, /DEPOSIT_WAIT_TIMEOUT/);
  assert.doesNotMatch(rep, /deposit broadcast but seller/);
  assert.match(BUYER_DEPOSIT_SRC, /alreadyReported:\s*true/);
  assert.match(BUYER_DEPOSIT_SRC, /seller has not credited the deposit yet/);
});

test('fail paths set exitCode 1: REPLAY / NO_PUBLIC_URL / NOT_SELLER / PAY_PENDING', () => {
  const dep = depositSrc();
  assert.match(dep, /DEPOSIT_REPLAY/);
  assert.match(dep, /DEPOSIT_NO_PUBLIC_URL/);
  assert.match(dep, /DEPOSIT_NOT_SELLER/);
  assert.match(dep, /PAY_PENDING/);
  assert.match(dep, /process\.exitCode = 1/);
});

test('deposit --wait calls waitWalletPendingUnlink after saveWalletPending (clears stamp on confs)', () => {
  const dep = depositSrc();
  const save = dep.indexOf('saveWalletPending(');
  assert.ok(save > -1, 'deposit must stamp wallet-pending.json after broadcast');
  const waitAfter = dep.indexOf('waitWalletPendingUnlink(', save);
  assert.ok(waitAfter > save, 'deposit --wait must poll the NEW tx after saveWalletPending');
  // Unlink must run even when the seller report fails (SENDER_MISMATCH), before fail().
  const failAfterReport = dep.indexOf('if (!result.ok)', save);
  assert.ok(failAfterReport > waitAfter, 'waitWalletPendingUnlink must run before fail(result)');
});

test('SENDER_MISMATCH fail JSON keeps txid and credited:false (exit 1, no second send)', () => {
  const dep = depositSrc();
  // Fail after broadcast must pass credited:false with the txid — never pretend ok:true credited:true.
  const failAt = dep.indexOf('if (!result.ok)');
  assert.ok(failAt > -1, 'deposit must fail when report is not ok');
  const failBlock = dep.slice(failAt, failAt + 220);
  assert.match(failBlock, /fail\(/);
  assert.match(failBlock, /txid/);
  assert.match(failBlock, /credited:\s*false/);
  // Source pin: do not force a second broadcast of the same amount on mismatch.
  const send = dep.indexOf('sendMultiPayment(');
  const secondSend = dep.indexOf('sendMultiPayment(', send + 1);
  assert.equal(secondSend, -1, 'deposit must not second-send after SENDER_MISMATCH');
});

test('wallet send remains fleet-agent-id only and does not grow a deposit path', () => {
  const w = walletSendSrc();
  assert.match(w, /wallet send <from-agent> <to-agent> <amount>/);
  assert.doesNotMatch(w, /sendMultiPayment/);
  assert.doesNotMatch(w, /buildSignedDepositReport/);
  assert.match(CLI, /planFleetSend/);
});

test('deposit --amount is required (no silent default)', () => {
  const r = spawnSync(process.execPath, [CLI_PATH, 'deposit', 'buyer-1', 'seller@', '--yes', '--json'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.notEqual(r.status, 0);
});

test('report-deposit --help mentions --wait', () => {
  const r = spawnSync(process.execPath, [CLI_PATH, 'report-deposit', '--help'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--wait/);
  assert.match(r.stdout, /--txid/);
  assert.match(r.stdout, /--amount/);
});

test('spend-policy kind deposit is external (source pin)', () => {
  assert.match(SPEND_SRC, /EXTERNAL_KINDS = new Set\(\[[^\]]*['"]deposit['"]/);
  assert.match(SPEND_SRC, /KNOWN_KINDS = new Set\(\[[^\]]*['"]deposit['"]/);
});
