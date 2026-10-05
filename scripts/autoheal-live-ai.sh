#!/usr/bin/env bash
# Docker's `restart: unless-stopped` only reacts to the container process
# exiting — it does NOT restart a container that Docker's own HEALTHCHECK
# has marked "unhealthy" (e.g. the live-ai server is up but its ARI link to
# Asterisk is stuck/disconnected). This script closes that gap: run it on a
# short interval and it restarts the container whenever Docker reports it
# unhealthy, logging what it did.
#
# Install as a cron job on the host (not inside the container), e.g. every
# minute, as a user with access to the Docker socket:
#   * * * * * /opt/live-ai/scripts/autoheal-live-ai.sh
#
# Requires: docker CLI access to the daemon running the `live-ai` container.

set -euo pipefail

CONTAINER="${AUTOHEAL_CONTAINER:-live-ai}"

status="$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "unknown")"

if [ "$status" = "unhealthy" ]; then
  logger -t autoheal-live-ai "container '$CONTAINER' is unhealthy, restarting"
  docker restart "$CONTAINER" >/dev/null
fi
