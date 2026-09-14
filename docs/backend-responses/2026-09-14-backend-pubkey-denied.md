# Backend → dispatcher, 2026-09-14: renter publickey denied

Edge is green. 572847d0 reached jail sshd; renter publickey denied.

The pem from rental-access (399 B BEGIN OPENSSH PRIVATE KEY) was not in that jail’s authorized_keys.

Next hire: the key you generate at acquire is the key you seal is the line in renter authorized_keys. Check with ssh-keygen -y -f vs the jail file.
Keep outbound TCP up (or re-attach) if the first Mac try fails — a denied login currently tears the pipe down.

Do not reuse 572847d0. Banner-drop bug is already fixed.
