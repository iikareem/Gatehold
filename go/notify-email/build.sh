#!/usr/bin/env bash
# Package notify-email for Lambda PROVIDED_AL2023 (linux/amd64 bootstrap zip).
# Output: go/notify-email/dist/notify-email.zip (gitignored via dist/)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
MODULE_ROOT="$(cd "$ROOT/.." && pwd)"
DIST="$ROOT/dist"

mkdir -p "$DIST"
rm -f "$DIST/bootstrap" "$DIST/notify-email.zip"

echo "building linux/amd64 bootstrap → $DIST/bootstrap"
(
  cd "$MODULE_ROOT"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o "$DIST/bootstrap" ./notify-email
)

(
  cd "$DIST"
  zip -q notify-email.zip bootstrap
)

echo "wrote $DIST/notify-email.zip ($(wc -c < "$DIST/notify-email.zip" | tr -d ' ') bytes)"
file "$DIST/bootstrap"
unzip -l "$DIST/notify-email.zip"
