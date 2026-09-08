#!/bin/sh
# Calls one collection route with the shared secret and logs a single JSON line
# per run, so `docker compose logs scheduler` is a usable collection history.
set -eu

. "${SCHEDULER_STATE_DIR:-/run/scheduler}/env"

name="$1"
path="$2"
started="$(date +%Y-%m-%dT%H:%M:%S%z)"
body="$(mktemp)"
trap 'rm -f "$body"' EXIT

# curl still writes a status of 000 when it never got an answer, so the failure
# is reported once, as a string: a bare 000 is not valid JSON.
status="$(
  curl --silent --show-error --location \
    --max-time "${CRON_TIMEOUT_SECONDS:-1800}" \
    --output "$body" \
    --write-out '%{http_code}' \
    --header "Authorization: Bearer ${CRON_SECRET}" \
    --header 'User-Agent: auckland-bargain-scheduler/1.0' \
    "${APP_URL}${path}" || true
)"
case "$status" in
  '' | *[!0-9]*) status='000' ;;
esac

summary="$(head -c 500 "$body" | tr -d '\n' | sed 's/\\/\\\\/g; s/"/\\"/g')"
finished="$(date +%Y-%m-%dT%H:%M:%S%z)"
echo "{\"job\":\"${name}\",\"path\":\"${path}\",\"status\":\"${status}\",\"startedAt\":\"${started}\",\"finishedAt\":\"${finished}\",\"response\":\"${summary}\"}"

case "$status" in
  2*) exit 0 ;;
  *) exit 1 ;;
esac
