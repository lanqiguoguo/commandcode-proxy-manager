#!/usr/bin/env bash
# Static and simulation tests for the publish.yml ref-gate.
# Extract the gate from the workflow so the test cannot drift from production.
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
WORKFLOW="$ROOT_DIR/.github/workflows/publish.yml"
T=$(mktemp -d)

cleanup() {
  rm -rf -- "$T"
}
trap cleanup EXIT INT TERM

PASS=0
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { printf 'ok: %s\n' "$*"; PASS=$((PASS + 1)); }

[[ -f "$WORKFLOW" ]] || fail "publish workflow is missing"

# ---------- workflow static boundaries ----------
grep -Fq '  workflow_call:' "$WORKFLOW" || fail 'workflow_call trigger is missing'
grep -Fq '      source_ref:' "$WORKFLOW" || fail 'source_ref input is missing'
grep -Fq '      source_sha:' "$WORKFLOW" || fail 'source_sha input is missing'
grep -Fq '  push:' "$WORKFLOW" || fail 'push trigger is missing'
grep -Fq '    tags:' "$WORKFLOW" || fail 'release tag trigger is missing'
if grep -Fq '    branches: [main]' "$WORKFLOW"; then
  fail 'main push must enter upstream-sync before publication'
fi
if grep -Fq 'github.ref_protected' "$WORKFLOW"; then
  fail 'publish workflow still depends on branch protection'
fi
if grep -Fq 'environment: release' "$WORKFLOW"; then
  fail 'publish workflow still has a potentially approval-gated environment'
fi
grep -Fq 'refs/heads/main)' "$WORKFLOW" || fail 'main source case is missing'
grep -Fq 'refs/tags/*)' "$WORKFLOW" || fail 'release tag case is missing'
grep -Fq '[[ "$tag" =~ $semver_tag ]] || die' "$WORKFLOW" || \
  fail 'release tag does not retain the semver gate'
grep -Fq 'ref: ${{ inputs.source_sha || github.sha }}' "$WORKFLOW" || \
  fail 'checkout is not pinned to the caller source SHA'
ok 'workflow contains the synchronized-main gate and semver tag branch'

# ---------- extract the ref-gate executed by the workflow ----------
GATE_SCRIPT="$T/gate.sh"
awk '
  /^      - name: Validate publish ref$/ { in_step = 1; next }
  in_step && /^        run: \|$/ { in_run = 1; next }
  in_run && /^      - name:/ { exit }
  in_run && /^          / { sub(/^          /, ""); print; next }
  in_run && /^[[:space:]]*$/ { print ""; next }
  in_run { exit }
' "$WORKFLOW" > "$GATE_SCRIPT"
[[ -s "$GATE_SCRIPT" ]] || fail 'could not extract the ref-gate script'
bash -n "$GATE_SCRIPT" || fail 'extracted ref-gate script has a syntax error'
ok 'extracted and checked the workflow ref-gate script'

run_gate() {
  local label=$1
  local event_name=$2
  local ref=$3
  local expected=$4
  local source_ref=${5:-}
  local source_sha=${6:-}
  local log="$T/$label.log"

  if [[ "$expected" == pass ]]; then
    if ! (
      cd "$T"
      EVENT_NAME="$event_name" REF="$ref" SOURCE_INPUT_REF="$source_ref" SOURCE_INPUT_SHA="$source_sha" \
        bash "$GATE_SCRIPT" > "$log" 2>&1
    ); then
      sed -n '1,80p' "$log" >&2 || true
      fail "$label should pass"
    fi
    grep -Fq 'publish ref accepted:' "$log" || fail "$label did not confirm acceptance"
    ok "$label -> pass"
    return
  fi

  if (
    cd "$T"
    EVENT_NAME="$event_name" REF="$ref" SOURCE_INPUT_REF="$source_ref" SOURCE_INPUT_SHA="$source_sha" \
      bash "$GATE_SCRIPT" > "$log" 2>&1
  ); then
    sed -n '1,80p' "$log" >&2 || true
    fail "$label should reject"
  fi
  ok "$label -> reject"
}

# main publication must come through the reusable workflow after sync. The
# caller event remains visible as push, so the required inputs identify it.
run_gate synchronized-main push refs/heads/main pass refs/heads/main 98502ffdea90928a0f68117eac40b05a0f28ab0b
run_gate synchronized-main-invalid-sha push refs/heads/main reject refs/heads/main not-a-sha
run_gate direct-main-push push refs/heads/main reject
run_gate manual-main workflow_dispatch refs/heads/main pass

# release tags are an explicit rule independent of the synchronized-main path.
run_gate semver-release-tag push refs/tags/v1.2.3 pass
run_gate semver-prerelease-tag workflow_dispatch refs/tags/v2.0.0-rc.1 pass

# Other events, branches, and invalid tags must be rejected.
run_gate ordinary-branch push refs/heads/feature reject
run_gate invalid-tag push refs/tags/v1.2 reject
run_gate unknown-event schedule refs/heads/main reject
run_gate unsupported-workflow-run workflow_run refs/heads/main reject

printf '\npublish workflow ref-gate tests passed (%s checks).\n' "$PASS"
