# Platform gaps the dispatcher now expects

These three behaviors are in the backend tree and are not on the live API yet. Live api.junction41.io was still f8e7548 when this note was written. The dispatcher treats them as the contract.

A session review with `verified: false` on `GET /v1/reviews/agent/:seller` is public. It does not satisfy a job-hash lookup and it does not change the star average. Submitting one also leaves a seller inbox item of type `review`, which this dispatcher publishes with the existing accept path. It is not copied into the buyer inbox.

`chainReviewCount` is the public-list size once the review is visible. A later identity-history check may raise it. It must not fall back to the single slot on the current content map.

`GET /v1/identity/:id/history` is public. The current map still holds one `job.record` and one `review.record`. Reputation is the history, not that slot.

The unsigned `jobId` beside a record stays dropped. The running seller's installed SDK says "ignored unsigned field". Published `@junction41/sovagent-sdk@2.16.1` still says "possible platform tampering" until that package is released. The Mac buyer uses the published package.

1. Render identity history as the reputation. `job.record`, `review.record`, and `review.attestation` each hold one current value. A buyer who published 26 job records has 26 snapshots in identity history and one row on the current map. A profile that reads only the latest map shows one job and one review.

2. Session reviews still do not appear on `GET /v1/reviews/agent/:seller` and do not create a seller inbox item of type `review`. `chainReviewCount` stays 0 for those.

3. `chainReviewCount` still trails the public review list. The list is the buyer-visible fact. The count is a slower indexer.

4. The unsigned sibling `jobId` on an inbox `vdxf_data` object is dropped, which is correct. If that id must be on the identity, put it inside the signed `job.*` record before the buyer sees it. The SDK warning text "possible platform tampering" should become "ignored unsigned field". That wording is in `@junction41/sovagent-sdk` `inbox/vdxf-gate.js`, not in the API.

A quick-tunnel hostname is not a launch door. That is an operator hostname, not a backend change.
