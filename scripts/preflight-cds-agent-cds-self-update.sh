#!/usr/bin/env bash
# ============================================
# CDS Agent R0 self-update preflight
# ============================================
#
# Read-only preflight before asking a human to approve updating the shared
# CDS control plane. This script never calls `cdscli self update`.
#
# Required:
#   CDS_HOST
#
# Optional:
#   CDS_SELF_UPDATE_BRANCH              default: codex/cds-agent-workbench-ui
#   SMOKE_CDS_BRANCH_ID                 default: prd-agent-codex-cds-agent-workbench-ui
#   SMOKE_CDS_AGENT_PREFLIGHT_REPORT    optional JSON report path
#   SMOKE_CDS_AGENT_RUN_ALIAS_PROBE     default: 1
#   SMOKE_CDS_AGENT_REQUIRE_TARGET_MATCH default: 1
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDS_SELF_UPDATE_BRANCH="${CDS_SELF_UPDATE_BRANCH:-codex/cds-agent-workbench-ui}"
SMOKE_CDS_BRANCH_ID="${SMOKE_CDS_BRANCH_ID:-prd-agent-codex-cds-agent-workbench-ui}"
SMOKE_CDS_AGENT_PREFLIGHT_REPORT="${SMOKE_CDS_AGENT_PREFLIGHT_REPORT:-}"
SMOKE_CDS_AGENT_RUN_ALIAS_PROBE="${SMOKE_CDS_AGENT_RUN_ALIAS_PROBE:-1}"
SMOKE_CDS_AGENT_REQUIRE_TARGET_MATCH="${SMOKE_CDS_AGENT_REQUIRE_TARGET_MATCH:-1}"

if [[ -z "${CDS_HOST:-}" ]]; then
  printf 'CDS_HOST is required\n' >&2
  exit 1
fi

if [[ ! -f ".claude/skills/cds/cli/cdscli.py" ]]; then
  printf '.claude/skills/cds/cli/cdscli.py not found\n' >&2
  exit 1
fi

printf '==========================================\n'
printf 'CDS Agent R0 self-update preflight\n'
printf 'CDS_HOST: %s\n' "$CDS_HOST"
printf 'Target branch: %s\n' "$CDS_SELF_UPDATE_BRANCH"
printf 'Preview branch: %s\n' "$SMOKE_CDS_BRANCH_ID"
printf '==========================================\n'

local_head=$(git rev-parse --short=8 HEAD)
local_head_full=$(git rev-parse HEAD)
local_branch=$(git branch --show-current 2>/dev/null || printf 'unknown')

printf '\n>>> [1/5] Read CDS self branches\n'
self_branches_resp=$(CDS_HOST="$CDS_HOST" python3 .claude/skills/cds/cli/cdscli.py self branches)
printf '%s\n' "$self_branches_resp" | jq '{ok, current:.data.current, commitHash:.data.commitHash}'
if [[ "$(printf '%s' "$self_branches_resp" | jq -r '.ok')" != "true" ]]; then
  printf 'cdscli self branches failed\n' >&2
  exit 1
fi
current_branch=$(printf '%s' "$self_branches_resp" | jq -r '.data.current // "unknown"')
current_commit=$(printf '%s' "$self_branches_resp" | jq -r '.data.commitHash // "unknown"')
target_branch_json=$(printf '%s' "$self_branches_resp" | jq -c --arg branch "$CDS_SELF_UPDATE_BRANCH" 'first(.data.branchDetails[]? | select(.name == $branch)) // empty')
if [[ -z "$target_branch_json" ]]; then
  printf 'target branch not found in CDS self branches: %s\n' "$CDS_SELF_UPDATE_BRANCH" >&2
  exit 1
fi
target_commit=$(printf '%s' "$target_branch_json" | jq -r '.commitHash // "unknown"')
target_subject=$(printf '%s' "$target_branch_json" | jq -r '.subject // ""')
target_cds_touched=$(printf '%s' "$target_branch_json" | jq -r '.cdsTouched // false')
printf 'Current CDS: branch=%s commit=%s\n' "$current_branch" "$current_commit"
printf 'Target CDS: branch=%s commit=%s cdsTouched=%s subject=%s\n' \
  "$CDS_SELF_UPDATE_BRANCH" "$target_commit" "$target_cds_touched" "$target_subject"
printf 'Local worktree: branch=%s HEAD=%s\n' "$local_branch" "$local_head"
target_matches_local=false
if [[ "$local_head_full" == "$target_commit"* || "$target_commit" == "$local_head_full"* ]]; then
  target_matches_local=true
  printf 'Target commit check: matches local HEAD\n'
else
  printf 'Target commit check: CDS sees %s but local HEAD is %s\n' "$target_commit" "$local_head"
fi

printf '\n>>> [2/5] Verify local stale-alias cleanup code exists\n'
if rg -q 'pruneStaleAppContainersForProfile' cds/src/services/container.ts; then
  local_cleanup_present=true
  printf 'local cleanup code: present\n'
else
  local_cleanup_present=false
  printf 'local cleanup code: missing\n' >&2
fi

printf '\n>>> [3/5] Read preview branch status\n'
branch_status_resp=$(CDS_HOST="$CDS_HOST" python3 .claude/skills/cds/cli/cdscli.py branch status "$SMOKE_CDS_BRANCH_ID")
printf '%s\n' "$branch_status_resp" | jq '{ok, status:.data.status, commitSha:.data.commitSha, subject:.data.subject, services:(.data.services | keys)}'
if [[ "$(printf '%s' "$branch_status_resp" | jq -r '.ok')" != "true" ]]; then
  printf 'cdscli branch status failed\n' >&2
  exit 1
