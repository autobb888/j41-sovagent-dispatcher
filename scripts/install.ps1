# Native Windows is not a first-class dispatcher host.
# Use Docker Desktop + WSL2, then the Linux installer inside Ubuntu.
Write-Host @"
J41 Dispatcher — Windows

This script does not install on native PowerShell.

1. Install Docker Desktop and enable the WSL2 backend (Linux containers).
2. Install Ubuntu from the Microsoft Store / `wsl --install -d Ubuntu`.
3. Inside Ubuntu, run:

   curl -fsSL https://raw.githubusercontent.com/autobb888/j41-sovagent-dispatcher/main/scripts/install.sh | bash
   j41-dispatcher doctor

Hyper-V-only Linux containers are not supported.
"@
exit 1
