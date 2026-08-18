'use strict';
/**
 * @typedef {Object} Lease
 * @property {string} id  @property {string} provider
 * @property {'pending'|'ready'|'degraded'|'released'} state
 * @property {string|null} baseUrl  @property {{host:string,port:number,user:string}|null} ssh
 * @property {{name:string,vramGb:number,count:number}|null} gpu
 * @property {number} usdPerHour  @property {number} acquiredAt  @property {number|null} expiresAt
 * @property {boolean} private  @property {Object} meta
 *
 * @typedef {Object} Candidate @property {string} provider @property {Object} meta
 * @typedef {Object} HealthReport @property {boolean} healthy @property {string} [reason]
 */
class ComputeProvider {
  /** @returns {Promise<Candidate[]>} capacity that could satisfy spec */
  async discover(_spec) { throw new Error('not implemented'); }
  /** @returns {Promise<Lease>} claim a candidate; may cost money */
  async acquire(_candidate, _spec) { throw new Error('not implemented'); }
  /** @returns {Promise<Lease>} block until serving; populates lease.baseUrl */
  async waitReady(_lease, _opts) { throw new Error('not implemented'); }
  /** @returns {Promise<HealthReport>} is this lease still serving? */
  async probe(_lease) { throw new Error('not implemented'); }
  /** relinquish. MUST be idempotent — called from crash recovery. @returns {Promise<Lease>} */
  async release(_lease) { throw new Error('not implemented'); }
  /** @returns {{usdPerHour:number,source:'quoted'|'declared'}} */
  describeCost(_lease) { throw new Error('not implemented'); }
  /** @returns {{canProvision:boolean,canSsh:boolean,canScaleToZero:boolean,isElastic:boolean}} */
  get capabilities() { throw new Error('not implemented'); }
}
module.exports = { ComputeProvider };
