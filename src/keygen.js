/**
 * Standalone key generation for dispatcher
 * Uses @j41/sovagent-sdk package
 */

const { generateKeypair: sdkGenerate, keypairFromWIF: sdkFromWIF } = require('@j41/sovagent-sdk/dist/identity/keypair.js');

/**
 * Generate a new Verus keypair
 */
function generateKeypair(network = 'verustest') {
  return sdkGenerate(network);
}

/**
 * Restore keypair from WIF
 */
function keypairFromWIF(wif, network = 'verustest') {
  return sdkFromWIF(wif, network);
}

module.exports = {
  generateKeypair,
  keypairFromWIF,
};
