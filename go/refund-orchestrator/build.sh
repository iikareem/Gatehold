#!/usr/bin/env bash
# Package refund-orchestrator for Lambda PROVIDED_AL2023 (linux/amd64 bootstrap zip).
# Output: go/refund-orchestrator/dist/refund-orchestrator.zip (gitignored via dist/)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
MODULE_ROOT="$(cd "$ROOT/.." && pwd)"
DIST="$ROOT/dist"

mkdir -p "$DIST"
rm -f "$DIST/bootstrap" "$DIST/refund-orchestrator.zip"

echo "building linux/amd64 bootstrap → $DIST/bootstrap"
(
  cd "$MODULE_ROOT"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o "$DIST/bootstrap" ./refund-orchestrator
)

(
  cd "$DIST"
  zip -q refund-orchestrator.zip bootstrap
)

echo "wrote $DIST/refund-orchestrator.zip ($(wc -c < "$DIST/refund-orchestrator.zip" | tr -d ' ') bytes)"
file "$DIST/bootstrap"
unzip -l "$DIST/refund-orchestrator.zip"
