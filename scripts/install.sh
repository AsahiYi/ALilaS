#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${HOME}/.gemini/config/plugins/lilas"

echo "==> Installing LilaS into ${TARGET_DIR}"
mkdir -p "${TARGET_DIR}"

for item in plugin.json mcp_config.json README.md README.zh-CN.md LICENSE assets config rules skills server ui; do
  if [ -e "${REPO_DIR}/${item}" ]; then
    rm -rf "${TARGET_DIR}/${item}"
    cp -R "${REPO_DIR}/${item}" "${TARGET_DIR}/${item}"
  fi
done

echo "==> Installing server dependencies"
(cd "${TARGET_DIR}/server" && npm install --no-audit --no-fund)

echo "==> Building self-contained LilaS UI"
node "${TARGET_DIR}/ui/build.mjs"

if [ ! -f "${TARGET_DIR}/config/mode_a_patch.yml" ] && [ -f "${TARGET_DIR}/config/mode_a_patch.example.yml" ]; then
  echo "Tip: Copy config/mode_a_patch.example.yml to config/mode_a_patch.yml if you need custom provider/model overrides."
fi

echo "==> Done! Open Antigravity and launch LilaS from the '+' side pane menu or left sidebar."
