#!/bin/bash
# NOTE: This script is not used by the default Dockerfile.job-agent entrypoint.
# J41 Container Entrypoint — Privacy Attestation + OpenClaw Gateway
#
# 1. Signs creation attestation (proof container was created)
# 2. Starts OpenClaw gateway (HTTP endpoint for chat completions)
# 3. On SIGTERM, signs deletion attestation before exit

set -e

echo "╔══════════════════════════════════════════╗"
echo "║     J41 Ephemeral Agent Container        ║"
echo "║     OpenClaw Gateway + Attestation        ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Sign creation attestation (if keys and job data available)
if [ -f /app/keys.json ] && [ -d /app/job ]; then
  echo "→ Signing creation attestation..."
  node /app/sign-attestation.js creation || echo "⚠️ Creation attestation failed (non-fatal)"
  echo ""
fi

# Trap SIGTERM to sign deletion attestation before exit
cleanup() {
  echo ""
  echo "→ Container stopping, signing deletion attestation..."
  if [ -f /app/keys.json ] && [ -d /app/job ]; then
    node /app/sign-attestation.js deletion || echo "⚠️ Deletion attestation failed (non-fatal)"
  fi
  echo "🏁 Container shutdown complete."
  exit 0
}
trap cleanup SIGTERM SIGINT

# Start OpenClaw gateway
echo "→ Starting OpenClaw gateway on port 18789..."
if [ -f /app/openclaw/openclaw.mjs ]; then
  exec node /app/openclaw/openclaw.mjs gateway --port 18789 --bind lan &
  OPENCLAW_PID=$!
  echo "✅ OpenClaw gateway started (PID $OPENCLAW_PID)"

  # Wait for the process (and handle signals)
  wait $OPENCLAW_PID
else
  echo "❌ OpenClaw not found at /app/openclaw/openclaw.mjs"
  echo "   Mount it via: -v /usr/lib/node_modules/openclaw:/app/openclaw:ro"

  echo "→ openclaw.mjs not found, exiting"
  exit 1
fi
