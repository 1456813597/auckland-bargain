# syntax=docker/dockerfile:1
FROM alpine:3.22

# busybox crond plus the few tools the job runner needs. tzdata is what makes
# "04:10 on Monday" mean Auckland time rather than UTC.
RUN apk add --no-cache bash ca-certificates curl jq tzdata tini

COPY deploy/cron-jobs.json /app/cron-jobs.json
COPY docker/scheduler/entrypoint.sh /usr/local/bin/scheduler-entrypoint
COPY docker/scheduler/run-job.sh /usr/local/bin/run-collection-job
RUN chmod +x /usr/local/bin/scheduler-entrypoint /usr/local/bin/run-collection-job

ENV APP_URL=http://app:3000 \
    CRON_TZ=Pacific/Auckland \
    CRON_JOBS_FILE=/app/cron-jobs.json \
    CRON_TIMEOUT_SECONDS=1800

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/scheduler-entrypoint"]