fi
preview_status=$(printf '%s' "$branch_status_resp" | jq -r '.data.status // "unknown"')
preview_commit=$(printf '%s' "$branch_status_resp" | jq -r '.data.commitSha // "unknown"')

printf '\n>>> [4/5] Optional R0 alias probe\n'
alias_probe_status="skipped"
alias_probe_log=""
alias_probe_message="skipped"
if [[ "$SMOKE_CDS_AGENT_RUN_ALIAS_PROBE" == "1" ]]; then
  alias_probe_alias="${SMOKE_CDS_AGENT_SIDECAR_ALIAS:-claude-agent-sdk-runtime-v2-prd-agent}"
  if [[ "$alias_probe_alias" =~ (^|[-_])claude-agent-sdk-runtime ]] \
    && [[ "${SMOKE_CDS_AGENT_ALLOW_BRANCH_LOCAL_ALIAS_PROBE:-0}" != "1" ]]; then
    alias_probe_status="skipped_branch_local_alias_guarded"
    alias_probe_message="branch-local sidecar alias probe is intentionally blocked by the governance guard"
    printf 'alias probe: %s (%s)\n' "$alias_probe_status" "$alias_probe_message"
  else
    alias_probe_log="${SMOKE_CDS_AGENT_PREFLIGHT_REPORT:-/tmp/cds-agent-self-update-preflight.json}.alias.log"
    if CDS_HOST="$CDS_HOST" bash "$SCRIPT_DIR/smoke-cds-agent-sidecar-alias-stability.sh" >"$alias_probe_log" 2>&1; then
      alias_probe_status="pass"
      alias_probe_message="passed"
    else
      alias_probe_status="failed"
      alias_probe_message="failed"
    fi
    printf 'alias probe: %s log=%s\n' "$alias_probe_status" "$alias_probe_log"
    tail -n 30 "$alias_probe_log"
  fi
else
  printf 'alias probe: skipped\n'
fi

recommended_command="CDS_HOST=${CDS_HOST} python3 .claude/skills/cds/cli/cdscli.py self update --branch ${CDS_SELF_UPDATE_BRANCH}"
recommendation_status="ready_for_human_approval"
recommendation_message="If the human approves the shared control-plane update, run:"
if [[ "$SMOKE_CDS_AGENT_REQUIRE_TARGET_MATCH" == "1" && "$target_matches_local" != "true" ]]; then
  recommendation_status="blocked_target_commit_mismatch"
  recommendation_message="Target branch commit does not match local HEAD. Wait for CDS self branches to refresh or verify the target branch before approval."
  recommended_command=""
fi
printf '\n>>> [5/5] Recommendation\n'
printf 'This preflight is read-only. It does not approve or run CDS self update.\n'
printf '%s\n' "$recommendation_message"
if [[ -n "$recommended_command" ]]; then
  printf '  %s\n' "$recommended_command"
fi

if [[ -n "$SMOKE_CDS_AGENT_PREFLIGHT_REPORT" ]]; then
  mkdir -p "$(dirname "$SMOKE_CDS_AGENT_PREFLIGHT_REPORT")"
  jq -n \
    --arg host "$CDS_HOST" \
    --arg currentBranch "$current_branch" \
    --arg currentCommit "$current_commit" \
    --arg localBranch "$local_branch" \
    --arg localHead "$local_head" \
    --arg localHeadFull "$local_head_full" \
    --arg targetBranch "$CDS_SELF_UPDATE_BRANCH" \
    --arg targetCommit "$target_commit" \
    --arg targetSubject "$target_subject" \
    --arg previewBranch "$SMOKE_CDS_BRANCH_ID" \
    --arg previewStatus "$preview_status" \
    --arg previewCommit "$preview_commit" \
    --arg aliasProbeStatus "$alias_probe_status" \
    --arg aliasProbeLog "$alias_probe_log" \
    --arg aliasProbeMessage "$alias_probe_message" \
    --arg recommendationStatus "$recommendation_status" \
    --arg recommendationMessage "$recommendation_message" \
    --arg recommendedCommand "$recommended_command" \
    --argjson targetCdsTouched "$target_cds_touched" \
    --argjson targetMatchesLocalHead "$target_matches_local" \
    --argjson localCleanupPresent "$local_cleanup_present" \
    '{
      host: $host,
      currentControlPlane: {
        branch: $currentBranch,
        commit: $currentCommit
      },
      localWorktree: {
        branch: $localBranch,
        head: $localHead,
        headFull: $localHeadFull
      },
      targetControlPlane: {
        branch: $targetBranch,
        commit: $targetCommit,
        subject: $targetSubject,
        cdsTouched: $targetCdsTouched,
        matchesLocalHead: $targetMatchesLocalHead
      },
      preview: {
        branchId: $previewBranch,
        status: $previewStatus,
        commit: $previewCommit
      },
      r0AliasProbe: {
        status: $aliasProbeStatus,
        log: $aliasProbeLog,
        message: $aliasProbeMessage
      },
      localCleanupPresent: $localCleanupPresent,
      nextActionRequiresHumanApproval: true,
      recommendationStatus: $recommendationStatus,
      recommendationMessage: $recommendationMessage,
      recommendedCommand: $recommendedCommand
    }' > "$SMOKE_CDS_AGENT_PREFLIGHT_REPORT"
  printf 'Preflight report: %s\n' "$SMOKE_CDS_AGENT_PREFLIGHT_REPORT"
fi
