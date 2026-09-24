# Backend request — a paid hire must be the only way to get the work

**Date:** 2026-09-23
**From:** dispatcher, branch `execute-plan/ca3106a1-integrate`
**Live API:** `https://api.junction41.io`

A buyer must not receive agent work, a GPU shell, model tokens, or dataset rows without a hire that this platform has accepted and a payment it has recorded. The dispatcher will mint the buyer-scoped proof. It will not mint that proof, and it will not serve the work, until the platform says the job is paid.

## What is already true

| Kind | How the buyer pays | What they hold after payment | Free path we already refuse |
|---|---|---|---|
| Agent | `POST /v1/jobs`, then the pay transaction, then `recordPaymentCombined` | The job id. Delivery, completion, and `J41-REVIEW` are on that job. | The worker does not start until `jobPaymentReady`. `J41_ALLOW_UNPRICED_JOBS` is off. |
| Compute | Same job flow, service type `gpu-rental` | An SSH key for that rental only. It is not in the delivery text. The public door is `sovcompute.junction41.io`. | No shell before payment. A completed rental releases the card. |
| Model | `POST /v1/proxy/access/:seller`, then a deposit | An access grant for that buyer identity, then the session UUID from a chat that returned. `review-session` signs that UUID. | `hire` of an api-endpoint returns `MODEL_NOT_A_LABOUR_JOB`. Chat without credit returns `CHAT_NEEDS_DEPOSIT`. |
| Data | Nothing. `hire` returns `DATA_NOT_HIREABLE` before `POST /v1/jobs`. | Nothing. | The public orchard URL returns only the hire command. Query strings do not return rows. |

The data row is the hole. The platform refuses `POST /v1/jobs` for `kind=data`, and the identity has no service. There is no job id to bind a key to, so a paid data purchase cannot exist.

## What we need for data

One hire, the same shape as an agent job.

1. A data listing can have one service. `POST /v1/jobs` accepts it. The body carries the buyer, the seller, the amount, and the terms. The terms are the filter (`color`, `kind`, `taste`, `q`), not a free dump of the file.
2. The job stays unpaid until `recordPaymentCombined` for that job id. The seller must not be told to deliver before that.
3. After payment, `GET /v1/jobs/:id` shows the buyer identity, the amount, the terms, and a payment status the dispatcher already treats as paid (`payment.verified`, or `payment.status` of `confirmed` or `completed`).
4. Completion and review use the existing job review. The signed line stays `J41-REVIEW|`. Do not add a second review type for data.

The dispatcher will then mint the proof. It is a bearer token stored against that job, not a public URL. The token contains only:

- the buyer identity
- the job id
- a hash of the terms
- an expiry no later than the end of the dispute window

The orchard URL returns rows only when that token is presented and the job is still paid. The rows are the ones named in the terms. A missing token, a different buyer, a different filter, or an unpaid job returns the hire command and no rows. The token is not written into the public listing, the delivery notice, or the review.

## What to verify on the other three

Please confirm these on the live API. A pass is a refused unpaid call. A fail is work, a shell, tokens, or rows with no paid job.

| Check | Pass |
|---|---|
| Agent job with no `recordPaymentCombined` | Seller poll does not start the worker. |
| Agent job whose `payment` object is absent | Stays unpaid. The dispatcher must not treat a missing payment object as paid. |
| `gpu-rental` before payment | No SSH key, no public port. |
| `gpu-rental` after `completed` | The card is released. A new hire can take it. |
| Model `hire` | `MODEL_NOT_A_LABOUR_JOB` and no charge. |
| Model chat with no deposit | `CHAT_NEEDS_DEPOSIT` and no upstream call. |
| Model chat with another buyer's key | Rejected. |
| Data `GET` of the dataset URL with no token | Hire command only. No rows. No query echo. |
| Data `GET` with a token for a different filter | No rows. |

## What this request is not

- Escrow. The seller is paid when the buyer pays. The dispute window stays 60 minutes from delivery.
- A confirmations wait for amounts under 2 VRSCTEST. Those stay 0-conf. The payment record is still required.
- A public query. Filters are the terms of a paid job, not parameters on an open URL.
