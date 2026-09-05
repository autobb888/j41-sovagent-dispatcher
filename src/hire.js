'use strict';
/**
 * Buyer-side hire. The dispatcher was seller-only (accept-job, refunds,
 * rental-setup). Terminal access to J41 includes hiring: this module is the
 * gate the CLI/TUI run before SDK createJob, mirroring junction41
 * assertJobHireAllowed so we fail locally on data listings instead of after
 * a signed POST /v1/jobs.
 */
const { parseListingKind } = require('./listing-kind');

function assertHireAllowed({ sellerKind, serviceType, serviceId }) {
  const kind = parseListingKind(sellerKind);
  if (!kind) {
    return {
      ok: false,
      code: 'SELLER_KIND_UNKNOWN',
      message: 'Seller listing_kind is missing; refusing hire (no agent default).',
    };
  }
  if (kind === 'data') {
    return {
      ok: false,
      code: 'DATA_NOT_HIREABLE',
      message: 'Data listings are browse-only. POST /v1/jobs refuses kind=data.',
    };
  }
  if (kind === 'compute') {
    if (!serviceId || serviceType !== 'gpu-rental') {
      return {
        ok: false,
        code: 'COMPUTE_REQUIRES_GPU_RENTAL',
        message: 'Compute listings are hired as gpu-rental jobs, not labour and not api-endpoint.',
      };
    }
    return { ok: true };
  }
  if (kind === 'model' || serviceType === 'api-endpoint') {
    return {
      ok: false,
      code: 'MODEL_NOT_A_LABOUR_JOB',
      message: 'Model / api-endpoint listings are metered inference, not labour jobs. Use POST /v1/proxy/access/:sellerVerusId — dispatcher hire will not POST /v1/jobs.',
    };
  }
  return { ok: true };
}

function isVerusAddr(s) {
  return typeof s === 'string' && /^[Ri][1-9A-HJ-NP-Za-km-z]{25,40}$/.test(s);
}

/**
 * Dual-output payment the platform records after createJob.
 * Same checks as SDK BuyerSession.start — refuse a doctored fee.
 */
function paymentOutputs(job, amount) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error('HIRE_BAD_AMOUNT: amount must be a positive number');
  }
  const payAddr = job && job.payment && job.payment.address;
  if (!payAddr) {
    throw new Error('No payment address on job — backend may not have resolved seller R-address');
  }
  if (!isVerusAddr(payAddr)) {
    throw new Error(`Refusing to pay job: malformed payment address ${payAddr}`);
  }
  const outputs = [{ address: payAddr, amount: amt }];
  const feeAddr = job.payment.platformFeeAddress;
  const feeAmt = job.payment.feeAmount;
  if (feeAddr != null || feeAmt != null) {
    if (!isVerusAddr(feeAddr) || !Number.isFinite(feeAmt) || feeAmt <= 0 || feeAmt > amt) {
      throw new Error(`Refusing to pay implausible/malformed platform fee (amount=${feeAmt}, job=${amt}).`);
    }
    outputs.push({ address: feeAddr, amount: feeAmt });
  }
  return outputs;
}

function localBuyers(ids, loadKeys) {
  const out = [];
  for (const id of ids || []) {
    let keys;
    try { keys = loadKeys(id); } catch { continue; }
    if (!keys) continue;
    out.push({
      buyerAgentId: id,
      identity: keys.identity || null,
      iAddress: keys.iAddress || null,
      kind: keys.kind || 'agent',
      canHire: !!(keys.identity && keys.wif && keys.address),
    });
  }
  return out;
}

const SERVICE_TYPES = Object.freeze(['agent', 'gpu-rental', 'api-endpoint']);

function parseServiceType(raw) {
  return SERVICE_TYPES.includes(raw) ? raw : null;
}

function defaultServiceTypeForKind(kind) {
  if (kind === 'compute') return 'gpu-rental';
  if (kind === 'model') return 'api-endpoint';
  if (kind === 'agent') return 'agent';
  return undefined;
}

