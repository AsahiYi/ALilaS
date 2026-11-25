#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${HOME}/.gemini/config/plugins/alilas"

echo "==> Installing ALilaS into ${TARGET_DIR}"
mkdir -p "${TARGET_DIR}"

# Preserve user-local mode_a_patch.yml if upgrading
TMP_PATCH=""
if [ -f "${TARGET_DIR}/config/mode_a_patch.yml" ]; then
  TMP_PATCH="$(mktemp)"
  cp "${TARGET_DIR}/config/mode_a_patch.yml" "${TMP_PATCH}"
fi

for item in plugin.json mcp_config.json README.md README.zh-CN.md LICENSE assets config rules skills server ui; do
  if [ -e "${REPO_DIR}/${item}" ]; then
    rm -rf "${TARGET_DIR}/${item}"
    cp -R "${REPO_DIR}/${item}" "${TARGET_DIR}/${item}"
  fi
done

if [ -n "${TMP_PATCH}" ] && [ -f "${TMP_PATCH}" ]; then
  cp "${TMP_PATCH}" "${TARGET_DIR}/config/mode_a_patch.yml"
  rm -f "${TMP_PATCH}"
fi

echo "==> Installing server dependencies"
(cd "${TARGET_DIR}/server" && npm install --no-audit --no-fund)

echo "==> Building self-contained ALilaS UI"
node "${TARGET_DIR}/ui/build.mjs"

if [ ! -f "${TARGET_DIR}/config/mode_a_patch.yml" ] && [ -f "${TARGET_DIR}/config/mode_a_patch.example.yml" ]; then
  echo "Tip: Copy config/mode_a_patch.example.yml to config/mode_a_patch.yml for custom DSH provider defaults."
fi

echo "==> Done! Launch ALilaS from Antigravity's '+' side pane menu or left sidebar."
