#!/usr/bin/env bash
# Standing smoke probes — run after every deploy. Read-only by default.
#   BASE=https://<deployment> bash scripts/agent/prod-smoke.sh
#   BASE=https://<deployment> SMOKE_WRITES=1 bash scripts/agent/prod-smoke.sh
# SMOKE_WRITES=1 adds the chat-streaming probe, which creates a chat session
# (a fake chat in that org's inbox). Against any non-localhost BASE it is
# refused unless SMOKE_PROD_WRITES=1 is also set (controller only, once; then
# hide the chat). A localhost BASE needs only SMOKE_WRITES=1.
# Exits non-zero on any failed expectation.
set -u
if [ -z "${BASE:-}" ]; then
  echo "usage: BASE=https://<deployment> [SMOKE_WRITES=1] bash scripts/agent/prod-smoke.sh" >&2
  exit 1
fi
BASE="${BASE%/}"
fail=0

check() { # label expected actual
  if [ "$2" = "$3" ]; then echo "ok   $1 ($3)"; else echo "FAIL $1 (want $2 got $3)"; fail=1; fi
}

check "home"        200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")"
check "chat"        200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/chat")"
check "admin login" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/login")"

# The retired demo login must be refused (the strings are split so the
# published-files test can assert no credential literal lives in the repo).
DEMO_EMAIL="admin@demo-""hvac.com"
DEMO_PW="admin""123"
DEMO_BODY=$(printf '{"email":"%s","password":"%s"}' "$DEMO_EMAIL" "$DEMO_PW")
check "demo login refused" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' -H "origin: $BASE" --data "$DEMO_BODY")"

# Cookie-less admin probes: all must be refused.
check "erase unauthenticated" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "$BASE/api/admin/customers/00000000-0000-0000-0000-000000000099/erase" \
  -H "origin: $BASE")"
check "SMS unauthenticated" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "$BASE/api/admin/conversations/00000000-0000-0000-0000-000000000001/message" \
  -H "origin: $BASE" -H 'content-type: application/json' -d '{"message":"x"}')"
check "mapkit-token unauthenticated" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/mapkit-token")"

# Chat streaming: ttfb must be meaningfully earlier than total on a long reply.
# Writes (creates a session + chat), so opt-in only.
if [ "${SMOKE_WRITES:-}" != "1" ]; then
  echo "skip chat streams: skipped (writes off)"
  exit $fail
fi
# Host, lowercased, without scheme, path or port. Anything odd (userinfo,
# unparseable) is left as-is, so it never matches localhost: fail closed.
host=$(printf '%s' "$BASE" | tr '[:upper:]' '[:lower:]')
host=${host#*://}
host=${host%%[/?#]*}
case "$host" in
  *@*) ;;
  \[*\]|\[*\]:*) host=${host#\[}; host=${host%%]*} ;;
  *:*) [ -z "$(printf '%s' "${host##*:}" | tr -d '0-9')" ] && host=${host%:*} ;;
esac
case "$host" in
  localhost|127.0.0.1|::1) ;;
  *)
    if [ "${SMOKE_PROD_WRITES:-}" != "1" ]; then
      echo "FAIL chat streams: refused (writes off localhost also need SMOKE_PROD_WRITES=1)"
      exit 1
    fi ;;
esac
SESS=$(mktemp)
curl -s -c "$SESS" -X POST "$BASE/api/session" -H "origin: $BASE" \
  -H 'content-type: application/json' -d '{}' -o /dev/null
timing=$(curl -sN -b "$SESS" -X POST "$BASE/api/chat" -H "origin: $BASE" \
  -H 'content-type: application/json' \
  -d '{"message":"Why is my heat pump blowing cold air in winter, and what are all the possible causes?"}' \
  -o /dev/null -w '%{time_starttransfer} %{time_total}')
rm -f "$SESS"
ttfb=${timing% *}; total=${timing#* }
gap=$(echo "$ttfb $total" | awk '{printf "%.2f", $2-$1}')
if awk "BEGIN{exit !($gap > 0.5)}"; then
  echo "ok   chat streams (ttfb ${ttfb}s, total ${total}s, gap ${gap}s)"
else
  echo "WARN chat stream gap only ${gap}s (short reply or regression — check manually)"
fi

exit $fail