function listingNext(gate) {
  if (gate && gate.ok) return 'hire';
  if (gate && gate.code === 'MODEL_NOT_A_LABOUR_JOB') return 'access';
  return 'browse';
}

function listingRowFromService(s) {
  const kind = s.kind || 'agent';
  const serviceType = s.serviceType || 'agent';
  const gate = assertHireAllowed({
    sellerKind: kind,
    serviceType,
    serviceId: s.id,
  });
  return {
    hireable: !!gate.ok,
    refuseCode: gate.ok ? null : gate.code,
    next: listingNext(gate),
    kind,
    seller: s.verusId || s.agentId,
    qualifiedName: s.qualifiedName || s.agentName || null,
    serviceId: s.id,
    serviceType,
    price: s.price,
    currency: s.currency || null,
    name: s.name || null,
  };
}

function listingRowFromDataAgent(a) {
  return {
    hireable: false,
    refuseCode: 'DATA_NOT_HIREABLE',
    next: 'browse',
    kind: 'data',
    seller: a.id || a.verusId,
    qualifiedName: a.qualifiedName || a.name || null,
    serviceId: null,
    serviceType: null,
    price: null,
    currency: null,
    name: a.name || null,
  };
}

async function fetchDataAgentRows({ base, lim, doFetch }) {
  const u = new URL(`${base}/v1/agents`);
  u.searchParams.set('status', 'active');
  u.searchParams.set('kind', 'data');
  u.searchParams.set('limit', String(lim));
  const res = await doFetch(u);
  if (!res.ok) throw new Error(`listings HTTP ${res.status}`);
  const body = await res.json();
  return {
    rows: (body.data || []).map(listingRowFromDataAgent),
    total: body.meta && body.meta.total,
  };
}

async function fetchMarketplaceListings({
  apiUrl, kind, serviceType, q, limit = 100, fetchImpl,
} = {}) {
  const base = String(apiUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('API URL missing');
  const lim = Math.min(Math.max(parseInt(String(limit), 10) || 100, 1), 100);
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('fetch is not available');

  const k = kind ? parseListingKind(kind) : null;
  if (kind && !k) throw new Error('INVALID_KIND: kind must be agent, compute, data, or model');
  if (serviceType && !parseServiceType(serviceType)) {
    throw new Error('INVALID_SERVICE_TYPE: serviceType must be agent, gpu-rental, or api-endpoint');
  }
  if (k === 'data') {
    const data = await fetchDataAgentRows({ base, lim, doFetch });
    return { rows: data.rows, total: data.total, browseOnly: true };
  }

  const u = new URL(`${base}/v1/services`);
  u.searchParams.set('status', 'active');
  u.searchParams.set('limit', String(lim));
  if (k) u.searchParams.set('kind', k);
  const st = serviceType || defaultServiceTypeForKind(k);
  if (st) u.searchParams.set('serviceType', st);
  if (q) u.searchParams.set('q', q);
  const res = await doFetch(u);
  if (!res.ok) throw new Error(`listings HTTP ${res.status}`);
  const body = await res.json();
  const serviceRows = (body.data || []).map(listingRowFromService);

  if (!k) {
    let dataRows = [];
    let dataTotal = 0;
    try {
      const data = await fetchDataAgentRows({ base, lim, doFetch });
      dataRows = data.rows;
      dataTotal = data.total != null ? data.total : dataRows.length;
    } catch {
      dataRows = [];
    }
    const serviceTotal = body.meta && body.meta.total;
    return {
      rows: serviceRows.concat(dataRows),
      total: (serviceTotal != null ? serviceTotal : serviceRows.length) + dataTotal,
      browseOnly: false,
    };
  }

  return { rows: serviceRows, total: body.meta && body.meta.total, browseOnly: false };
}

module.exports = {
  assertHireAllowed,
  paymentOutputs,
  isVerusAddr,
  localBuyers,
  defaultServiceTypeForKind,
  parseServiceType,
  SERVICE_TYPES,
  listingRowFromService,
  listingRowFromDataAgent,
  fetchMarketplaceListings,
};
