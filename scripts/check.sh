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
npx playwright install chromium webkit >/dev/null
npx playwright test "$@"

if $e2e_only; then
  echo "== e2e green (run without --e2e before calling it done)"
else
  echo "== all green"
fi
