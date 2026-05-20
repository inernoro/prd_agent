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

assert_contains_any() {
  local haystack="$1"
  local name="$2"
  shift 2
  local needle
  for needle in "$@"; do
    if [[ "$haystack" == *"$needle"* ]]; then
      return 0
    fi
  done
  fail "$name should contain one of: $*"
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
runtime_relation=$(jq -r '.remoteCdsBranch.runtimeRelation // ""' "$json_index")
deploy_advice=$(jq -r '.remoteCdsBranch.deployAdvice // ""' "$json_index")
assert_nonempty "$runtime_relation" "remoteCdsBranch.runtimeRelation"
assert_nonempty "$deploy_advice" "remoteCdsBranch.deployAdvice"
case "$runtime_relation" in
  runtime_matches_head)
    assert_contains "$deploy_advice" "do not redeploy" "remoteCdsBranch.deployAdvice"
    ;;
  runtime_behind_non_runtime_drift)
    assert_contains "$deploy_advice" "do not self update" "remoteCdsBranch.deployAdvice"
    ;;
  *)
    assert_contains "$deploy_advice" "self update" "remoteCdsBranch.deployAdvice"
    ;;
esac

assert_nonempty "$(jq -r '.providerPrerequisites.status // ""' "$json_index")" "providerPrerequisites.status"
assert_eq "$(jq -r '.visualCoverage.assertionsPassed // false' "$json_index")" "true" "visualCoverage.assertionsPassed"
visual_required_text="$(jq -r '.visualCoverage.required[]?' "$json_index")"
assert_contains_any "$visual_required_text" "visualCoverage.required.execution" "执行链路" "execution chain"
assert_contains_any "$visual_required_text" "visualCoverage.required.runtime" "CDS Runtime" "runtime status"
assert_contains_any "$visual_required_text" "visualCoverage.required.provider" "模型需调整" "provider/profile guidance"
assert_contains_any "$visual_required_text" "visualCoverage.required.sdk" "Claude/Anthropic" "official SDK adapter"
assert_contains_any "$visual_required_text" "visualCoverage.required.map-session" "MAP 会话" "MAP session"
assert_contains_any "$visual_required_text" "visualCoverage.required.sandbox" "Worker Sandbox" "worker sandbox"
provider_calls_requested=$(jq -r 'if (.providerPrerequisites | has("providerCallsRequested")) then (.providerPrerequisites.providerCallsRequested | tostring) else "" end' "$json_index")
r1_repair_key_provided=$(jq -r 'if (.providerPrerequisites | has("r1RepairKeyProvided")) then (.providerPrerequisites.r1RepairKeyProvided | tostring) else "" end' "$json_index")
can_collect_provider_smokes=$(jq -r 'if (.providerPrerequisites | has("canCollectProviderSmokes")) then (.providerPrerequisites.canCollectProviderSmokes | tostring) else "" end' "$json_index")
[[ "$provider_calls_requested" == "true" || "$provider_calls_requested" == "false" ]] || fail "providerPrerequisites.providerCallsRequested must be boolean"
[[ "$r1_repair_key_provided" == "true" || "$r1_repair_key_provided" == "false" ]] || fail "providerPrerequisites.r1RepairKeyProvided must be boolean"
[[ "$can_collect_provider_smokes" == "true" || "$can_collect_provider_smokes" == "false" ]] || fail "providerPrerequisites.canCollectProviderSmokes must be boolean"
provider_prereq_status="$(jq -r '.providerPrerequisites.status // ""' "$json_index")"
if [[ "$provider_calls_requested" == "false" ]]; then
  assert_eq "$can_collect_provider_smokes" "false" "providerPrerequisites.canCollectProviderSmokes"
elif [[ "$r1_repair_key_provided" == "false" && "$provider_prereq_status" != "provider_profile_ready" ]]; then
  assert_eq "$can_collect_provider_smokes" "false" "providerPrerequisites.canCollectProviderSmokes"
fi

assert_nonempty "$(jq -r '.r1Repair.status // ""' "$json_index")" "r1Repair.status"
assert_nonempty "$(jq -r '.r1Repair.currentProfile.name // ""' "$json_index")" "r1Repair.currentProfile.name"
assert_nonempty "$(jq -r '.r1Repair.currentProfile.protocol // ""' "$json_index")" "r1Repair.currentProfile.protocol"
assert_nonempty "$(jq -r '.r1Repair.currentProfile.model // ""' "$json_index")" "r1Repair.currentProfile.model"
assert_nonempty "$(jq -r '.r1Repair.targetTemplate.id // .r1Repair.repairPlan.targetTemplateId // ""' "$json_index")" "r1Repair.targetTemplate"
if [[ "$(jq -r '.r1Repair.status // ""' "$json_index")" == "already_pass" ]]; then
  assert_eq "$(jq -r '.providerPrerequisites.status // ""' "$json_index")" "provider_profile_ready" "providerPrerequisites.status"
else
  assert_eq "$(jq -r '.r1Repair.missingKeyGuard.errorCode // ""' "$json_index")" "api_key_required" "r1Repair.missingKeyGuard.errorCode"
