'use strict';
/**
 * Data listings are browse-only. Operators curl website / networkEndpoints,
 * not the marketplace blurb — so a description that names a dead tunnel
 * (pippinapples, 2026-09-06) is a product failure. RFC1918 here is dotted
 * quads, not the substring `10.`: "pippinapples — 10 apples JSON" is allowed.
 */

const net = require('net');
const { parseListingKind, kindFromIdentityName } = require('./listing-kind');

function descriptionHasEphemeralUrl(text) {
  const s = String(text || '');
  return /trycloudflare\.com/i.test(s)
    || /\bngrok\b/i.test(s)
    || /\blocalhost\b/i.test(s)
    || /\b127\.(?:\d{1,3}\.){2}\d{1,3}\b/.test(s)
    || /\b0\.0\.0\.0\b/.test(s)
    || /\b169\.254\.(?:\d{1,3}\.)\d{1,3}\b/.test(s)
    || /\b10\.(?:\d{1,3}\.){2}\d{1,3}\b/.test(s)
    || /\b192\.168\.(?:\d{1,3}\.)\d{1,3}\b/.test(s)
    || /\b172\.(1[6-9]|2\d|3[0-1])\.(?:\d{1,3}\.)\d{1,3}\b/.test(s);
}

// Private, loopback, and link-local hosts. A published quick-tunnel name is
// not private: data-setup still refuses a new tunnel, but browse must be able
// to GET the URL the catalogue already stored.
function blockedDataHost(hostname) {
  const h = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === 'metadata.google.internal') return true;
  if (/\b127\.(?:\d{1,3}\.){2}\d{1,3}\b/.test(h)) return true;
  if (h === '0.0.0.0' || /\b169\.254\.(?:\d{1,3}\.)\d{1,3}\b/.test(h)) return true;
  if (/\b10\.(?:\d{1,3}\.){2}\d{1,3}\b/.test(h)) return true;
  if (/\b192\.168\.(?:\d{1,3}\.)\d{1,3}\b/.test(h)) return true;
  if (/\b172\.(1[6-9]|2\d|3[0-1])\.(?:\d{1,3}\.)\d{1,3}\b/.test(h)) return true;
  if (net.isIP(h) === 6) {
    if (h === '::1' || h === '::' || h.startsWith('fe80:') || /^f[cd][0-9a-f]{0,2}:/.test(h)) return true;
  }
  return false;
}

function refuseDataListingUrls({ kind, identity, urls } = {}) {
  if (!isDataListing(kind, identity)) return null;
  for (const raw of urls || []) {
    if (!raw) continue;
    let host = '';
    try { host = new URL(String(raw)).hostname; } catch { host = String(raw); }
    if (descriptionHasEphemeralUrl(String(raw)) || blockedDataHost(host)) {
      const err = new Error(
        'DESCRIPTION_EPHEMERAL_URL: data listing URLs cannot be tunnel, LAN, loopback, or link-local. Use a stable public HTTP(S) website.'
      );
      err.code = 'DESCRIPTION_EPHEMERAL_URL';
      return err;
    }
  }
  return null;
}

function isDataListing(kind, identity) {
  if (parseListingKind(kind) === 'data') return true;
  return kindFromIdentityName(identity) === 'data';
}

function refuseDataListingDescriptions({ kind, identity, descriptions } = {}) {
  if (!isDataListing(kind, identity)) return null;
  for (const text of descriptions || []) {
    if (!text) continue;
    if (descriptionHasEphemeralUrl(text)) {
      const err = new Error(
        'DESCRIPTION_EPHEMERAL_URL: data listing descriptions cannot hold tunnel or LAN URLs. Put the live URL in --profile-website / --network-endpoints only.'
      );
      err.code = 'DESCRIPTION_EPHEMERAL_URL';
      return err;
    }
  }
  return null;
}

module.exports = {
  descriptionHasEphemeralUrl,
  blockedDataHost,
  isDataListing,
  refuseDataListingDescriptions,
  refuseDataListingUrls,
};
