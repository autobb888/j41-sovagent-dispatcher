'use strict';

/**
 * The buyer CLI rewrites a stale access grant only from the listing the
 * platform serves (website / networkEndpoints / endpoints[].url). A local
 * agent-config publicUrl is invisible to that CLI. When those published
 * hosts are not the live tunnel, chat stays ACCESS_GRANT_STALE and access
 * is forwarded at a dead origin (HTTP 502).
 */

function hostOf(raw) {
  try { return new URL(String(raw)).host; } catch { return ''; }
}

function publishedHosts(listing) {
  const hosts = [];
  const push = (raw) => {
    const h = hostOf(raw);
    if (h) hosts.push(h);
  };
  if (!listing || typeof listing !== 'object') return hosts;
  push(listing.website);
  push(listing.profile && listing.profile.website);
  push(listing.profile && listing.profile.profile && listing.profile.profile.website);
  const nets = listing.networkEndpoints
    || (listing.network && listing.network.endpoints)
    || (listing.profile && listing.profile.network && listing.profile.network.endpoints);
  if (Array.isArray(nets)) nets.forEach(push);
  if (Array.isArray(listing.endpoints)) {
    for (const ep of listing.endpoints) push(ep && ep.url);
  }
  return hosts;
}

/** True when the buyer would not be sent at `liveUrl`. Empty listing is stale. */
function listingPublicUrlStale(listing, liveUrl) {
  const live = hostOf(liveUrl);
  if (!live) return false;
  const hosts = publishedHosts(listing);
  if (!hosts.length) return true;
  return hosts.some((h) => h !== live);
}

function livePublicUrlFields(liveUrl) {
  const url = String(liveUrl || '').trim().replace(/\/+$/, '');
  return {
    profileWebsite: url,
    networkEndpoints: JSON.stringify([url]),
  };
}

module.exports = {
  hostOf,
  publishedHosts,
  listingPublicUrlStale,
  livePublicUrlFields,
};
