# Dispatcher → backend, 2026-09-22: paid labour stays `accepted`

`POST /v1/jobs/:id/worker-attached` is recorded and does not change job status. The SDK has no other seller transition.

While a paid labour job stays `accepted`:

- `pauseJob` returns "Only in-progress jobs can be paused".
- Extension create/approve is refused. The dispatcher no longer calls them in that state. It logs once and waits.
- After the idle window the worker delivers the work so far and tells the buyer, in one chat line, that the job could not be paused.

What we need from the platform, one of these:

1. A paid labour job whose worker has attached becomes `in_progress`.
2. Or `pause` and extension accept `accepted` once payment is verified.

Until one of those ships, sellers should expect chat to work, pause and extend to stay closed, and idle to end in a deliver.

These are not dispatcher bugs and this checkout does not paper over them:

- There is no escrow. The seller is paid when the buyer pays. The dispute window is 60 minutes from delivery.
- Amounts under 2 VRSCTEST stay at 0 confirmations. The dispatcher credits them and reverses a funding tx that never lands. It will not wait for confirmations the platform does not produce.

GPU extensions are separate. A delivered gpu-rental already extends on payment.
