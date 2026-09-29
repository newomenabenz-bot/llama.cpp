#!/usr/bin/env bash
# ==============================================================================
# Llama Workbench Release Packaging Pipeline (POSIX Bash)
# Builds Web UI, compiles native llama-server with embedded UI, assemblies
# the standalone release structure, and compresses the final deployment archive.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "================================================================================"
echo "LLAMA WORKBENCH PACKAGING PIPELINE (DIR-DEPLOY-01)"
echo "Target: Standalone Self-Contained Deployment Distribution"
echo "================================================================================"

# ------------------------------------------------------------------------------
# STEP 1: Prerequisite Verification
# ------------------------------------------------------------------------------
echo "[1/6] Verifying toolchain prerequisites..."

check_cmd() {
	local cmd="$1"
	local desc="$2"
	if ! command -v "$cmd" >/dev/null 2>&1; then
		echo "[ERROR] Required prerequisite '$cmd' ($desc) not found on PATH." >&2
		exit 1
	fi
}

check_cmd cmake "CMake build system (>= 3.14 required)"
check_cmd node "Node.js runtime (>= 18 required)"
check_cmd npm "Node package manager"
check_cmd tar "Tar archive utility"

# Verify C++ compiler
if command -v g++ >/dev/null 2>&1; then
	COMPILER="g++"
elif command -v clang++ >/dev/null 2>&1; then
	COMPILER="clang++"
else
	echo "[ERROR] No C++ compiler found. Either 'g++' or 'clang++' must be installed." >&2
	exit 1
fi
echo "  Found CMake:    $(cmake --version | head -n 1)"
echo "  Found Compiler: $COMPILER ($($COMPILER --version | head -n 1))"
echo "  Found Node.js:  $(node --version)"
echo "  Found npm:      $(npm --version)"

# ------------------------------------------------------------------------------
# STEP 2: Production Web UI Compilation
# ------------------------------------------------------------------------------
echo "[2/6] Building production Web UI and Workbench assets..."
cd "$REPO_ROOT/tools/ui"

if [ -f "package-lock.json" ]; then
	npm ci
else
	npm install
fi

npm run build

# Validate required distribution assets against scripts/ui-assets.cmake requirements
DIST_DIR="$REPO_ROOT/tools/ui/dist"
echo "  Validating UI static distribution in $DIST_DIR..."

REQUIRED_FILES=(
	"index.html"
	"manifest.webmanifest"
	"sw.js"
	"build.json"
)

for req in "${REQUIRED_FILES[@]}"; do
	if [ ! -f "$DIST_DIR/$req" ]; then
		echo "[ERROR] Missing critical UI asset: $DIST_DIR/$req" >&2
		exit 1
	fi
done

if [ ! -f "$DIST_DIR/_app/version.json" ]; then
	echo "[ERROR] Missing version.json at $DIST_DIR/_app/version.json" >&2
	exit 1
fi

if ! find "$DIST_DIR" -name "bundle.*.js" -o -name "bundle.*.css" | grep -q .; then
	echo "[ERROR] Missing bundled JS/CSS assets in $DIST_DIR" >&2
	exit 1
fi

echo "  UI distribution verified: $(find "$DIST_DIR" -type f | wc -l) files generated."

# ------------------------------------------------------------------------------
# STEP 3: Native Backend Build with Embedded UI
# ------------------------------------------------------------------------------
echo "[3/6] Compiling native llama-server with embedded Web UI..."
cd "$REPO_ROOT"

NPROC=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
BUILD_DIR="$REPO_ROOT/build-release"

if [ -f "$REPO_ROOT/CMakeLists.txt" ]; then
	cmake -B "$BUILD_DIR" \
		-DLLAMA_BUILD_SERVER=ON \
		-DLLAMA_SERVER_EMBED_UI=ON \
		-DCMAKE_BUILD_TYPE=Release

	cmake --build "$BUILD_DIR" --config Release --target llama-server -j "$NPROC"
	SERVER_BINARY="$BUILD_DIR/bin/llama-server"
	if [ ! -f "$SERVER_BINARY" ] && [ -f "$BUILD_DIR/llama-server" ]; then
		SERVER_BINARY="$BUILD_DIR/llama-server"
	fi
elif [ -f "$REPO_ROOT/tools/server/CMakeLists.txt" ]; then
	# Subproject standalone build
	cmake -B "$BUILD_DIR" -S "$REPO_ROOT/tools/server" \
		-DLLAMA_SERVER_EMBED_UI=ON \
		-DCMAKE_BUILD_TYPE=Release

	cmake --build "$BUILD_DIR" --config Release --target llama-server -j "$NPROC"
	SERVER_BINARY="$BUILD_DIR/llama-server"
	if [ ! -f "$SERVER_BINARY" ] && [ -f "$BUILD_DIR/bin/llama-server" ]; then
		SERVER_BINARY="$BUILD_DIR/bin/llama-server"
	fi
else
	echo "[ERROR] No CMakeLists.txt found to build llama-server." >&2
	exit 1
fi

if [ ! -f "$SERVER_BINARY" ]; then
	echo "[ERROR] Compiled server binary not found at $SERVER_BINARY" >&2
	exit 1
