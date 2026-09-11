'use strict';
/**
 * Data listings are browse-only. Operators curl website / networkEndpoints,
 * not the marketplace blurb — so a description that names a dead tunnel
 * (pippinapples, 2026-09-06) is a product failure. RFC1918 here is dotted
 * quads, not the substring `10.`: "pippinapples — 10 apples JSON" is allowed.
 */

const { parseListingKind, kindFromIdentityName } = require('./listing-kind');

function descriptionHasEphemeralUrl(text) {
  const s = String(text || '');
  return /trycloudflare\.com/i.test(s)
    || /\bngrok\b/i.test(s)
    || /\blocalhost\b/i.test(s)
    || /\b127\.0\.0\.1\b/.test(s)
    || /\b10\.(?:\d{1,3}\.){2}\d{1,3}\b/.test(s)
    || /\b192\.168\.(?:\d{1,3}\.)\d{1,3}\b/.test(s)
    || /\b172\.(1[6-9]|2\d|3[0-1])\.(?:\d{1,3}\.)\d{1,3}\b/.test(s);
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
  isDataListing,
  refuseDataListingDescriptions,
};
