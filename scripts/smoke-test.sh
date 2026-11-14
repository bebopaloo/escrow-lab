#!/usr/bin/env bash
# Stand-in smoke test for the release workflow pilot (factory ADR 0015, work item R10).
#
# The factory's deploy workflows call `scripts/smoke-test.sh <environment>` after
# `scripts/deploy.sh`. It checks the API health route and the web root of the stack
# that deploy.sh started, and fails on the first route that does not answer 200.
#
# Usage: scripts/smoke-test.sh dev|production
set -euo pipefail

environment="${1:-}"
case "$environment" in
  dev) port=41098 ;;
  production) port=41099 ;;
  *) echo "usage: scripts/smoke-test.sh dev|production" >&2; exit 2 ;;
esac

base="http://127.0.0.1:$port"
for route in /api/health /; do
  # 10 tries, 2 seconds apart: Caddy can need a moment after `up --wait`.
  if ! curl --fail --silent --show-error --output /dev/null --retry 10 --retry-delay 2 --retry-all-errors "$base$route"; then
    echo "Smoke test failed: $base$route did not answer 200" >&2
    exit 1
  fi
done
echo "Smoke test passed on the stand-in $environment ($base)"
