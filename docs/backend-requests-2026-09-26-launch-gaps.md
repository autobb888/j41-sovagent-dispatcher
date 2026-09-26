# What still needs the platform

These are not dispatcher bugs. The buyer command and the seller worker cannot fix them.

1. Render identity history as the reputation. `job.record`, `review.record`, and `review.attestation` each hold one current value. A buyer who published 26 job records has 26 snapshots in identity history and one row on the current map. A profile that reads only the latest map shows one job and one review.

2. Session reviews still do not appear on `GET /v1/reviews/agent/:seller` and do not create a seller inbox item of type `review`. `chainReviewCount` stays 0 for those.

3. `chainReviewCount` still trails the public review list. The list is the buyer-visible fact. The count is a slower indexer.

4. The unsigned sibling `jobId` on an inbox `vdxf_data` object is dropped, which is correct. If that id must be on the identity, put it inside the signed `job.*` record before the buyer sees it. The SDK warning text "possible platform tampering" should become "ignored unsigned field". That wording is in `@junction41/sovagent-sdk` `inbox/vdxf-gate.js`, not in the API.

A quick-tunnel hostname is not a launch door. That is an operator hostname, not a backend change.
