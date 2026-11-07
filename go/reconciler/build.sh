#!/usr/bin/env bash
# Package reconciler for Lambda PROVIDED_AL2023 (linux/amd64 bootstrap zip).
# Output: go/reconciler/dist/reconciler.zip (gitignored via dist/)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
MODULE_ROOT="$(cd "$ROOT/.." && pwd)"
DIST="$ROOT/dist"

mkdir -p "$DIST"
rm -f "$DIST/bootstrap" "$DIST/reconciler.zip"

echo "building linux/amd64 bootstrap → $DIST/bootstrap"
(
  cd "$MODULE_ROOT"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o "$DIST/bootstrap" ./reconciler
)

(
  cd "$DIST"
  zip -q reconciler.zip bootstrap
)

echo "wrote $DIST/reconciler.zip ($(wc -c < "$DIST/reconciler.zip" | tr -d ' ') bytes)"
file "$DIST/bootstrap"
unzip -l "$DIST/reconciler.zip"
