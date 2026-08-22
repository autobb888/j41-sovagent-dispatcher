#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCHER_DIR="$(dirname "$SCRIPT_DIR")"
IMAGE_NAME="${J41_JAIL_IMAGE:-j41/gpu-jail}"
IMAGE_TAG="${J41_JAIL_TAG:-latest}"
df="$DISPATCHER_DIR/Dockerfile.gpu-jail"
if [ ! -f "$df" ]; then
  echo "❌ Dockerfile.gpu-jail not found at $df"
  exit 1
fi
docker build -f "$df" -t "${IMAGE_NAME}:${IMAGE_TAG}" "$DISPATCHER_DIR"
echo "✓ ${IMAGE_NAME}:${IMAGE_TAG}"
