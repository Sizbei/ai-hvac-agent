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

COOKIE=$(curl -s -i -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' -H "origin: $BASE" \
  -d '{"email":"admin@demo-hvac.com","password":"admin123"}' \
  | grep -i "^set-cookie: hvac_admin_session" | sed 's/^[Ss]et-[Cc]ookie: //; s/;.*//')
if [ -n "$COOKIE" ]; then echo "ok   demo login"; else echo "FAIL demo login"; fail=1; fi

check "demo erase blocked" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "$BASE/api/admin/customers/00000000-0000-0000-0000-000000000099/erase" \
  -H "cookie: $COOKIE" -H "origin: $BASE")"
check "demo SMS blocked" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "$BASE/api/admin/conversations/00000000-0000-0000-0000-000000000001/message" \
  -H "cookie: $COOKIE" -H "origin: $BASE" -H 'content-type: application/json' -d '{"message":"x"}')"
# 503 until Apple credentials are configured; becomes 200 after.
mk=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/mapkit-token" -H "cookie: $COOKIE")
if [ "$mk" = "503" ] || [ "$mk" = "200" ]; then echo "ok   mapkit-token ($mk)"; else echo "FAIL mapkit-token ($mk)"; fail=1; fi

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
