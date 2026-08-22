'use strict';
/**
 * Write a [compute.providers.*] table into dispatcher config.toml.
 * Does not create the TCP tunnel — ssh_hostname is the tunnel hostname the
 * operator already pointed at 127.0.0.1:ssh_tunnel_port.
 */
const { assertTunnelHostname, assertTunnelPort, assertJailResources } = require('./providers/home-gpu');

function tableNameForAgent(agentId, providers) {
  const slug = String(agentId || 'card').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32) || 'card';
  const tables = providers || {};
  const existing = Object.entries(tables).find(([, p]) => p && p.agent_id === agentId);
  if (existing) return existing[0];
  if (!tables[slug]) return slug;
  let i = 2;
  while (tables[`${slug}_${i}`]) i++;
  return `${slug}_${i}`;
}

function providerBoundToAgent(providers, agentId) {
  const tables = providers || {};
  return Object.entries(tables).find(([, p]) => p && p.agent_id === agentId) || null;
}

function homeGpuProviderPartial(agentId, fields, existingProviders) {
  const name = tableNameForAgent(agentId, existingProviders);
  const ssh_hostname = assertTunnelHostname(fields.ssh_hostname);
  const ssh_tunnel_port = assertTunnelPort(fields.ssh_tunnel_port);
  const { memoryMb, diskGb } = assertJailResources({
    memory_mb: fields.memory_mb,
    disk_gb: fields.disk_gb,
  });
  return {
    tableName: name,
    partial: {
      compute: {
        enabled: true,
        default_provider: 'home-gpu',
        providers: {
          [name]: {
            type: 'home-gpu',
            agent_id: agentId,
            gpu: fields.gpu || 'GPU',
            vram_gb: Number(fields.vram_gb) || 0,
            gpu_count: Number(fields.gpu_count) || 1,
            device_index: Number(fields.device_index) || 0,
            memory_mb: memoryMb,
            disk_gb: diskGb,
            usd_per_hour: 0,
            ssh_hostname,
            ssh_tunnel_port,
            jail_image: fields.jail_image || 'j41/gpu-jail:latest',
          },
        },
      },
    },
  };
}

function vastProviderPartial(agentId, fields, existingProviders) {
  const name = tableNameForAgent(agentId, existingProviders);
  const api_key = String(fields.api_key || '').trim();
  if (!api_key) throw new Error('VAST_NO_KEY: api_key is required');
  const min_vram_gb = Number(fields.min_vram_gb);
  if (!Number.isFinite(min_vram_gb) || min_vram_gb < 1) {
    throw new Error('VAST_NO_VRAM: min_vram_gb must be >= 1');
  }
  return {
    tableName: name,
    partial: {
      compute: {
        enabled: true,
        default_provider: 'vast',
        max_usd_per_hour: Number(fields.max_usd_per_hour) > 0 ? Number(fields.max_usd_per_hour) : 1,
        providers: {
          [name]: {
            type: 'vast',
            agent_id: agentId,
            api_key,
            min_vram_gb,
            min_gpu_count: Number(fields.min_gpu_count) || 1,
            interruptible: false,
          },
        },
      },
    },
  };
}

module.exports = {
  tableNameForAgent,
  providerBoundToAgent,
  homeGpuProviderPartial,
  vastProviderPartial,
};
