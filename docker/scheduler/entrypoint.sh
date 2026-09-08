#!/bin/sh
# Renders deploy/cron-jobs.json into a crontab, letting every schedule be
# overridden (or disabled with `off`) by its environment variable, then hands
# over to crond. `--render-only` prints the crontab and exits, which is how the
# test suite checks this configuration without a container.
set -eu

RENDER_ONLY=0
if [ "${1:-}" = "--render-only" ]; then
  RENDER_ONLY=1
fi

JOBS_FILE="${CRON_JOBS_FILE:-/app/cron-jobs.json}"
APP_URL="${APP_URL:-http://app:3000}"
TIMEZONE="${CRON_TZ:-Pacific/Auckland}"
STATE_DIR="${SCHEDULER_STATE_DIR:-/run/scheduler}"
CRONTAB="${SCHEDULER_CRONTAB:-/etc/crontabs/root}"
ZONEINFO="${SCHEDULER_ZONEINFO_DIR:-/usr/share/zoneinfo}"

if [ -z "${CRON_SECRET:-}" ]; then
  echo "scheduler: CRON_SECRET is required; the collection routes reject every unauthenticated call." >&2
  exit 1
fi
if [ ! -f "$JOBS_FILE" ]; then
  echo "scheduler: no job table at $JOBS_FILE" >&2
  exit 1
fi
if [ ! -f "$ZONEINFO/$TIMEZONE" ]; then
  echo "scheduler: unknown CRON_TZ '$TIMEZONE'" >&2
  exit 1
fi

if [ "$RENDER_ONLY" = "0" ]; then
  cp "$ZONEINFO/$TIMEZONE" /etc/localtime
  echo "$TIMEZONE" > /etc/timezone
fi
export TZ="$TIMEZONE"

# busybox crond starts jobs with a bare environment, so the settings a job needs
# are written once to a file only this container's user can read.
mkdir -p "$STATE_DIR"
umask 077
{
  echo "APP_URL='${APP_URL}'"
  echo "CRON_SECRET='${CRON_SECRET}'"
  echo "CRON_TIMEOUT_SECONDS='${CRON_TIMEOUT_SECONDS:-1800}'"
  echo "TZ='${TIMEZONE}'"
} > "$STATE_DIR/env"
umask 022

mkdir -p "$(dirname "$CRONTAB")"
: > "$CRONTAB"

echo "scheduler: timezone $TIMEZONE, target $APP_URL"
# Rendered to a file first: a `while` loop on the right of a pipe runs in a
# subshell, where a failed validation could not stop the container.
TABLE="$STATE_DIR/jobs.tsv"
jq -r '.jobs[] | [.name, .variable, .schedule, .path] | @tsv' "$JOBS_FILE" > "$TABLE"

while IFS="$(printf '\t')" read -r name variable default path; do
  schedule="$(printenv "$variable" 2>/dev/null || true)"
  [ -n "$schedule" ] || schedule="$default"
  case "$schedule" in
    off|OFF|disabled|none)
      echo "scheduler: $name disabled by $variable"
      continue
      ;;
  esac
  # Five cron fields, nothing clever: anything else is a configuration mistake
  # worth failing on rather than silently never running.
  if [ "$(echo "$schedule" | wc -w | tr -d ' ')" != "5" ]; then
    echo "scheduler: $variable is not a five-field cron expression: '$schedule'" >&2
    exit 1
  fi
  # Quoted because crond runs each line through `sh -c`, where a query string's
  # `?` and `&` would otherwise be shell syntax.
  printf "%s /usr/local/bin/run-collection-job '%s' '%s'\n" "$schedule" "$name" "$path" >> "$CRONTAB"
  echo "scheduler: $name at '$schedule' -> $path"
done < "$TABLE"

if [ ! -s "$CRONTAB" ]; then
  echo "scheduler: every job is disabled; nothing to schedule." >&2
fi

if [ "$RENDER_ONLY" = "1" ]; then
  exit 0
fi

# -f foreground, -d 8 logs each start and finish to stderr, which Docker keeps.
exec crond -f -d 8
