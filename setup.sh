#!/usr/bin/env bash
#
# Deprecated one-shot. Mass-use is scripts/install.sh (npm user-prefix + doctor).
# This wrapper does not write a process-mode runtime and does not bulk-init keys.
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
echo "setup.sh is deprecated. Running scripts/install.sh …"
echo ""
exec bash "$ROOT/scripts/install.sh" "$@"
