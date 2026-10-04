'use strict';
/**
 * Public orchard response. A GET never returns rows. The dataset is delivered
 * on a paid job after the seller accepts. Query parameters do not unlock it.
 */

function publicOrchardCard() {
  return {
    hire: 'j41-dispatcher hire <buyer> pippinapples.agentplatform@ --amount <quoted price> --color <color> --kind <kind> --taste <taste> --q <text> --pay --yes',
    note: 'A GET without quote=1 returns this card and no rows. quote=1 counts the rows that match --color, --kind, --taste, and --q, and returns that count times the per-row price. It still returns no rows. A question with no rows is not a hire. hire --amount must be that price. The seller accepts, the buyer pays, and data-open returns the rows after the review window is set. Later pages are rows already paid for. complete ends the bearer.',
  };
}

module.exports = { publicOrchardCard };
