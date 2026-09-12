'use strict';
/**
 * Buyer deposit rail — plan, resolve /j41/deposit/report, sign, POST, --wait.
 * CLI is the impure rind (broadcast, keys, prompts). Never derive the report
 * origin from a NVIDIA grant; listing hints go through resolveListingDispatcherBase
 * (required /j41/health), not a minted-path tautology.
 */
const crypto = require('crypto');
const { planHirePayment } = require('./hire-pay');
const { parseVrscAmount, txConfirmations } = require('./wallet');
const { listingPublicUrlHint } = require('./buyer-access');
const {
  depositReportUrl,
  isDispatcherProxyBase,
  resolveListingDispatcherBase,
} = require('./buyer-proxy-url');

const DEPOSIT_WAIT_TIMEOUT_MS = 180000;
const DEPOSIT_POLL_INTERVAL_MS = 5000;

function depositNoPublicUrlMessage(buyer, seller) {
  const b = buyer || '<buyer>';
  const s = seller || '<seller>';
  return `No dispatcher /j41/deposit/report URL. Poll-only sellers cannot credit CLI deposits. ` +
    `Run: j41-dispatcher access ${b} ${s} — seller must set publicUrl / --webhook-url.`;
}

function parseDepositAmount(amountStr) {
  if (typeof amountStr !== 'string') {
    return { ok: false, code: 'BAD_AMOUNT', reason: '--amount is required (positive decimal string)' };
  }
  const parsed = parseVrscAmount(amountStr);
  if (!parsed.ok) return { ok: false, code: 'BAD_AMOUNT', reason: parsed.error };
  return { ok: true, amount: amountStr.trim(), sats: parsed.sats };
}

function resolveDepositDestination({ payInfo, listing, topupAddress } = {}) {
  const iAddress = payInfo && (payInfo.iAddress || payInfo.iaddress);
  if (!iAddress || typeof iAddress !== 'string') {
    return {
      ok: false,
      code: 'DEPOSIT_NOT_SELLER',
      reason: 'seller i-address is required; refusing R-address or 402 topupAddress as the spend destination',
    };
  }
  const expectedRecipients = [iAddress];
  const listingPay = listing && listing.payaddress;
  if (listingPay && listingPay === iAddress && !expectedRecipients.includes(listingPay)) {
    expectedRecipients.push(listingPay);
  }
  if (topupAddress && topupAddress === iAddress && !expectedRecipients.includes(topupAddress)) {
    expectedRecipients.push(topupAddress);
  }
  return { ok: true, toAddress: iAddress, iAddress, expectedRecipients };
}

function planBuyerDeposit({
  pending, now, force, backstopMs, toAddress, iAddress, sellerRAddress,
} = {}) {
  if (toAddress && iAddress && toAddress !== iAddress) {
    return {
      ok: false,
      code: 'DEPOSIT_NOT_SELLER',
      reason: 'deposit toAddress must be the seller i-address, not an R-address or 402 topupAddress',
    };
  }
  if (toAddress && sellerRAddress && toAddress === sellerRAddress && (!iAddress || toAddress !== iAddress)) {
    return {
      ok: false,
      code: 'DEPOSIT_NOT_SELLER',
      reason: 'deposit toAddress must be the seller i-address, not the R-address',
    };
  }
  return planHirePayment({ pending, now, force, backstopMs });
}

async function resolveDepositReportUrl({
  grant, listing, publicUrlHint, fetchImpl, buyerId, seller,
} = {}) {
  if (grant && grant.endpointUrl && isDispatcherProxyBase(grant.endpointUrl)) {
    try {
      return { ok: true, url: depositReportUrl(grant.endpointUrl), source: 'grant' };
    } catch {
      return { ok: false, code: 'DEPOSIT_NO_PUBLIC_URL', message: depositNoPublicUrlMessage(buyerId, seller) };
    }
  }
  const hint = publicUrlHint || listingPublicUrlHint(listing);
  if (!hint) {
    return { ok: false, code: 'DEPOSIT_NO_PUBLIC_URL', message: depositNoPublicUrlMessage(buyerId, seller) };
  }
  try {
    const minted = await resolveListingDispatcherBase(hint, {
      grant,
      fetchImpl,
      failCode: 'DEPOSIT_NO_PUBLIC_URL',
    });
    return { ok: true, url: depositReportUrl(minted), source: 'listing' };
  } catch (e) {
    return {
      ok: false,
      code: e.code || 'DEPOSIT_NO_PUBLIC_URL',
      message: e.message || depositNoPublicUrlMessage(buyerId, seller),
    };
  }
}

function buildSignedDepositReport({
  buyerVerusId, sellerVerusId, txid, amount, nonce, timestamp,
  wif, network, signMessage: signFn, buildMessage,
} = {}) {
  const n = nonce || crypto.randomBytes(16).toString('hex');
  const ts = timestamp != null ? timestamp : Math.floor(Date.now() / 1000);
  const build = buildMessage || ((params) => {
    const { buildDepositReportMessage } = require('@junction41/sovagent-sdk/dist/index.js');
    return buildDepositReportMessage(params);
  });
  const message = build({ buyerVerusId, sellerVerusId, txid, amount, nonce: n, timestamp: ts });
  let signature;
  if (typeof signFn === 'function') {
    signature = signFn(wif, message, network);
  } else {
    const { signMessage } = require('@junction41/sovagent-sdk/dist/index.js');
    signature = signMessage(wif, message, network);
  }
  return { buyerVerusId, sellerVerusId, txid, amount, nonce: n, timestamp: ts, signature, message };
}

