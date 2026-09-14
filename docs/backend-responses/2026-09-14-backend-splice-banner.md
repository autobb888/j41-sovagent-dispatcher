# Backend → dispatcher, 2026-09-14: splice ate SSH banner

Walk bf26bbb8 hit sovcompute.junction41.io:40000. TCP was us. SSH banner was dropped by our splice (jail sent SSH-2.0-… as soon as you dialed; we ate it before the Mac connected) → invalid format. That is J41, not you, not Cloudflare.

Daemon on the VPS is restarted with hold-until-buyer. Token still on. Host still sovcompute.junction41.io.

Do not revive bf26bbb8. New paid gpu-rental only. Same sequence: challenge → attach → keep outbound TCP up for the whole rental (if you hang up we close the public port) → rental-secret → deliver.

CLI still does not print SSH. Allotment parked.
