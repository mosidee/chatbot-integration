#!/usr/bin/env bash
# End-to-end smoke test: sign in, configure a provider, send a customer message
# through the simulator, and verify the AI answered.
set -euo pipefail

API="${API:-http://localhost:3000}"
EMAIL="${SEED_ADMIN_EMAIL:-admin@example.com}"
PASSWORD="${SEED_ADMIN_PASSWORD:-changeme12345}"
MOCK="${MOCK_URL:-http://localhost:4010}"
JAR="$(mktemp)"

say() { printf '\n== %s ==\n' "$1"; }

say "health"
curl -sf "$API/healthz" | tee /dev/stderr | grep -q '"status":"ok"'

say "sign in"
curl -sf -c "$JAR" -X POST "$API/api/auth/sign-in/email" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" > /dev/null
echo "signed in as $EMAIL"

say "configure provider"
PROVIDER_ID=$(curl -sf -b "$JAR" -X POST "$API/api/v1/settings/providers" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"smoke-mock\",\"baseUrl\":\"$MOCK/v1\",\"apiKey\":\"not-a-real-key\",\"supportsTools\":true}" \
  | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "provider $PROVIDER_ID"

curl -sf -b "$JAR" -X PUT "$API/api/v1/settings/task-slots/agent_chat" \
  -H 'content-type: application/json' \
  -d "{\"primaryProviderId\":\"$PROVIDER_ID\",\"primaryModel\":\"mock-model\"}" > /dev/null
echo "agent_chat slot points at the mock"

say "find the simulator channel"
CHANNEL_ID=$(curl -sf -b "$JAR" "$API/api/v1/simulator/channels" \
  | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "channel $CHANNEL_ID"

say "customer sends a message"
CUSTOMER="smoke-$(date +%s)"
curl -sf -b "$JAR" -X POST "$API/api/v1/simulator/$CHANNEL_ID/inbound" \
  -H 'content-type: application/json' \
  -d "{\"externalId\":\"$CUSTOMER\",\"displayName\":\"Smoke Test\",\"message\":{\"kind\":\"text\",\"text\":\"ราคาเท่าไหร่คะ\"}}" > /dev/null
echo "sent as $CUSTOMER"

say "wait for the AI to answer"
for i in $(seq 1 30); do
  BODY=$(curl -sf -b "$JAR" "$API/api/v1/conversations?limit=50")
  CONV_ID=$(echo "$BODY" | tr ',' '\n' | grep -B0 '"id"' | head -1 | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
  if [ -n "$CONV_ID" ]; then
    DETAIL=$(curl -sf -b "$JAR" "$API/api/v1/conversations/$CONV_ID")
    if echo "$DETAIL" | grep -q '"senderType":"ai"'; then
      echo "AI replied after ${i}s"
      echo "$DETAIL" | tr ',' '\n' | grep '"text"' | head -4
      say "PASS"
      exit 0
    fi
  fi
  sleep 1
done

echo "FAIL: the AI did not reply within 30s"
exit 1
