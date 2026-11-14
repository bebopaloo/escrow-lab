#!/usr/bin/env bash
# Stand-in signature for the release workflow pilot (factory ADR 0015, work item R10).
#
# The production deploy workflow calls `scripts/sign.sh <file>` for the SBOM when the
# release_record module is on. A real repo signs with its own tool and cloud key, for
# example cosign with a KMS key. This stand-in has no key: it only writes
# `<file>.sha256`, so the pilot can test the workflow step. It is not a signature.
#
# Usage: scripts/sign.sh <file>
set -euo pipefail

file="${1:-}"
if [[ -z "$file" || ! -f "$file" ]]; then
  echo "usage: scripts/sign.sh <file>" >&2
  exit 2
fi

sha256sum "$file" > "$file.sha256"
echo "Stand-in signature (a sha256 digest, not a signature): $(cut -d' ' -f1 "$file.sha256")"
