# Mac: deposit --wait then chat still does not credit (31fb027)

Buyer CLI was `31fb027`. Live refuse string is only emitted when
`verified: true && senderVerified: true && senderVerusId !== buyer`.
The 99216b4 R-rescue never ran on that payload.

Fix: run `resolveSenderViaPrimaryR` on that branch. GPU **seller** must
pull this commit — `/j41/deposit/report` is seller-side. Then
`report-deposit --txid` on the already-paid txs. Do not `deposit` another 0.05.
