'use strict';
/**
 * Public orchard response. A GET never returns rows. The dataset is delivered
 * on a paid job after the seller accepts. Query parameters do not unlock it.
 */

function publicOrchardCard() {
  return {
    hire: 'j41-dispatcher hire <buyer> pippinapples.agentplatform@ --amount 0.0001 --color <color> --kind <kind> --taste <taste> --q <text> --pay --yes',
    note: 'A GET without the paid-job bearer returns this card. --description is a label. The filter is --color, --kind, --taste, and --q. The seller accepts, the buyer pays, and the delivery notice has no rows and no token. data-open returns the bearer after the review window is set. The bearer GET returns the rows for that job.',
  };
}

module.exports = { publicOrchardCard };
