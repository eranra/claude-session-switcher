#!/usr/bin/env bash
# ============================================================================
# Guard: one commit touches one host's aggregate, and every aggregate says who it is.
# ============================================================================
#
# `<corpus>/data/aggregates/<host>.json` is one machine's published counts, and the team
# tier merges them by counting hosts (see src/policy/aggregates.ts). Two things about that
# merge are only true if the files are well formed:
#
#   1. the filename IS the merge key, so a file whose internal `host` disagrees with its own
#      filename is either a rename nobody finished or an attempt to publish under another
#      machine's identity;
#   2. one host publishes one file, so a commit touching two of them is a machine claiming to
#      be two developers — which is exactly the "one developer's habit with a witness" the
#      per-host rule exists to reject.
#
# WHAT THIS BUYS, HONESTLY: accident prevention and an audit trail. NOT authentication.
# Anyone with push access to the corpus can commit a file named for any host with any counts,
# and no shell script can tell that apart from a real publish — there is no signature and no
# key distribution here. What holds is downstream: the only thing a forged aggregate can
# reach is a `status: proposed` clause file, which cannot decide, cannot be matched and cannot
# render into a prompt. It buys a forger a line in a pull request a human must still accept.
#
# This runs in the CORPUS repo, not in session-sitter — install it as that repo's CI step or
# its pre-commit hook. It is checked here against fixtures so it cannot rot.
#
# Usage:  bash ci/check-aggregates.sh <corpus-checkout> [<base-ref>]
#         With a base ref, the commit-scope rule is checked over `git diff --name-only`.
#         Without one, only the well-formedness rules run.
# Exit:   0 clean · 1 a rule was broken · 2 called wrongly
# ============================================================================

set -uo pipefail

corpus="${1:-}"
base="${2:-}"
if [[ -z "$corpus" || ! -d "$corpus" ]]; then
  echo "usage: bash ci/check-aggregates.sh <corpus-checkout> [<base-ref>]" >&2
  exit 2
fi

fail=0
dir="$corpus/data/aggregates"

# ---- rule 1: the filename is the host, and the file agrees -------------------
if [[ -d "$dir" ]]; then
  shopt -s nullglob
  for file in "$dir"/*; do
    name="$(basename "$file")"
    if [[ "$name" != *.json ]]; then
      echo "FAIL $name: only <host>.json belongs in data/aggregates/" >&2
      fail=1
      continue
    fi
    host="${name%.json}"
    if ! [[ "$host" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || [[ "$host" == *".."* ]]; then
      echo "FAIL $name: the filename is not a host label" >&2
      fail=1
      continue
    fi
    # Deliberately a grep and not a JSON parser: this has to run in a repo that has no Node
    # and no jq. It reads the `host` scalar the writer emits with two-space indentation.
    declared="$(sed -n 's/^  "host": "\([^"]*\)".*/\1/p' "$file" | head -1)"
    if [[ "$declared" != "$host" ]]; then
      echo "FAIL $name: declares host '$declared' but is named '$host'" >&2
      fail=1
    fi
  done
  shopt -u nullglob
fi

# ---- rule 2: one commit, one aggregate --------------------------------------
if [[ -n "$base" ]]; then
  changed="$(git -C "$corpus" diff --name-only "$base" -- data/aggregates/ | sort -u)"
  count="$(printf '%s' "$changed" | grep -c . || true)"
  if [[ "$count" -gt 1 ]]; then
    echo "FAIL: $count aggregate files changed in one range; one host publishes one file:" >&2
    printf '  %s\n' $changed >&2
    fail=1
  fi
fi

if [[ "$fail" -eq 0 ]]; then
  echo "aggregates: ok"
fi
exit "$fail"
