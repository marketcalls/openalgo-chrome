#!/bin/sh
# Builds dist/openalgo-chrome-v<version>.zip containing only the files the
# extension needs at runtime (for GitHub releases / Chrome Web Store upload).
set -eu
cd "$(dirname "$0")"
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)
OUT="dist/openalgo-chrome-v$VERSION.zip"
mkdir -p dist
rm -f "$OUT"
zip -q -X "$OUT" manifest.json background.js content.js shared.js popup.html popup.css popup.js LICENSE \
  images/icon16.png images/icon48.png images/icon128.png
echo "$OUT ($(du -k "$OUT" | cut -f1) KB)"
