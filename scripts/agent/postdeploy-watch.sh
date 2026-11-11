#!/usr/bin/env bash
# Post-deploy watch. Loops the READ-ONLY smoke probes and a log summary.
#   bash scripts/agent/postdeploy-watch.sh <deployment url> [--minutes 60] [--every 10]
# Never enables smoke writes. Prints counts and route patterns only, never log
# line content or env values. Never calls Sentry; it only reminds you to look.
# `vercel logs` streams for at most 5 minutes, so each pass captures up to that.
# Test hooks (no network): WATCH_FIXTURE_LOGS=<file> WATCH_FIXTURE_ENV=<file>
# replace `vercel logs` / `vercel env ls` and skip the smoke run.
# Exit (first that applies): 1 a smoke pass failed, 5 the logs showed a 5xx,
# 4 logs were unavailable, 3 fixture run, 0 clean.
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

if [ -n "${WATCH_FIXTURE_LOGS:-}${WATCH_FIXTURE_ENV:-}" ] && [ "${WATCH_FIXTURE:-}" != "1" ]; then
  echo "fixture vars set without WATCH_FIXTURE=1" >&2; exit 2
fi
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUM="npx --no-install tsx $ROOT/scripts/agent/postdeploy-summarize.mjs"
SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
TMP="$(mktemp)"; ERR="$(mktemp)"; lp=""; sp=""
cleanup() { [ -n "$lp" ] && kill "$lp" 2>/dev/null; [ -n "$sp" ] && kill "$sp" 2>/dev/null; rm -f "$TMP" "$ERR"; }
trap cleanup EXIT
trap 'exit 130' INT TERM
fixture=""
if [ "${WATCH_FIXTURE:-}" = "1" ]; then
  fixture="${WATCH_FIXTURE_LOGS:-/dev/null}"
  echo "FIXTURE MODE — no smoke, no real logs"
fi
smoke_fail=0; logs_bad=0; saw_5xx=0; continue_after=0; end=$(( $(date +%s) + MINUTES * 60 )); pass=0

while :; do
  pass=$((pass + 1))
  echo "== pass $pass ($(date -u +%H:%M:%SZ)) $URL"
  if [ -z "$fixture" ]; then
    # Read-only smoke: writes are never enabled by the watch.
    smoke_out="$(env -u SMOKE_WRITES -u SMOKE_PROD_WRITES BASE="$URL" bash "$ROOT/scripts/agent/prod-smoke.sh")" || smoke_fail=1
    printf '%s\n' "$smoke_out" | grep -v '^ok ' || true
    : > "$TMP"
    ( cd "$ROOT" && exec vercel logs "$URL" --json > "$TMP" 2> "$ERR" ) &
    lp=$!
    ( sleep $(( EVERY < 5 ? EVERY * 60 : 300 )); kill "$lp" 2>/dev/null ) &
    sp=$!
    wait "$lp" 2>/dev/null; lstatus=$?
    kill "$sp" 2>/dev/null; sp=""; lp=""
    # 143 = we stopped it at the end of the capture window, which is expected.
    if [ "$lstatus" -ne 0 ] && [ "$lstatus" -ne 143 ] && [ "$lstatus" -ne 137 ]; then
      echo "logs: unavailable (vercel logs failed)"; logs_bad=1; continue_after=1
    fi
  else
    cp "$fixture" "$TMP"
  fi
  if [ "$continue_after" -eq 0 ]; then
    if [ -s "$TMP" ]; then
      # summarize exits 5 when it counted a 5xx; anything else nonzero is a failed summary.
      $SUM summarize < "$TMP"; sstatus=$?
      if [ "$sstatus" -eq 5 ]; then saw_5xx=1
      elif [ "$sstatus" -ne 0 ]; then echo "logs: summary failed"; logs_bad=1; fi
    else
      echo "logs: no lines captured — verify vercel logs access"
    fi
  fi
  continue_after=0
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
if [ -n "$fixture" ]; then echo "smoke: skipped"
elif [ "$smoke_fail" -eq 0 ]; then echo "smoke: all passes ok"
else echo "smoke: at least one pass FAILED"; fi
[ "$saw_5xx" -eq 0 ] || echo "logs: at least one 5xx — check the routes above"
[ "$smoke_fail" -eq 0 ] || exit 1
[ "$saw_5xx" -eq 0 ] || exit 5
[ "$logs_bad" -eq 0 ] || exit 4
[ -z "$fixture" ] || exit 3
exit 0
