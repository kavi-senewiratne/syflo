#!/usr/bin/env bash
# Syncs the backend folder + a portable Node binary into electron/resources/,
# where electron-builder picks them up as extraResources. Run before
# `npm run build` in electron/ (and any time backend code or node_modules
# change) — the electron build scripts call this automatically.
#
# Why a bundled Node instead of Electron's own runtime: better-sqlite3 is a
# native module compiled against the system Node ABI. Running the backend in
# Electron's Node would require an electron-rebuild; shipping the system Node
# binary avoids that entirely. The mirror is gitignored.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESOURCES="$ROOT/electron/resources"

echo "→ Syncing backend → $RESOURCES/backend"
mkdir -p "$RESOURCES/backend"
rsync -a --delete \
  --exclude tests \
  --exclude '*.db' \
  --exclude '*.db-*' \
  --exclude jest.config.js \
  --exclude '.env*' \
  "$ROOT/backend/" "$RESOURCES/backend/"

echo "→ Copying node binary → $RESOURCES/node/node"
mkdir -p "$RESOURCES/node"
# Use the currently-installed Node so the bundled binary matches the version
# better-sqlite3 was compiled against.
NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found in PATH. Install Node first." >&2
  exit 1
fi
cp "$NODE_BIN" "$RESOURCES/node/node"
chmod +x "$RESOURCES/node/node"

echo "✓ Done. Resources ready at: $RESOURCES"
du -sh "$RESOURCES/backend" "$RESOURCES/node"
