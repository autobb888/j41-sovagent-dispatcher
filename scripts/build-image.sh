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
cp "$DISPATCHER_DIR/src/logger.js" .build-temp/src/
# logger.js requires config-loader.js (graceful-missing config.toml; reads
# DEFAULTS at top-level). Missing in older build scripts — caused the
# container to crash on import. Fixed here.
cp "$DISPATCHER_DIR/src/config-loader.js" .build-temp/src/
# Prompt-injection taint helper — required by the executors (local-llm.js, mcp.js).
cp "$DISPATCHER_DIR/src/sovguard-context.js" .build-temp/src/
# Broker mode runtime files (J41_SIGNING_BROKER=1). Always copied — the
# container code-path can run with broker off, but if broker is on the
# files must be present (job-agent.js requires them).
cp "$DISPATCHER_DIR/src/sign-channel-client.js" .build-temp/src/
cp "$DISPATCHER_DIR/src/job-signer.js" .build-temp/src/
cp "$DISPATCHER_DIR/src/executors/"*.js .build-temp/src/executors/
cp "$DISPATCHER_DIR/Dockerfile.job-agent" .build-temp/Dockerfile

# SDK source.
#
# Default (production): pulled from npm by the Dockerfile via the version
# pinned in package.docker.json. No local SDK staging.
#
# Override (development / broker validation pass): set J41_USE_LOCAL_SDK=1 to
# pack the sibling j41-sdk checkout into a tarball and install it instead.
# Used when the local SDK has changes that aren't on npm yet (e.g., the 2.4.0
# RemoteSigner branch). Revert by unsetting and rebuilding.
if [ "${J41_USE_LOCAL_SDK:-0}" = "1" ]; then
    SDK_DIR="${J41_SDK_DIR:-$DISPATCHER_DIR/../j41-sdk}"
    if [ ! -d "$SDK_DIR" ]; then
        echo "❌ J41_USE_LOCAL_SDK=1 but $SDK_DIR not found"
        exit 1
    fi
    echo "→ Packing local SDK from $SDK_DIR..."
    SDK_VERSION="$(node -p "require('$SDK_DIR/package.json').version")"
    (cd "$SDK_DIR" && npm pack --silent --pack-destination "$SCRIPT_DIR/../.build-temp" >/dev/null)
    # The tarball lands as junction41-sovagent-sdk-<ver>.tgz; rename to a
    # stable name for the Dockerfile to reference.
    mv .build-temp/junction41-sovagent-sdk-"$SDK_VERSION".tgz .build-temp/local-sdk.tgz
    # Rewrite package.docker.json's SDK dep to file:./local-sdk.tgz.
    node -e "
        const fs = require('fs');
        const pkg = JSON.parse(fs.readFileSync('.build-temp/package.docker.json','utf8'));
        pkg.dependencies['@junction41/sovagent-sdk'] = 'file:./local-sdk.tgz';
        fs.writeFileSync('.build-temp/package.docker.json', JSON.stringify(pkg, null, 2));
    "
    echo "✓ Using local SDK ${SDK_VERSION} (tarball)"
else
    # Placeholder so the unconditional COPY in Dockerfile.job-agent has
    # something to copy in the default (npm) case. It's deleted inside the
    # image after npm install runs.
    touch .build-temp/local-sdk.tgz
    echo "✓ Using npm SDK (per package.docker.json)"
fi

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