fi
echo "  Native llama-server binary successfully built: $SERVER_BINARY"

# ------------------------------------------------------------------------------
# STEP 4: Assembly of Release Package
# ------------------------------------------------------------------------------
echo "[4/6] Assembling standalone distribution package..."
RELEASE_ROOT="$REPO_ROOT/dist-release/llama-workbench"

rm -rf "$RELEASE_ROOT"
mkdir -p "$RELEASE_ROOT/bin"
mkdir -p "$RELEASE_ROOT/scripts"
mkdir -p "$RELEASE_ROOT/public"
mkdir -p "$RELEASE_ROOT/data/models"
mkdir -p "$RELEASE_ROOT/data/workspace"
mkdir -p "$RELEASE_ROOT/data/logs"

# Copy binary
cp "$SERVER_BINARY" "$RELEASE_ROOT/bin/llama-server"
chmod +x "$RELEASE_ROOT/bin/llama-server"

# Copy supervisor
cp "$REPO_ROOT/scripts/workbench.sh" "$RELEASE_ROOT/scripts/workbench.sh"
chmod +x "$RELEASE_ROOT/scripts/workbench.sh"
chmod +x "$RELEASE_ROOT/scripts/"*.sh 2>/dev/null || true

# Copy static Web UI / Workbench assets to public/
echo "  Copying static Web UI / Workbench assets to public/..."
cp -r "$DIST_DIR/"* "$RELEASE_ROOT/public/"

if [ ! -f "$RELEASE_ROOT/public/index.html" ]; then
	echo "[ERROR] Failed to assemble public directory: missing index.html" >&2
	exit 1
fi
echo "  Public Web UI assets verified: $(find "$RELEASE_ROOT/public" -type f | wc -l) files copied."

# Copy environment template
cp "$REPO_ROOT/workbench.env.example" "$RELEASE_ROOT/workbench.env.example"

# Generate distribution README
cat << 'EOF' > "$RELEASE_ROOT/README.md"
# Llama Workbench — Standalone Deployment Distribution

This directory contains the self-contained production deployment bundle for **Llama Workbench**,
embedding the full Web UI and Autonomous Agent IDE directly inside the high-performance native `llama-server`.

## Turnkey Quick Start

1. **Start the Supervisor**:
   ```bash
   ./scripts/workbench.sh start
   ```
   *Note: If `workbench.env` does not exist, `workbench.sh` automatically creates it from `workbench.env.example` with turnkey remote defaults (`WORKBENCH_HOST=0.0.0.0`, `WORKBENCH_PORT=8080`, `WORKBENCH_CORS_ORIGINS=*`).*

2. **Verify Status & Logs**:
   ```bash
   ./scripts/workbench.sh status
   ./scripts/workbench.sh health
   ./scripts/workbench.sh logs
   ```

## Directory Structure
- `bin/llama-server`: Native C++ binary with embedded UI assets.
- `public/`: Compiled Web UI static assets document root (HTML, JS, CSS, PWA).
- `scripts/workbench.sh`: Runtime process supervisor (start, stop, restart, status, health, logs).
- `data/models/`: Target folder for local GGUF model weights.
- `data/workspace/`: Sandboxed filesystem workspace for autonomous agent tool executions.
- `data/logs/`: Production server logs (`workbench.log`).

## Stopping the Instance
```bash
./scripts/workbench.sh stop
```
EOF

# ------------------------------------------------------------------------------
# STEP 5: Security & Hygiene Audit
# ------------------------------------------------------------------------------
echo "[5/6] Performing security and credential hygiene scan on release bundle..."

if grep -r -E "(AIza[0-9A-Za-z-_]{35}|sk-[a-zA-Z0-9]{20,}|sk-ant-[a-zA-Z0-9_-]{20,})" "$RELEASE_ROOT" 2>/dev/null; then
	echo "[ERROR] Hardcoded API credentials detected inside $RELEASE_ROOT!" >&2
	exit 1
fi

if [ -f "$RELEASE_ROOT/workbench.env" ] || [ -f "$RELEASE_ROOT/.env" ]; then
	echo "[ERROR] Live .env file detected inside $RELEASE_ROOT! Must only include workbench.env.example" >&2
	exit 1
fi
echo "  Hygiene scan clean: 0 credentials or live secrets found."

# ------------------------------------------------------------------------------
# STEP 6: Archive Generation & Binary Verification
# ------------------------------------------------------------------------------
echo "[6/6] Generating compressed distribution archive..."
ARCH=$(uname -m 2>/dev/null || echo "x86_64")
VERSION="v0.1.0"
ARCHIVE_NAME="llama-workbench-${VERSION}-linux-${ARCH}.tar.gz"

cd "$REPO_ROOT/dist-release"
tar -czf "$ARCHIVE_NAME" llama-workbench

echo "  Binary execution verification:"
"$RELEASE_ROOT/bin/llama-server" --help >/dev/null 2>&1 || {
	echo "[WARNING] Non-zero exit code or execution warning running binary in package directory."
}

echo "================================================================================"
echo "[SUCCESS] Release packaging complete!"
echo "Distribution Directory: dist-release/llama-workbench/"
echo "Release Archive:        dist-release/$ARCHIVE_NAME"
echo "================================================================================"
