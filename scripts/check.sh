#!/usr/bin/env bash
# The one command that proves remotty works: unit tests, a build, and the
# browser end-to-end suite against the real binary. Exit code 0 means all green.
#
#   ./scripts/check.sh                   everything
#   ./scripts/check.sh --e2e -g "Enter"  rebuild, then only matching browser tests
#
# Arguments after --e2e (or all arguments, without it) go to Playwright.
set -euo pipefail
cd "$(dirname "$0")/.."

need() {
  command -v "$1" >/dev/null && return
  echo "check: '$1' not found. $2" >&2
  exit 127
}
need go   "Install Go $(sed -n 's/^go //p' go.mod)+ from https://go.dev/dl/ (a tarball in your home dir is enough, no sudo)."
need node "Install Node 20+ (nvm or a tarball, no sudo)."
need tmux "Install tmux 3.2+ with your package manager (brew install tmux on macOS)."

e2e_only=false
if [ "${1:-}" = "--e2e" ]; then
  e2e_only=true
  shift
fi

if ! $e2e_only; then
  echo "== go vet + unit tests"
  go vet ./...
  go test ./... -count=1
fi

echo "== build"
go build -o bin/remotty ./cmd/remotty

echo "== e2e"
cd e2e
[ -d node_modules ] || npm ci --silent
npx playwright install chromium webkit >/dev/null 2>&1 || true
# WebKit on Linux needs system libraries only `sudo npx playwright install-deps
# webkit` adds. Without them the iOS tests are skipped, loudly, not failed: the
# check must stay runnable without sudo. On macOS WebKit always runs.
if ! node -e "require('@playwright/test').webkit.launch().then((b) => b.close())" >/dev/null 2>&1; then
  export REMOTTY_SKIP_WEBKIT=1
  echo "!! WebKit cannot start here: e2e/ios.spec.js is SKIPPED." >&2
  echo "!! To run it: sudo npx --prefix e2e playwright install-deps webkit" >&2
fi
npx playwright test "$@"

if $e2e_only; then
  echo "== e2e green${REMOTTY_SKIP_WEBKIT:+ (without WebKit)} (run without --e2e before calling it done)"
else
  echo "== all green${REMOTTY_SKIP_WEBKIT:+ (without WebKit: iOS tests skipped)}"
fi
