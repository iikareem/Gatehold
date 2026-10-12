#!/usr/bin/env bash
# Package hold-sweeper for Lambda PROVIDED_AL2023 (linux/amd64 bootstrap zip).
# Output: go/hold-sweeper/dist/hold-sweeper.zip (gitignored via dist/)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
MODULE_ROOT="$(cd "$ROOT/.." && pwd)"
DIST="$ROOT/dist"

mkdir -p "$DIST"
rm -f "$DIST/bootstrap" "$DIST/hold-sweeper.zip"

echo "building linux/amd64 bootstrap → $DIST/bootstrap"
(
  cd "$MODULE_ROOT"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o "$DIST/bootstrap" ./hold-sweeper
)

(
  cd "$DIST"
  zip -q hold-sweeper.zip bootstrap
)

echo "wrote $DIST/hold-sweeper.zip ($(wc -c < "$DIST/hold-sweeper.zip" | tr -d ' ') bytes)"
file "$DIST/bootstrap"
unzip -l "$DIST/hold-sweeper.zip"