function classifyDepositReport({ status, body } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const code = b.code || null;
  const message = String(b.message || b.error || '');
  if (b.credited === true) {
    return { kind: 'credited', accepted: true, credited: true, code, message, status, body: b };
  }
  if (/already processed/i.test(message)) {
    return { kind: 'already_processed', accepted: true, credited: true, code, message, status, body: b };
  }
  const replay = status === 409 || code === 'REPLAY' || /\bREPLAY\b/i.test(message);
  if (replay) {
    return { kind: 'replay', accepted: false, credited: false, code: code || 'REPLAY', message, status, body: b };
  }
  if (status === 200 && code !== 'BAD_SIGNATURE') {
    return { kind: 'pending', accepted: true, credited: false, code, message, status, body: b };
  }
  return {
    kind: 'error',
    accepted: false,
    credited: false,
    code: code || 'DEPOSIT_REPORT_FAILED',
    message,
    status,
    body: b,
  };
}

function asClassified(result) {
  if (result && typeof result.kind === 'string') return result;
  return classifyDepositReport(result);
}

async function postDepositReport(url, report, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      buyerVerusId: report.buyerVerusId,
      sellerVerusId: report.sellerVerusId,
      txid: report.txid,
      amount: report.amount,
      nonce: report.nonce,
      timestamp: report.timestamp,
      signature: report.signature,
    }),
  });
  let body = {};
  try { body = await res.json(); } catch { body = {}; }
  return classifyDepositReport({ status: res.status, body });
}

async function waitForDepositCredit({
  txid,
  amount,
  wait = false,
  timeoutMs = DEPOSIT_WAIT_TIMEOUT_MS,
  intervalMs = DEPOSIT_POLL_INTERVAL_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  requiredConfirmations: reqConf,
  txConfirmations: txConf,
  getTxStatus,
  postReport,
  buildReport,
} = {}) {
  if (typeof reqConf !== 'function') {
    reqConf = require('./deposit-watcher').requiredConfirmations;
  }
  if (typeof txConf !== 'function') {
    txConf = txConfirmations;
  }

  let first;
  try { first = asClassified(await postReport(await buildReport())); }
  catch (e) {
    return { ok: false, code: 'DEPOSIT_REPORT_FAILED', credited: false, pending: false, message: e.message };
  }
  if (first.kind === 'replay') {
    return { ok: false, code: 'DEPOSIT_REPLAY', credited: false, pending: false, message: first.message };
  }
  if (first.kind === 'error') {
    return {
      ok: false,
      code: first.code || 'DEPOSIT_REPORT_FAILED',
      credited: false,
      pending: false,
      message: first.message,
    };
  }
  if (first.kind === 'credited' || first.kind === 'already_processed') {
    return { ok: true, code: null, credited: true, pending: false, report: first };
  }
  if (!wait) {
    return { ok: true, code: null, credited: false, pending: true, report: first };
  }

  const required = reqConf(Number(amount));
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    let confs = 0;
    if (typeof getTxStatus === 'function') {
      try { confs = txConf(await getTxStatus(txid)); } catch { confs = 0; }
    }
    if (confs >= required) break;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  let second;
  try { second = asClassified(await postReport(await buildReport())); }
  catch {
    return {
      ok: true,
      code: 'DEPOSIT_WAIT_TIMEOUT',
      credited: false,
      pending: true,
      message: 'DEPOSIT_WAIT_TIMEOUT: seller has not credited the deposit yet.',
    };
  }
  if (second.kind === 'credited' || second.kind === 'already_processed') {
    return { ok: true, code: null, credited: true, pending: false, report: second };
  }
  if (second.kind === 'replay') {
    // Spec: success (exit 0, do not re-spend) after an accepted report this
    // invocation — not a claim that the meter credited. First POST may have
    // been only pending / waiting-for-confs.
    return {
      ok: true,
      code: null,
      credited: false,
      pending: false,
      alreadyReported: true,
      report: second,
    };
  }
  // Seller hard refuse (SENDER_MISMATCH / BAD_SIGNATURE / …) must not look like
  // a soft wait timeout — money moved, credit will not land from re-POSTing.
  if (second.kind === 'error') {
    return {
      ok: false,
      code: second.code || 'DEPOSIT_REPORT_FAILED',
      credited: false,
      pending: false,
      message: second.message,
      report: second,
    };
  }
  return {
    ok: true,
    code: 'DEPOSIT_WAIT_TIMEOUT',
    credited: false,
    pending: true,
    message: 'DEPOSIT_WAIT_TIMEOUT: seller has not credited the deposit yet.',
    report: second,
  };
}

module.exports = {
  depositNoPublicUrlMessage,
  parseDepositAmount,
  resolveDepositDestination,
  planBuyerDeposit,
  resolveDepositReportUrl,
  buildSignedDepositReport,
  classifyDepositReport,
  postDepositReport,
  waitForDepositCredit,
  DEPOSIT_WAIT_TIMEOUT_MS,
  DEPOSIT_POLL_INTERVAL_MS,
};
