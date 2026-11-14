#!/usr/bin/env bash
# Stand-in deploy for the release workflow pilot (factory ADR 0015, work item R10).
#
# The factory's deploy workflows call `scripts/deploy.sh <environment>`. This stand-in
# starts the production-like preview stack of the checked-out commit on this machine
# (the CI runner), in its own Compose project. A release and a rollback thus really
# build and start one commit. There is no host and no cloud account, and every partner
# is an in-memory fake, so no real money can move.
#
# Usage: scripts/deploy.sh dev|production
set -euo pipefail

environment="${1:-}"
case "$environment" in
  dev) port=41098 ;;         # the last two preview ports of this repo's block (README, Ports)
  production) port=41099 ;;
  *) echo "usage: scripts/deploy.sh dev|production" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."
export PREVIEW_PORT="$port"
# A stand-in has no secret store, so each deploy gets a new session key: a redeploy signs users out.
export SESSION_KEY="${SESSION_KEY:-$(openssl rand -hex 32)}"
docker compose -f compose.preview.yaml -p "escrow-lab-$environment" up -d --build --wait
echo "Deployed $(git rev-parse --short HEAD) to the stand-in $environment on 127.0.0.1:$port"
