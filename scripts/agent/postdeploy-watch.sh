#!/usr/bin/env bash
# Post-deploy watch. Loops the READ-ONLY smoke probes and a log summary.
#   bash scripts/agent/postdeploy-watch.sh <deployment url> [--minutes 60] [--every 10]
# Never enables smoke writes. Prints counts and route patterns only, never log
# line content or env values. Never calls Sentry; it only reminds you to look.
# `vercel logs` streams for at most 5 minutes, so each pass captures up to that.
# Test hooks (no network): WATCH_FIXTURE_LOGS=<file> WATCH_FIXTURE_ENV=<file>
# replace `vercel logs` / `vercel env ls` and skip the smoke run.
set -u
usage() { echo "usage: bash scripts/agent/postdeploy-watch.sh <deployment url> [--minutes 60] [--every 10]" >&2; exit 1; }
URL="${1:-}"; [ -z "$URL" ] && usage
shift
MINUTES=60; EVERY=10
while [ $# -gt 0 ]; do
  case "$1" in
    --minutes) MINUTES="${2:-}"; shift 2 || usage ;;
    --every) EVERY="${2:-}"; shift 2 || usage ;;
    *) usage ;;
  esac
done
case "$MINUTES$EVERY" in ''|*[!0-9]*) usage ;; esac
[ "$MINUTES" -ge 1 ] && [ "$EVERY" -ge 1 ] || usage

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUM="npx --no-install tsx $ROOT/scripts/agent/postdeploy-summarize.mjs"
SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
fixture="${WATCH_FIXTURE_LOGS:-}"
smoke_fail=0; end=$(( $(date +%s) + MINUTES * 60 )); pass=0

while :; do
  pass=$((pass + 1))
  echo "== pass $pass ($(date -u +%H:%M:%SZ)) $URL"
  if [ -z "$fixture" ]; then
    # Read-only smoke: writes are never enabled by the watch.
    smoke_out="$(env -u SMOKE_WRITES -u SMOKE_PROD_WRITES BASE="$URL" bash "$ROOT/scripts/agent/prod-smoke.sh")" || smoke_fail=1
    printf '%s\n' "$smoke_out" | grep -v '^ok ' || true
    : > "$TMP"
    vercel logs "$URL" --json > "$TMP" 2>/dev/null &
    lp=$!
    ( sleep $(( EVERY < 5 ? EVERY * 60 : 300 )); kill "$lp" 2>/dev/null ) &
    wait "$lp" 2>/dev/null
  else
    cp "$fixture" "$TMP"
  fi
  $SUM summarize < "$TMP"
  [ "$(date +%s)" -ge "$end" ] && break
  [ -n "$fixture" ] && break
  rest=$(( EVERY * 60 - 300 )); [ "$rest" -gt 0 ] && sleep "$rest"
done

if [ -n "${WATCH_FIXTURE_ENV:-}" ]; then envout="$(cat "$WATCH_FIXTURE_ENV")"; else envout="$(vercel env ls production 2>/dev/null)"; fi
if printf '%s\n' "$envout" | $SUM has-env SENTRY_DSN; then
  echo "Check Sentry issues for release $SHA"
else
  echo "Sentry is not enabled (SENTRY_DSN not set in production)"
fi
[ "$smoke_fail" -eq 0 ] && echo "smoke: all passes ok" || echo "smoke: at least one pass FAILED"
exit $smoke_fail
