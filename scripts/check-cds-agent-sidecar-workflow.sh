#!/usr/bin/env bash
# Check the GitHub Actions sidecar image workflow status.
# Default mode is dry-run. It only calls GitHub when
# CDS_AGENT_WORKFLOW_CHECK=1.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

REPORT="${CDS_AGENT_WORKFLOW_REPORT:-/tmp/cds-agent-sidecar-workflow-current.json}"
LOG="${CDS_AGENT_WORKFLOW_LOG:-/tmp/cds-agent-sidecar-workflow-current.log}"
CHECK="${CDS_AGENT_WORKFLOW_CHECK:-0}"
WORKFLOW="${CDS_AGENT_WORKFLOW_FILE:-cds-sidecar-image.yml}"
REMOTE="${CDS_AGENT_GITHUB_REMOTE:-origin}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "missing dependency: jq"

derive_owner_repo() {
  local repo_url owner_repo
  repo_url="$(git -C "$ROOT_DIR" remote get-url "$REMOTE" 2>/dev/null || printf '')"
  owner_repo="inernoro/prd_agent"
  case "$repo_url" in
    https://github.com/*/*.git|https://github.com/*/*)
      owner_repo="${repo_url#https://github.com/}"
      owner_repo="${owner_repo%.git}"
      ;;
    git@github.com:*/*.git|git@github.com:*/*)
      owner_repo="${repo_url#git@github.com:}"
      owner_repo="${owner_repo%.git}"
      ;;
  esac
  printf '%s' "$owner_repo"
}

derive_current_image() {
  local owner_repo short_sha image
  owner_repo="$1"
  short_sha="$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD 2>/dev/null || printf local)"
  image="ghcr.io/${owner_repo%/*}/${owner_repo#*/}/claude-sidecar:$short_sha"
  printf '%s' "$image" | tr '[:upper:]_' '[:lower:]-'
}

write_report() {
  local status="$1"
  local detail="$2"
  local api_attempted="$3"
  local run_found="$4"
  local exit_code="$5"
  local tmp_report
  tmp_report="${REPORT}.tmp.$$"
  mkdir -p "$(dirname "$REPORT")"
  jq -n \
    --arg generatedAt "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    --arg report "$REPORT" \
    --arg status "$status" \
    --arg detail "$detail" \
    --arg ownerRepo "$owner_repo" \
    --arg workflow "$WORKFLOW" \
    --arg branch "$branch" \
    --arg commit "$commit" \
    --arg currentSidecarImage "$current_image" \
    --arg latestRunId "$latest_run_id" \
    --arg latestRunStatus "$latest_run_status" \
    --arg latestRunConclusion "$latest_run_conclusion" \
    --arg latestRunHeadSha "$latest_run_head_sha" \
    --arg latestRunHtmlUrl "$latest_run_html_url" \
    --arg workflowFileHtmlUrl "$workflow_file_html_url" \
    --arg log "$LOG" \
    --argjson checkEnabled "$([[ "$CHECK" == "1" ]] && printf true || printf false)" \
    --argjson apiAttempted "$api_attempted" \
    --argjson runFound "$run_found" \
    --argjson workflowFileVisible "$workflow_file_visible" \
    --argjson exitCode "$exit_code" \
    '{
      generatedAt: $generatedAt,
      report: $report,
      status: $status,
      detail: $detail,
      ownerRepo: $ownerRepo,
      workflow: $workflow,
      branch: $branch,
      commit: $commit,
      currentSidecarImage: $currentSidecarImage,
      checkEnabled: $checkEnabled,
      apiAttempted: $apiAttempted,
      runFound: $runFound,
      workflowFileVisible: $workflowFileVisible,
      workflowFileHtmlUrl: (if $workflowFileHtmlUrl == "" then null else $workflowFileHtmlUrl end),
      latestRun: {
        id: (if $latestRunId == "" then null else $latestRunId end),
        status: (if $latestRunStatus == "" then null else $latestRunStatus end),
        conclusion: (if $latestRunConclusion == "" then null else $latestRunConclusion end),
        headSha: (if $latestRunHeadSha == "" then null else $latestRunHeadSha end),
        htmlUrl: (if $latestRunHtmlUrl == "" then null else $latestRunHtmlUrl end)
      },
      log: $log,
      exitCode: $exitCode,
      nextAction: (
        if $status == "run_success" then
          "verify the published registry manifest"
        elif $status == "dry_run_ready" then
          "set CDS_AGENT_WORKFLOW_CHECK=1 to check GitHub Actions workflow status"
        elif $status == "workflow_file_on_branch_not_indexed" then
          "merge or expose the workflow on a branch GitHub Actions can dispatch, then re-check workflow status"
        else
          "use the manual publish handoff or inspect the GitHub Actions workflow"
        end
      )
    }' > "$tmp_report"
  mv "$tmp_report" "$REPORT"
}

