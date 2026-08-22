'use strict';
const { assertRentalEligibleAgent, assertProviderCanSsh } = require('./rental-job');
const { createProvider } = require('./providers');
const { assertTunnelHostname } = require('./providers/home-gpu');

function providerCfgForAgent(cfg, agentId) {
  const tables = (cfg.compute && cfg.compute.providers) || {};
  return Object.entries(tables).find(([, p]) => p && p.agent_id === agentId) || null;
}

function slotServicesFromAgentConfig(config) {
  if (!config || typeof config !== 'object') return [];
  if (config.serviceType) return [{ serviceType: config.serviceType }];
  if (config.rental) return [{ serviceType: 'gpu-rental' }];
  if (config.apiEndpointUrl || config.endpointUrl) return [{ serviceType: 'api-endpoint' }];
  return [];
}

function applyRentalAgentConfig(existing, { ackPostpayVastRisk } = {}) {
  const next = Object.assign({}, existing && typeof existing === 'object' ? existing : {}, {
    rental: true,
    serviceType: 'gpu-rental',
  });
  if (ackPostpayVastRisk) next.rentalAckPostpayVastRisk = true;
  return next;
}

function assertRentalSetupAllowed({ agentId, cfg, services, paymentTerms, ackPostpayVastRisk }) {
  assertRentalEligibleAgent(services);
  const found = providerCfgForAgent(cfg, agentId);
  if (!found) throw new Error('RENTAL_NO_PROVIDER: declare [compute.providers.*] with agent_id=' + agentId);
  const [name, pcfg] = found;
  if (pcfg.type === 'local') throw new Error('RENTAL_NO_SSH: local is Cat-2 inference; use home-gpu for a jail or vast for a sourced box');
  // Tunnel check before createProvider so HOME_GPU_NO_TUNNEL wins over a dockerode constructor error.
  if (pcfg.type === 'home-gpu') assertTunnelHostname(pcfg.ssh_hostname);
  const provider = createProvider(pcfg.type, { id: name, ...pcfg });
  assertProviderCanSsh(provider);
  if (pcfg.type === 'vast' && paymentTerms === 'postpay' && !ackPostpayVastRisk) {
    throw new Error('VAST_POSTPAY_UNACKED: a Vast box starts billing Alice before the buyer pays. Pass --ack-postpay-vast-risk or use prepay.');
  }
  return { providerName: name, pcfg, provider };
}

function rentalServiceDescription({ jobTimeoutMin = 60, paymentTerms, vastPostpayAck }) {
  let d = `Raw GPU rental. Runs up to ${jobTimeoutMin} minutes. Billing is all-or-nothing: there is no pro-rata refund for unused time and the box is released at expiry.`;
  if (paymentTerms === 'postpay' && vastPostpayAck) {
    d += ' Seller sources this box from Vast.ai: if you do not pay, the seller still owes Vast.';
  }
  return d;
}

module.exports = {
  assertRentalSetupAllowed,
  rentalServiceDescription,
  providerCfgForAgent,
  slotServicesFromAgentConfig,
  applyRentalAgentConfig,
};
