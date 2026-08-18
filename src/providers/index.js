'use strict';
// Compute-provider registry. A provider becomes a drop-in by registering a factory
// here (or from its own module) — no shared switch to patch. See docs/superpowers/
// plans/2026-08-18-s5-compute-provider-seam.md.
const registry = new Map();

function registerProvider(type, factory) { registry.set(type, factory); }

function createProvider(type, cfg) {
  const f = registry.get(type);
  if (!f) throw new Error(`unknown compute provider: ${type}`);
  return f(cfg);
}

function listProviderTypes() { return [...registry.keys()]; }

// Built-in providers self-register on require (see the requires below, added
// per-provider). Placed after module.exports to avoid a circular-load hazard.
module.exports = { registerProvider, createProvider, listProviderTypes };

const { LocalProvider } = require('./local');
registerProvider('local', (cfg) => new LocalProvider(cfg));

const { VastProvider } = require('./vast');
registerProvider('vast', (cfg) => new VastProvider(cfg));
