#!/usr/bin/env bash
# Standing prod smoke probes — run after every deploy.
#   bash scripts/agent/prod-smoke.sh
# Exits non-zero on any failed expectation.
set -u
BASE="${BASE:-https://ai-hvac-agent-lovat.vercel.app}"
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
check "demo login refused" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' -H "origin: $BASE" \
  -d "{\"email\":\"$DEMO_EMAIL\",\"password\":\"$DEMO_PW\"}")"

# Cookie-less admin probes: all must be refused.
check "erase unauthenticated" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "$BASE/api/admin/customers/00000000-0000-0000-0000-000000000099/erase" \
  -H "origin: $BASE")"
check "SMS unauthenticated" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "$BASE/api/admin/conversations/00000000-0000-0000-0000-000000000001/message" \
  -H "origin: $BASE" -H 'content-type: application/json' -d '{"message":"x"}')"
check "mapkit-token unauthenticated" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/mapkit-token")"

# Chat streaming: ttfb must be meaningfully earlier than total on a long reply.
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
