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
grep -Fqx '          REF_PROTECTED: ${{ github.ref_protected }}' "$WORKFLOW" || \
  fail 'ref-gate does not pass github.ref_protected'
grep -Fq '[[ "$REF_PROTECTED" == "true" ]] || die' "$WORKFLOW" || \
  fail 'main gate does not require REF_PROTECTED=true'
grep -Fq 'refs/heads/main)' "$WORKFLOW" || fail 'main branch case is missing'
grep -Fq 'refs/tags/*)' "$WORKFLOW" || fail 'release tag case is missing'
grep -Fq '[[ "$tag" =~ $semver_tag ]] || die' "$WORKFLOW" || \
  fail 'release tag does not retain the semver gate'
ok 'workflow contains the protected-main gate and semver tag branch'

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
  local ref_protected=$4
  local expected=$5
  local log="$T/$label.log"

  if [[ "$expected" == pass ]]; then
    if ! (
      cd "$T"
      EVENT_NAME="$event_name" REF="$ref" REF_PROTECTED="$ref_protected" \
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
    EVENT_NAME="$event_name" REF="$ref" REF_PROTECTED="$ref_protected" \
      bash "$GATE_SCRIPT" > "$log" 2>&1
  ); then
    sed -n '1,80p' "$log" >&2 || true
    fail "$label should reject"
  fi
  ok "$label -> reject"
}

# main must come from a ref GitHub marks as protected.
run_gate main-protected push refs/heads/main true pass
run_gate main-unprotected push refs/heads/main false reject

# release tags are an explicit rule independent of ref_protected.
run_gate semver-release-tag push refs/tags/v1.2.3 false pass
run_gate semver-prerelease-tag workflow_dispatch refs/tags/v2.0.0-rc.1 false pass

# Other events, branches, and invalid tags must be rejected.
run_gate ordinary-branch push refs/heads/feature false reject
run_gate invalid-tag push refs/tags/v1.2 false reject
run_gate unknown-event schedule refs/heads/main true reject

printf '\npublish workflow ref-gate tests passed (%s checks).\n' "$PASS"
