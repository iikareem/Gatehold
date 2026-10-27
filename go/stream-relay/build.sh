#!/usr/bin/env bash
# Package stream-relay for Lambda PROVIDED_AL2023 (linux/amd64 bootstrap zip).
# Output: go/stream-relay/dist/stream-relay.zip (gitignored via dist/)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
MODULE_ROOT="$(cd "$ROOT/.." && pwd)"
DIST="$ROOT/dist"

mkdir -p "$DIST"
rm -f "$DIST/bootstrap" "$DIST/stream-relay.zip"

echo "building linux/amd64 bootstrap → $DIST/bootstrap"
(
  cd "$MODULE_ROOT"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o "$DIST/bootstrap" ./stream-relay
)

(
  cd "$DIST"
  zip -q stream-relay.zip bootstrap
)

echo "wrote $DIST/stream-relay.zip ($(wc -c < "$DIST/stream-relay.zip" | tr -d ' ') bytes)"
file "$DIST/bootstrap"
unzip -l "$DIST/stream-relay.zip"
