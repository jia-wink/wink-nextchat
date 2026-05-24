#!/usr/bin/env bash

set -euo pipefail

if [[ "${1:-}" == "" ]]; then
  echo "usage: $0 /path/to/.env.production"
  exit 1
fi

ENV_FILE="$1"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "env file not found: $ENV_FILE"
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

if [[ -z "${OPENCLAW_GATEWAY_URL:-}" ]]; then
  echo "OPENCLAW_GATEWAY_URL is required"
  exit 1
fi

if [[ -z "${OPENCLAW_AUTH_TOKEN:-}" ]]; then
  echo "OPENCLAW_AUTH_TOKEN is required"
  exit 1
fi

if [[ -z "${OPENCLAW_SHARED_SECRET:-}" ]]; then
  echo "OPENCLAW_SHARED_SECRET is required"
  exit 1
fi

if [[ -z "${NEXTCHAT_PUBLIC_BASE_URL:-}" ]]; then
  echo "NEXTCHAT_PUBLIC_BASE_URL is required"
  exit 1
fi

ACCOUNT_ID="${OPENCLAW_ACCOUNT_ID:-default}"
HEALTH_URL="${OPENCLAW_GATEWAY_URL%/}/api/channels/nextchat/health?accountId=${ACCOUNT_ID}"
SITE_HEALTH_URL="${NEXTCHAT_PUBLIC_BASE_URL%/}/api/openclaw/health"
UPLOAD_PROBE_URL="${NEXTCHAT_PUBLIC_BASE_URL%/}/api/files/upload"

echo
echo "== 1. OpenClaw nextchat health =="
curl --fail --silent --show-error \
  -H "Authorization: Bearer ${OPENCLAW_AUTH_TOKEN}" \
  -H "x-nextchat-secret: ${OPENCLAW_SHARED_SECRET}" \
  "$HEALTH_URL" | sed 's/.*/&/'; echo

echo
echo "== 2. NextChat bridge health =="
curl --fail --silent --show-error \
  "$SITE_HEALTH_URL" | sed 's/.*/&/'; echo

TMP_FILE="$(mktemp /tmp/nextchat-smoke.XXXXXX.txt)"
trap 'rm -f "$TMP_FILE"' EXIT
printf 'nextchat-openclaw-smoke\n' > "$TMP_FILE"

echo
echo "== 3. Server upload probe =="
curl --fail --silent --show-error \
  -X POST \
  -F "file=@${TMP_FILE};type=text/plain" \
  "$UPLOAD_PROBE_URL" | sed 's/.*/&/'; echo

echo
echo "Smoke checks completed."