owner_repo="$(derive_owner_repo)"
branch="$(git -C "$ROOT_DIR" branch --show-current 2>/dev/null || printf unknown)"
commit="$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD 2>/dev/null || printf unknown)"
current_image="$(derive_current_image "$owner_repo")"
latest_run_id=""
latest_run_status=""
latest_run_conclusion=""
latest_run_head_sha=""
latest_run_html_url=""
workflow_file_visible=false
workflow_file_html_url=""
: > "$LOG"

if [[ "$CHECK" != "1" ]]; then
  write_report "dry_run_ready" "set CDS_AGENT_WORKFLOW_CHECK=1 to query GitHub Actions" false false 0
elif ! command -v gh >/dev/null 2>&1; then
  write_report "missing_gh" "missing dependency: gh" false false 127
else
  tmp_response="$(mktemp)"
  trap 'rm -f "$tmp_response"' EXIT
  if gh api "repos/$owner_repo/actions/workflows/$WORKFLOW/runs" -F per_page=10 >"$tmp_response" 2>"$LOG"; then
    latest_run_id="$(jq -r '.workflow_runs[0].id // ""' "$tmp_response")"
    latest_run_status="$(jq -r '.workflow_runs[0].status // ""' "$tmp_response")"
    latest_run_conclusion="$(jq -r '.workflow_runs[0].conclusion // ""' "$tmp_response")"
    latest_run_head_sha="$(jq -r '.workflow_runs[0].head_sha // ""' "$tmp_response")"
    latest_run_html_url="$(jq -r '.workflow_runs[0].html_url // ""' "$tmp_response")"
    if [[ -z "$latest_run_id" ]]; then
      write_report "no_runs" "workflow is visible but has no runs" true false 0
    elif [[ "$latest_run_status" == "completed" && "$latest_run_conclusion" == "success" ]]; then
      write_report "run_success" "latest workflow run completed successfully" true true 0
    elif [[ "$latest_run_status" == "completed" ]]; then
      write_report "run_completed_not_success" "latest workflow run completed without success" true true 1
    else
      write_report "run_in_progress" "latest workflow run is not completed" true true 0
    fi
  else
    code=$?
    if grep -q '"status": "404"' "$LOG" || grep -q 'HTTP 404' "$LOG"; then
      tmp_content="$(mktemp)"
      if gh api "repos/$owner_repo/contents/.github/workflows/$WORKFLOW?ref=$branch" >"$tmp_content" 2>>"$LOG"; then
        workflow_file_visible=true
        workflow_file_html_url="$(jq -r '.html_url // ""' "$tmp_content")"
        rm -f "$tmp_content"
        write_report "workflow_file_on_branch_not_indexed" "workflow file exists on this branch, but GitHub Actions workflow API cannot dispatch or list it yet" true false 0
      else
        rm -f "$tmp_content"
        write_report "workflow_not_found" "GitHub API could not find the workflow or repository with current gh auth" true false "$code"
      fi
    else
      write_report "api_failed" "GitHub API workflow check failed; inspect log" true false "$code"
    fi
  fi
fi

printf '# CDS Agent Sidecar Workflow\n\n'
jq -r '
  "- report: `" + .report + "`",
  "- status: `" + .status + "`",
  "- workflow: `" + .workflow + "`",
  "- currentSidecarImage: `" + .currentSidecarImage + "`",
  "- checkEnabled: `" + (.checkEnabled|tostring) + "`",
  "- workflowFileVisible: `" + (.workflowFileVisible|tostring) + "`",
  "- latestRun: `" + ((.latestRun.id // "none")|tostring) + "`",
  "- detail: `" + .detail + "`",
  "- nextAction: `" + .nextAction + "`",
  "- log: `" + .log + "`"
' "$REPORT"

status="$(jq -r '.status' "$REPORT")"
[[ "$status" == "dry_run_ready" || "$status" == "no_runs" || "$status" == "run_success" || "$status" == "run_in_progress" || "$status" == "workflow_file_on_branch_not_indexed" || "$status" == "workflow_not_found" || "$status" == "api_failed" ]]
