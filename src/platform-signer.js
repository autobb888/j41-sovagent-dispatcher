'use strict';
/**
 * Keys-endpoint trust pin (J41_PLATFORM_SIGNER / [platform] signer).
 *
 * SDK 2.16.1 treats https://api.junction41.io as mainnet even when the chain
 * is VRSCTEST. Unset pin → PLATFORM_SIGNER_REQUIRED. The platform fee R is
 * not the signer — that pin is KEYS_BAD_SIGNATURE (tester 2026-09-05).
 *
 * Live VRSCTEST (api.junction41.io, identity.signed-keys-v1, 2026-09-05):
 * RBgxQwD7mMLCfciTN68RjBQHsH68vcnUKb verifies GET /v1/identity/:id/keys.
 */
const TESTNET_PLATFORM_SIGNER = 'RBgxQwD7mMLCfciTN68RjBQHsH68vcnUKb';
const FEE_TANK_NOT_SIGNER = 'RAWwNeTLRg9urgnDPQtPyZ6NRycsmSY2J2';

function apiLooksLikeJunction41(apiUrl) {
  return /^https:\/\/(api\.)?junction41\.(io|com|net)/i.test(String(apiUrl || ''));
}

function planPlatformSigner({ apiUrl, network, signer } = {}) {
  const pin = String(signer || '').trim();
  const net = String(network || '').toLowerCase();
  const official = apiLooksLikeJunction41(apiUrl);
  const mainnet = net === 'verus';

  if (pin && pin === FEE_TANK_NOT_SIGNER) {
    return {
      ok: false,
      code: 'PLATFORM_SIGNER_NOT_FEE',
      signer: null,
      defaulted: false,
      testnetSigner: TESTNET_PLATFORM_SIGNER,
      message:
        'J41_PLATFORM_SIGNER is the platform fee address, not the keys-endpoint signer. ' +
        `That pin fails KEYS_BAD_SIGNATURE. Testnet pin is ${TESTNET_PLATFORM_SIGNER} ` +
        '([platform] signer in ~/.j41/dispatcher/config.toml).',
    };
  }

  if (pin) {
    return { ok: true, code: null, signer: pin, defaulted: false, testnetSigner: TESTNET_PLATFORM_SIGNER, message: null };
  }

  if (mainnet) {
    return {
      ok: false,
      code: 'PLATFORM_SIGNER_REQUIRED',
      signer: null,
      defaulted: false,
      testnetSigner: TESTNET_PLATFORM_SIGNER,
      message:
        'J41_PLATFORM_SIGNER is required on mainnet. Set [platform] signer to the keys-endpoint R-address. ' +
        'Do not use the platform fee address.',
    };
  }

  if (official) {
    return {
      ok: true,
      code: null,
      signer: TESTNET_PLATFORM_SIGNER,
      defaulted: true,
      testnetSigner: TESTNET_PLATFORM_SIGNER,
      message:
        `Using testnet keys-endpoint pin ${TESTNET_PLATFORM_SIGNER} ` +
        '(api.junction41.io is VRSCTEST; SDK 2.16.1 still treats that URL as mainnet). ' +
        'Persist with [platform] signer. Never pin the fee-tank R.',
    };
  }

  return {
    ok: true,
    code: null,
    signer: null,
    defaulted: false,
    testnetSigner: TESTNET_PLATFORM_SIGNER,
    message: null,
  };
}

function applyPlatformSigner(plan) {
  if (plan && plan.ok && plan.signer && !process.env.J41_PLATFORM_SIGNER) {
    process.env.J41_PLATFORM_SIGNER = plan.signer;
  }
  return plan;
}

module.exports = {
  TESTNET_PLATFORM_SIGNER,
  FEE_TANK_NOT_SIGNER,
  apiLooksLikeJunction41,
  planPlatformSigner,
  applyPlatformSigner,
};
