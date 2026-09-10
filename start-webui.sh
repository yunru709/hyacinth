#!/usr/bin/env bash
set -e

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║       Hyacinth WebUI — One-Click Start      ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# WebUI 为纯静态页面（webui/ 目录，无 npm 依赖），直接启动 serve
echo "Starting Hyacinth WebUI → http://localhost:3100"
echo ""

npx hyacinth serve --webui --webui-port 3100
