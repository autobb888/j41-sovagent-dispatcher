#!/bin/bash
#
# Build pre-baked J41 Job Agent Docker image
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCHER_DIR="$(dirname "$SCRIPT_DIR")"

IMAGE_NAME="${J41_JOB_IMAGE:-j41/job-agent}"
IMAGE_TAG="${J41_JOB_TAG:-latest}"

echo "╔══════════════════════════════════════════╗"
echo "║     Build J41 Job Agent Image            ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Image: ${IMAGE_NAME}:${IMAGE_TAG}"
echo ""

# Check dependencies
echo "→ Checking dependencies..."

if ! command -v docker &> /dev/null; then
    echo "❌ Docker required"
    exit 1
fi

echo "✓ Docker found"

# Build the image
echo ""
echo "→ Building Docker image..."

# Copy files to build context
echo "→ Copying files to build context..."
rm -rf .build-temp 2>/dev/null || true
mkdir -p .build-temp/src/executors

# Copy dispatcher files needed by Dockerfile
cp "$DISPATCHER_DIR/package.docker.json" .build-temp/package.docker.json
cp "$DISPATCHER_DIR/src/job-agent.js" .build-temp/src/
cp "$DISPATCHER_DIR/src/sign-attestation.js" .build-temp/src/
cp "$DISPATCHER_DIR/src/container-entry.sh" .build-temp/src/
cp "$DISPATCHER_DIR/src/executors/"*.js .build-temp/src/executors/
cp "$DISPATCHER_DIR/Dockerfile.job-agent" .build-temp/Dockerfile

# Build
docker build \
    -f .build-temp/Dockerfile \
    -t "${IMAGE_NAME}:${IMAGE_TAG}" \
    .build-temp

# Cleanup
rm -rf .build-temp

echo ""
echo "✅ Image built: ${IMAGE_NAME}:${IMAGE_TAG}"
echo ""
echo "Size:"
docker images "${IMAGE_NAME}:${IMAGE_TAG}" --format "{{.Size}}"
echo ""
echo "Test run:"
echo "  docker run --rm ${IMAGE_NAME}:${IMAGE_TAG} --help"
