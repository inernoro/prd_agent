#!/usr/bin/env bash
# ============================================
# 冒烟测试: CDS Agent cycle evidence index
# ============================================
#
# Rebuilds the one-cycle evidence index and asserts that it remains useful for
# human handoff: remote deploy/runtime state, R1 repair path, missing-key guard,
# and the next provider command must be present.
#
# Usage:
#   bash scripts/smoke-cds-agent-evidence-index.sh /tmp/cds-agent-cycle-.../cycle-summary.json
#
# Optional:
#   SMOKE_CDS_AGENT_CYCLE_SUMMARY=/tmp/cds-agent-cycle-.../cycle-summary.json
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

summary="${1:-${SMOKE_CDS_AGENT_CYCLE_SUMMARY:-}}"

find_latest_cycle_summary() {
  local latest search_roots
  search_roots=$(printf '%s\n/tmp\n/private/tmp\n' "${TMPDIR:-/tmp}" | awk '!seen[$0]++')
  latest=$(while IFS= read -r root; do
    [[ -d "$root" ]] || continue
    find "$root" -maxdepth 2 -path '*/cds-agent-cycle-*/cycle-summary.json' -type f -print 2>/dev/null | while IFS= read -r file; do
      printf '%s\t%s\n' "$(stat -f '%m' "$file" 2>/dev/null || stat -c '%Y' "$file" 2>/dev/null || printf '0')" "$file"
    done || true
  done <<< "$search_roots" | sort -n | tail -n 1 | cut -f2- || true)
  [[ -n "$latest" ]] && printf '%s' "$latest"
  return 0
}

fail() {
  printf 'Evidence index smoke failed: %s\n' "$*" >&2
  exit 1
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local name="$3"
  [[ "$actual" == "$expected" ]] || fail "$name expected '$expected' but got '$actual'"
}

assert_nonempty() {
  local value="$1"
  local name="$2"
  [[ -n "$value" && "$value" != "null" ]] || fail "$name is empty"
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local name="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "$name should contain '$needle'"
}

if [[ -z "$summary" ]]; then
  summary=$(find_latest_cycle_summary)
fi
[[ -n "$summary" && -f "$summary" ]] || fail "cycle summary not found"

bash "$SCRIPT_DIR/index-cds-agent-cycle-evidence.sh" "$summary" >/dev/null

cycle_dir="$(cd "$(dirname "$summary")" && pwd)"
json_index="$cycle_dir/evidence-index.json"
md_index="$cycle_dir/evidence-index.md"
[[ -f "$json_index" ]] || fail "evidence-index.json not generated"
[[ -f "$md_index" ]] || fail "evidence-index.md not generated"

schema_version=$(jq -r '.schemaVersion // ""' "$json_index")
assert_eq "$schema_version" "cds-agent-cycle-evidence-index/v1" "schemaVersion"

status=$(jq -r '.status // ""' "$json_index")
assert_nonempty "$status" "status"

remote_observed=$(jq -r '.remoteCdsBranch.observed // false' "$json_index")
assert_eq "$remote_observed" "true" "remoteCdsBranch.observed"
assert_nonempty "$(jq -r '.remoteCdsBranch.branchId // ""' "$json_index")" "remoteCdsBranch.branchId"
assert_nonempty "$(jq -r '.remoteCdsBranch.githubCommitSha // ""' "$json_index")" "remoteCdsBranch.githubCommitSha"
assert_nonempty "$(jq -r '.remoteCdsBranch.runtimeCommitSha // ""' "$json_index")" "remoteCdsBranch.runtimeCommitSha"
assert_nonempty "$(jq -r '.remoteCdsBranch.runtimeRelation // ""' "$json_index")" "remoteCdsBranch.runtimeRelation"
assert_contains "$(jq -r '.remoteCdsBranch.deployAdvice // ""' "$json_index")" "self update" "remoteCdsBranch.deployAdvice"

assert_nonempty "$(jq -r '.r1Repair.status // ""' "$json_index")" "r1Repair.status"
assert_nonempty "$(jq -r '.r1Repair.currentProfile.name // ""' "$json_index")" "r1Repair.currentProfile.name"
assert_nonempty "$(jq -r '.r1Repair.currentProfile.protocol // ""' "$json_index")" "r1Repair.currentProfile.protocol"
assert_nonempty "$(jq -r '.r1Repair.currentProfile.model // ""' "$json_index")" "r1Repair.currentProfile.model"
assert_nonempty "$(jq -r '.r1Repair.targetTemplate.id // .r1Repair.repairPlan.targetTemplateId // ""' "$json_index")" "r1Repair.targetTemplate"
assert_eq "$(jq -r '.r1Repair.missingKeyGuard.errorCode // ""' "$json_index")" "api_key_required" "r1Repair.missingKeyGuard.errorCode"
assert_eq "$(jq -r '.r1Repair.providerKeyReceived // false' "$json_index")" "false" "r1Repair.providerKeyReceived"
assert_contains "$(jq -r '.r1Repair.suggestedCommand // ""' "$json_index")" "SMOKE_CDS_AGENT_ANTHROPIC_API_KEY" "r1Repair.suggestedCommand"

md_text=$(cat "$md_index")
assert_contains "$md_text" "Remote CDS branch" "evidence-index.md"
assert_contains "$md_text" "R1 Repair Path" "evidence-index.md"
assert_contains "$md_text" "Missing-key guard: \`api_key_required\`" "evidence-index.md"
assert_contains "$md_text" "Test-before-promote" "evidence-index.md"
assert_contains "$md_text" "do not self update" "evidence-index.md"

printf 'CDS Agent evidence index smoke: pass\n'
printf 'Summary: %s\n' "$summary"
printf 'Index: %s\n' "$md_index"
