#!/usr/bin/env bash
# Validate the branch-isolation dry-run apply manifest.
#
# This smoke is intentionally local/read-only. It does not call CDS and does not
# delete anything. Pass the summary from
# scripts/run-cds-agent-branch-isolation-repair-with-evidence.sh.
#
# Usage:
#   bash scripts/smoke-cds-agent-branch-isolation-manifest.sh /tmp/.../summary.json
#
# Optional:
#   CDS_AGENT_BRANCH_ISOLATION_MANIFEST_SUMMARY=/tmp/.../summary.json
#   SMOKE_CDS_AGENT_EXPECTED_PROFILE_ID=claude-agent-sdk-runtime-v2-prd-agent

set -euo pipefail

SUMMARY="${1:-${CDS_AGENT_BRANCH_ISOLATION_MANIFEST_SUMMARY:-}}"
EXPECTED_PROFILE_ID="${SMOKE_CDS_AGENT_EXPECTED_PROFILE_ID:-claude-agent-sdk-runtime-v2-prd-agent}"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

ok() {
  printf 'OK: %s\n' "$*"
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  [[ "$actual" == "$expected" ]] || fail "$label expected '$expected' got '$actual'"
  ok "$label"
}

assert_manifest_precondition() {
  local code="$1"
  local expected="$2"
  local actual
  actual=$(jq -r --arg code "$code" '
    first(.applyManifest.preconditions[]? | select(.code == $code) | (.passed | tostring)) // "missing"
  ' "$SUMMARY")
  assert_eq "$actual" "$expected" "precondition.$code"
}

[[ -n "$SUMMARY" ]] || fail "summary path is required"
[[ -f "$SUMMARY" ]] || fail "summary not found: $SUMMARY"
command -v jq >/dev/null 2>&1 || fail "missing dependency: jq"

printf '==========================================\n'
printf 'CDS Agent branch isolation manifest smoke\n'
printf 'Summary: %s\n' "$SUMMARY"
printf '==========================================\n'

assert_eq "$(jq -r '.apply | tostring' "$SUMMARY")" "false" "dry-run apply flag"
assert_eq "$(jq -r '.verdict // ""' "$SUMMARY")" "dry-run-contaminated" "dry-run verdict"
assert_eq "$(jq -r '.repair.status // ""' "$SUMMARY")" "dry_run" "repair status"
assert_eq "$(jq -r '(.repair.deletedProfileIds // []) | length' "$SUMMARY")" "0" "deleted profile count"
assert_eq "$(jq -r '(.repair.candidateProfileIds // []) | length' "$SUMMARY")" "1" "candidate profile count"
assert_eq "$(jq -r '.repair.candidateProfileIds[0] // ""' "$SUMMARY")" "$EXPECTED_PROFILE_ID" "candidate profile id"

assert_eq "$(jq -r '.applyManifest.safety // ""' "$SUMMARY")" "destructive_remote_delete_build_profile" "manifest safety"
assert_eq "$(jq -r '.applyManifest.method // ""' "$SUMMARY")" "DELETE" "manifest method"
assert_eq "$(jq -r '.applyManifest.endpoint // ""' "$SUMMARY")" "https://cds.miduo.org/api/build-profiles/$EXPECTED_PROFILE_ID" "manifest endpoint"
assert_eq "$(jq -r '.applyManifest.requiredEnv | index("SMOKE_CDS_AGENT_BRANCH_ISOLATION_APPLY=1") != null' "$SUMMARY")" "true" "manifest apply env"
assert_eq "$(jq -r '.applyManifest.requiredEnv | index("SMOKE_CDS_AGENT_BRANCH_ISOLATION_CONFIRM_PROFILE_ID=<unique candidateProfileIds[0]>") != null' "$SUMMARY")" "true" "manifest confirm env"
assert_eq "$(jq -r '.applyManifest.expectedPostCheck // ""' "$SUMMARY")" "SMOKE_CDS_AGENT_BRANCH_ISOLATION_REMOTE=1 bash scripts/smoke-cds-agent-branch-isolation.sh" "manifest post-check"

assert_manifest_precondition "unique_candidate_profile" "true"
assert_manifest_precondition "confirmation_matches_candidate" "false"
assert_manifest_precondition "apply_flag_enabled" "false"

ok "branch isolation dry-run manifest is explicit and fail-closed"
