#!/usr/bin/env bash
set -e

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║       Hyacinth WebUI — One-Click Start      ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Step 1: Install frontend dependencies (if needed)
if [ ! -d "webui/node_modules" ]; then
    echo "[1/2] Installing frontend dependencies..."
    cd webui && npm install && cd ..
else
    echo "[1/2] Frontend dependencies OK"
fi

# Step 2: Build and start
echo "[2/2] Starting Hyacinth WebUI..."
echo ""

npx hyacinth serve --webui --webui-port 3100