fi
assert_eq "$(jq -r '.r1Repair.providerKeyReceived // false' "$json_index")" "false" "r1Repair.providerKeyReceived"
assert_nonempty "$(jq -r '.r1Repair.suggestedCommand // ""' "$json_index")" "r1Repair.suggestedCommand"
if [[ "$(jq -r '.r1Repair.nextCommands | type' "$json_index")" == "object" ]]; then
  assert_contains "$(jq -r '.r1Repair.nextCommands.dryRun // ""' "$json_index")" "bash scripts/smoke-cds-agent-r1-profile-repair.sh" "r1Repair.nextCommands.dryRun"
  assert_contains "$(jq -r '.r1Repair.nextCommands.repairOnly // ""' "$json_index")" "SMOKE_CDS_AGENT_ANTHROPIC_API_KEY" "r1Repair.nextCommands.repairOnly"
  assert_contains "$(jq -r '.r1Repair.nextCommands.repairOnly // ""' "$json_index")" "smoke-cds-agent-r1-profile-repair.sh" "r1Repair.nextCommands.repairOnly"
  provider_cycle_command="$(jq -r '.r1Repair.nextCommands.providerCycle // .r1Repair.nextCommands.repairAndProviderCycle // ""' "$json_index")"
  assert_contains "$provider_cycle_command" "SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1" "r1Repair.nextCommands.providerCycle"
  assert_contains "$provider_cycle_command" "smoke-cds-agent-one-cycle.sh" "r1Repair.nextCommands.providerCycle"
fi
if [[ "$status" == "blocked_r1" ]]; then
  assert_contains "$(jq -r '.r1Repair.suggestedCommand // ""' "$json_index")" "smoke-cds-agent-r1-profile-repair.sh" "r1Repair.suggestedCommand"
  if [[ "$(jq -r '.host // ""' "$json_index")" == https://* ]]; then
    assert_contains "$(jq -r '.nextCommand // ""' "$json_index")" "CDS_HOST=" "nextCommand"
    assert_contains "$(jq -r '.r1Repair.suggestedCommand // ""' "$json_index")" "CDS_HOST=" "r1Repair.suggestedCommand"
    assert_contains "$(jq -r '.r1Repair.nextCommands.dryRun // ""' "$json_index")" "CDS_HOST=" "r1Repair.nextCommands.dryRun"
  fi
fi
if [[ "$(jq -r '.nextCyclePlan | type' "$json_index")" == "object" ]]; then
  assert_eq "$(jq -r '.nextCyclePlan.cycle // ""' "$json_index")" "official-sdk-provider-closure" "nextCyclePlan.cycle"
  assert_nonempty "$(jq -r '.nextCyclePlan.state // ""' "$json_index")" "nextCyclePlan.state"
  assert_eq "$(jq -r '[.nextCyclePlan.items[]? | select(.code == "N1")] | length' "$json_index")" "1" "nextCyclePlan.N1"
  assert_eq "$(jq -r '[.nextCyclePlan.items[]? | select(.code == "N6")] | length' "$json_index")" "1" "nextCyclePlan.N6"
  assert_contains "$(jq -r '.nextCyclePlan.stopConditions[]?' "$json_index")" "N1-N5" "nextCyclePlan.stopConditions"
fi

md_text=$(cat "$md_index")
assert_contains "$md_text" "Remote CDS branch" "evidence-index.md"
assert_contains "$md_text" "Provider prerequisites" "evidence-index.md"
assert_contains "$md_text" "Visual Coverage" "evidence-index.md"
assert_contains "$md_text" "Execution runway assertions" "evidence-index.md"
assert_contains "$md_text" "R1 Repair Path" "evidence-index.md"
if [[ "$(jq -r '.r1Repair.status // ""' "$json_index")" == "already_pass" ]]; then
  assert_contains "$md_text" "Missing-key guard: \`not-required-provider-profile-ready\`" "evidence-index.md"
else
  assert_contains "$md_text" "Missing-key guard: \`api_key_required\`" "evidence-index.md"
fi
assert_contains "$md_text" "Test-before-promote" "evidence-index.md"
if [[ "$(jq -r '.r1Repair.suggestedRepairCommand // ""' "$json_index")" != "" ]]; then
  assert_contains "$md_text" "Repair-only command" "evidence-index.md"
fi
if [[ "$(jq -r '.nextCyclePlan | type' "$json_index")" == "object" ]]; then
  assert_contains "$md_text" "Next Cycle Plan" "evidence-index.md"
fi
case "$runtime_relation" in
  runtime_matches_head)
    assert_contains "$md_text" "do not redeploy" "evidence-index.md"
    ;;
  runtime_behind_non_runtime_drift)
    assert_contains "$md_text" "do not self update" "evidence-index.md"
    ;;
  *)
    assert_contains "$md_text" "self update" "evidence-index.md"
    ;;
esac

printf 'CDS Agent evidence index smoke: pass\n'
printf 'Summary: %s\n' "$summary"
printf 'Index: %s\n' "$md_index"
