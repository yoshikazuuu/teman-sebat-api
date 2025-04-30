#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="http://localhost:8787"

echo "--- 1. Health Check ---"
curl -s "${API_BASE_URL}/"
echo -e "\n"

echo "--- 2. Auth Users ---"
# User 1
resp=$(curl -s -X POST "${API_BASE_URL}/auth/apple" \
  -H "Content-Type: application/json" \
  -d '{
    "idToken":"simulated-unique-apple-id-12345",
    "firstName":"Test",
    "lastName":"User",
    "email":"test.user.12345@example.com"
  }')
echo "${resp}" | jq
USER1_TOKEN=$(echo "${resp}" | jq -r .token)
USER1_ID=$(echo "${resp}" | jq -r .userId)

# User 2
resp=$(curl -s -X POST "${API_BASE_URL}/auth/apple" \
  -H "Content-Type: application/json" \
  -d '{
    "idToken":"simulated-unique-apple-id-123451",
    "firstName":"Test2",
    "lastName":"User2",
    "email":"test.user2.12345@example.com"
  }')
echo "${resp}" | jq
USER2_TOKEN=$(echo "${resp}" | jq -r .token)
USER2_ID=$(echo "${resp}" | jq -r .userId)

echo -e "\n--- Fetch User-2 Username ---"
resp=$(curl -s -H "Authorization: Bearer ${USER2_TOKEN}" \
  "${API_BASE_URL}/users/profile")
USER2_USERNAME=$(echo "${resp}" | jq -r .user.username)
echo "User2 username = ${USER2_USERNAME}"
echo -e "\n"

echo "--- 3. Profile Ops for User-1 ---"
curl -s -H "Authorization: Bearer ${USER1_TOKEN}" \
  "${API_BASE_URL}/users/profile" | jq
echo
curl -s -X PATCH "${API_BASE_URL}/users/profile" \
  -H "Authorization: Bearer ${USER1_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "username":"testuser1_updated",
    "fullName":"Test User One Updated"
  }' | jq
echo -e "\n"

echo "--- 4. Register Device for User-1 ---"
DEVICE_TOKEN="fake-test-device-token-123"
curl -s -X POST "${API_BASE_URL}/users/devices" \
  -H "Authorization: Bearer ${USER1_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"token\":\"${DEVICE_TOKEN}\",
    \"platform\":\"ios\"
  }" | jq
echo -e "\n"

echo "--- 5. Friend Management ---"
curl -s -H "Authorization: Bearer ${USER1_TOKEN}" \
  "${API_BASE_URL}/friends/search?q=${USER2_USERNAME}" | jq
echo
curl -s -X POST "${API_BASE_URL}/friends/request" \
  -H "Authorization: Bearer ${USER1_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${USER2_USERNAME}\"}" | jq
echo
curl -s -H "Authorization: Bearer ${USER2_TOKEN}" \
  "${API_BASE_URL}/friends/requests" | jq
echo

FRIENDSHIP_ID="${USER1_ID}-${USER2_ID}"
echo "→ Accepting friend request ${FRIENDSHIP_ID}"
curl -s -X POST "${API_BASE_URL}/friends/accept/${FRIENDSHIP_ID}" \
  -H "Authorization: Bearer ${USER2_TOKEN}" | jq
echo
echo "User-1 friends:"
curl -s -H "Authorization: Bearer ${USER1_TOKEN}" \
  "${API_BASE_URL}/friends" | jq
echo
echo "User-2 friends:"
curl -s -H "Authorization: Bearer ${USER2_TOKEN}" \
  "${API_BASE_URL}/friends" | jq
echo -e "\n"

echo "--- 6. Smoking Session Flow ---"
resp=$(curl -s -X POST "${API_BASE_URL}/smoking/start" \
  -H "Authorization: Bearer ${USER1_TOKEN}")
echo "${resp}" | jq
SESSION_ID=$(echo "${resp}" | jq -r .sessionId)
echo "Session ID = ${SESSION_ID}"
echo

echo "--- Active Sessions for User-2 ---"
curl -s -H "Authorization: Bearer ${USER2_TOKEN}" \
  "${API_BASE_URL}/smoking/active" | jq
echo

echo "--- User-2 Responding 'coming' ---"
curl -s -X POST "${API_BASE_URL}/smoking/respond/${SESSION_ID}" \
  -H "Authorization: Bearer ${USER2_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "responseType":"coming"
  }' | jq
echo

echo "--- User-1 Fetching Responses ---"
curl -s -H "Authorization: Bearer ${USER1_TOKEN}" \
  "${API_BASE_URL}/smoking/responses/${SESSION_ID}" | jq
echo

echo "--- User-1 Ending Session ---"
curl -s -X POST "${API_BASE_URL}/smoking/end/${SESSION_ID}" \
  -H "Authorization: Bearer ${USER1_TOKEN}" | jq
echo

echo "--- Session History ---"
curl -s -H "Authorization: Bearer ${USER1_TOKEN}" \
  "${API_BASE_URL}/smoking/history?limit=5&page=1" | jq
echo -e "\n"

echo "--- 7. Cleanup ---"
# delete device after session ends
curl -s -X DELETE "${API_BASE_URL}/users/devices/${DEVICE_TOKEN}" \
  -H "Authorization: Bearer ${USER1_TOKEN}" | jq
# remove friendship
curl -s -X DELETE "${API_BASE_URL}/friends/${FRIENDSHIP_ID}" \
  -H "Authorization: Bearer ${USER1_TOKEN}" | jq
echo -e "\n--- Testing Complete ---"
