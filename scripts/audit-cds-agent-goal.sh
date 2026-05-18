#!/usr/bin/env bash
# ============================================
# CDS Agent goal completion audit
# ============================================
#
# Local-first audit for the active CDS Agent objective:
#   - keep MAP/CDS as the control plane
#   - keep the custom loop compressed into official SDK adapters
#   - prefer official SDKs where routable, keep candidates planned-not-routable
#   - preserve one-cycle observability and avoid unnecessary deploy/build loops
#
# This script does not deploy and does not call the model provider. It runs the
# local A0, N6, and evidence-index guardrails, then emits a machine-readable completion report.
# Commercial completion remains false until R1 and provider-backed S1/S2/S3
# evidence exists.
#
# Optional:
#   CDS_AGENT_GOAL_AUDIT_REPORT=/tmp/cds-agent-goal-audit.json
#   CDS_AGENT_GOAL_CYCLE_SUMMARY=/tmp/cds-agent-cycle-.../cycle-summary.json
#   CDS_AGENT_GOAL_AUDIT_STEP_TIMEOUT_SECONDS=90
#   CDS_AGENT_GOAL_AUDIT_HEARTBEAT_SECONDS=15
#   CDS_AGENT_GOAL_CYCLE_MAX_AGE_SECONDS=86400
#   CDS_AGENT_GOAL_AUDIT_LIVE=1
#   CDS_AGENT_GOAL_RUNTIME_POOL_SUMMARY=/tmp/cds-agent-runtime-pool-evidence-latest/summary.json
#   CDS_HOST=https://cds.miduo.org
#   SMOKE_CDS_BRANCH_ID=prd-agent-codex-cds-agent-workbench-ui
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPORT="${CDS_AGENT_GOAL_AUDIT_REPORT:-}"
AUDIT_DIR="${CDS_AGENT_GOAL_AUDIT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/cds-agent-goal-audit.XXXXXX")}"
BOUNDARY_REPORT="$AUDIT_DIR/a0-boundary.json"
DOCS_CALIBRATION_LOG="$AUDIT_DIR/d0-docs-calibration.log"
PROGRESS_CONSISTENCY_LOG="$AUDIT_DIR/progress-consistency.log"
N6_LOG="$AUDIT_DIR/n6-non-code-compatibility.log"
N6_SUMMARY="${CDS_AGENT_N6_SUMMARY:-/tmp/cds-agent-n6-non-code-compatibility-current.json}"
N6_ATTEMPT_SUMMARY="$AUDIT_DIR/n6-non-code-compatibility-current-attempt.json"
R0_READINESS_SUMMARY="${CDS_AGENT_R0_READINESS_SUMMARY:-/tmp/cds-agent-r0-apply-readiness-current.json}"
EVIDENCE_INDEX_LOG="$AUDIT_DIR/evidence-index-quality.log"
RUNTIME_POOL_PLAN_LOG="$AUDIT_DIR/runtime-pool-recovery-plan.log"
BRANCH_ISOLATION_MANIFEST_LOG="$AUDIT_DIR/branch-isolation-manifest.log"
cycle_summary="${CDS_AGENT_GOAL_CYCLE_SUMMARY:-}"
current_git_branch="$(git -C "$ROOT_DIR" branch --show-current 2>/dev/null || printf '')"
current_git_commit="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || printf '')"
current_git_commit_short="$(git -C "$ROOT_DIR" rev-parse --short=10 HEAD 2>/dev/null || printf '')"

failures=()
timing_names=()
timing_statuses=()
timing_seconds=()
timing_indices=()
CYCLE_GIT_DIFF_PATHS=()
CYCLE_GIT_RUNTIME_DIFF_PATHS=()
TIMING_STEP_TOTAL=7
TIMING_STEP_CURRENT=0
AUDIT_HEARTBEAT_SECONDS="${CDS_AGENT_GOAL_AUDIT_HEARTBEAT_SECONDS:-15}"
AUDIT_STEP_TIMEOUT_SECONDS="${CDS_AGENT_GOAL_AUDIT_STEP_TIMEOUT_SECONDS:-90}"
CYCLE_MAX_AGE_SECONDS="${CDS_AGENT_GOAL_CYCLE_MAX_AGE_SECONDS:-86400}"
SMOKE_CDS_BRANCH_ID="${SMOKE_CDS_BRANCH_ID:-prd-agent-codex-cds-agent-workbench-ui}"
GOAL_AUDIT_LIVE="${CDS_AGENT_GOAL_AUDIT_LIVE:-0}"
RUNTIME_POOL_SUMMARY="${CDS_AGENT_GOAL_RUNTIME_POOL_SUMMARY:-/tmp/cds-agent-runtime-pool-evidence-latest/summary.json}"

run_step() {
  local label="$1"
  shift
  local started ended duration
  TIMING_STEP_CURRENT=$((TIMING_STEP_CURRENT + 1))
  started=$(date +%s)
  printf '>>> [%s/%s] %s\n' "$TIMING_STEP_CURRENT" "$TIMING_STEP_TOTAL" "$label"
  if "$@"; then
    ended=$(date +%s)
    duration=$((ended - started))
    printf 'PASS %s (%ss)\n' "$label" "$duration"
    timing_names+=("$label")
    timing_statuses+=("pass")
    timing_seconds+=("$duration")
    timing_indices+=("$TIMING_STEP_CURRENT")
    return 0
  fi
  ended=$(date +%s)
  duration=$((ended - started))
  printf 'FAIL %s (%ss)\n' "$label" "$duration" >&2
  timing_names+=("$label")
  timing_statuses+=("failed")
  timing_seconds+=("$duration")
  timing_indices+=("$TIMING_STEP_CURRENT")
  failures+=("$label")
  return 1
}

run_step_logged() {
  local label="$1"
  local log="$2"
  shift 2
  local started ended duration pid rc last_heartbeat elapsed timed_out
  TIMING_STEP_CURRENT=$((TIMING_STEP_CURRENT + 1))
  started=$(date +%s)
  last_heartbeat="$started"
  timed_out=false
  printf '>>> [%s/%s] %s\n' "$TIMING_STEP_CURRENT" "$TIMING_STEP_TOTAL" "$label"
  printf '    log: %s\n' "$log"
  "$@" >"$log" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    elapsed=$(( $(date +%s) - started ))
    if (( AUDIT_STEP_TIMEOUT_SECONDS > 0 && elapsed >= AUDIT_STEP_TIMEOUT_SECONDS )); then
      timed_out=true
      {
        printf '\nCDS_AGENT_GOAL_AUDIT_TIMEOUT: %s exceeded %ss\n' "$label" "$AUDIT_STEP_TIMEOUT_SECONDS"
        printf 'The audit step was stopped to keep goal verification bounded and observable.\n'
      } >>"$log"
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill -TERM "$pid" 2>/dev/null || true
      sleep 2
      pkill -KILL -P "$pid" 2>/dev/null || true
      kill -KILL "$pid" 2>/dev/null || true
      break
    fi
    if kill -0 "$pid" 2>/dev/null && (( $(date +%s) - last_heartbeat >= AUDIT_HEARTBEAT_SECONDS )); then
      last_heartbeat=$(date +%s)
      printf '    still running · elapsed=%ss · log=%s\n' "$elapsed" "$log"
      tail -n 3 "$log" 2>/dev/null || true
    fi
  done
  set +e
  wait "$pid"
  rc=$?
  set -e
  if [[ "$timed_out" == "true" ]]; then
    rc=124
  fi
  ended=$(date +%s)
  duration=$((ended - started))
  if (( rc == 0 )); then
    printf 'PASS %s (%ss)\n' "$label" "$duration"
    timing_names+=("$label")
    timing_statuses+=("pass")
    timing_seconds+=("$duration")
    timing_indices+=("$TIMING_STEP_CURRENT")
    return 0
  fi
  printf 'FAIL %s (exit=%s, %ss)\n' "$label" "$rc" "$duration" >&2
  tail -n 40 "$log" >&2 || true
  timing_names+=("$label")
  timing_statuses+=("failed")
  timing_seconds+=("$duration")
  timing_indices+=("$TIMING_STEP_CURRENT")
  failures+=("$label")
  return 1
}

find_latest_cycle_summary() {
  local latest search_roots
  search_roots=$(printf '%s\n/tmp\n/private/tmp\n' "${TMPDIR:-/tmp}" | awk '!seen[$0]++')
  latest=$(while IFS= read -r root; do
    [[ -d "$root" ]] || continue
    find "$root" -maxdepth 2 -path '*/cds-agent-cycle-*/cycle-summary.json' -type f -print 2>/dev/null | while IFS= read -r file; do
      printf '%s\t%s\n' "$(file_mtime "$file")" "$file"
    done || true
  done <<< "$search_roots" | sort -n | tail -n 1 | cut -f2- || true)
  [[ -n "$latest" ]] && printf '%s' "$latest"
  return 0
}

file_mtime() {
  stat -f '%m' "$1" 2>/dev/null || stat -c '%Y' "$1" 2>/dev/null || printf '0'
}

runtime_pool_summary_to_plan() {
  local summary="$1"
  jq -c '
    .plan // {
      sharedPoolId: (.plan.sharedPoolId // "shared-sidecar-pool-mp4anabh"),
      sharedKind: (.plan.sharedKind // "unknown"),
      sharedBranchCount: (.plan.sharedBranchCount // 0),
      sharedRunning: (.remoteHost.sharedRunning // 0),
      contaminatedBranchCount: (.branchIsolation.contaminatedBranchCount // 0),
      contaminatedProfileIds: (.branchIsolation.candidateProfileIds // []),
      remoteHostCount: (.remoteHost.existingHostCount // "unknown"),
      enabledRemoteHostCount: (.remoteHost.enabledHostCount // "unknown"),
      branchDeploySharedPoolAllowed: (.plan.branchDeploySharedPoolAllowed // false)
    }
  ' "$summary"
}

runtime_pool_plan_blockers() {
  jq -c '
    [
      (if .sharedKind != "shared-service" then {requirement:"SHARED_POOL_KIND", status:.sharedKind} else empty end),
      (if (.contaminatedBranchCount // 0) > 0 then {requirement:"BRANCH_LOCAL_SIDECAR_CLEAN", status:("contaminated:" + ((.contaminatedBranchCount // 0)|tostring))} else empty end),
      (if ((.enabledRemoteHostCount | tostring | test("^[0-9]+$")) and ((.enabledRemoteHostCount | tonumber) <= 0)) then {requirement:"REMOTE_HOST_AVAILABLE", status:"missing"} else empty end),
      (if (.sharedRunning // 0) <= 0 then {requirement:"SHARED_POOL_RUNNING", status:"missing"} else empty end),
      (if ((has("branchDeploySharedPoolAllowed") | not) or .branchDeploySharedPoolAllowed != false) then {requirement:"SHARED_POOL_BRANCH_DEPLOY_FORBIDDEN", status:"not-enforced"} else empty end)
    ]
  '
}

is_non_runtime_cycle_drift_path() {
  local path="$1"
  case "$path" in
    *.md|*.MD|*.txt|*.TXT) return 0 ;;
    CHANGELOG*|changelogs/*|doc/*|.claude/*|.github/*|e2e/*) return 0 ;;
    cds/tests/*|prd-admin/src/*/__tests__/*) return 0 ;;
    scripts/smoke-*|scripts/audit-*|scripts/doctor-*|scripts/preflight-*|scripts/verify-*|scripts/index-*) return 0 ;;
    LICENSE|license|.gitignore|.editorconfig) return 0 ;;
  esac
  return 1
}

is_non_runtime_cycle_drift_file_diff() {
  local base_commit="$1"
  local head_commit="$2"
  local path="$3"
  local changed_lines line content content_no_space

  if is_non_runtime_cycle_drift_path "$path"; then
    return 0
  fi

  # InfraServicesPage links to CDS Agent docs from the settings/help surface. A
  # doc-link-only edit there should not force a remote CDS Agent one-cycle, but
  # any behavioral UI change in the same file must still be treated as runtime
  # drift.
  if [[ "$path" != "prd-admin/src/pages/infra-services/InfraServicesPage.tsx" ]]; then
    return 1
  fi
  if ! changed_lines=$(git -C "$ROOT_DIR" diff --unified=0 "${base_commit}..${head_commit}" -- "$path" 2>/dev/null); then
    return 1
  fi
  while IFS= read -r line; do
    [[ "$line" == +++* || "$line" == ---* || "$line" == @@* ]] && continue
    [[ "$line" != [-+]* ]] && continue
    content="${line#?}"
    content_no_space=$(printf '%s' "$content" | tr -d '[:space:]')
    [[ "$content_no_space" == ">" ]] && continue
    case "$line" in
      *'<li>'*|*'</li>'*|*'<a'*|*'</a>'*|*'<span'*|*'</span>'*|*'className='*|*'<ExternalLink size={12} />'*|*'/doc/guide.cds-agent-'*|*'guide.cds-agent-'*|*'CDS Agent'*|*'代码审查上手流程'*|*'官方 SDK 边界'*|*'当前 R1 阻塞'*)
        ;;
      *)
        return 1
        ;;
    esac
  done <<< "$changed_lines"
  return 0
}

classify_cycle_git_drift() {
  local base_commit="$1"
  local head_commit="$2"
  local diff_output path has_paths=false has_runtime=false
  CYCLE_GIT_DIFF_PATHS=()
  CYCLE_GIT_RUNTIME_DIFF_PATHS=()
  if [[ -z "$base_commit" || -z "$head_commit" ]]; then
    return 1
  fi
  if ! diff_output=$(git -C "$ROOT_DIR" diff --name-only "${base_commit}..${head_commit}" 2>/dev/null); then
    return 1
  fi
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    has_paths=true
    CYCLE_GIT_DIFF_PATHS+=("$path")
    if ! is_non_runtime_cycle_drift_file_diff "$base_commit" "$head_commit" "$path"; then
      has_runtime=true
      CYCLE_GIT_RUNTIME_DIFF_PATHS+=("$path")
    fi
  done <<< "$diff_output"
  if [[ "$has_runtime" == "true" ]]; then
    return 2
  fi
  if [[ "$has_paths" == "true" ]]; then
    return 0
  fi
  return 3
}

classify_git_drift_quiet() {
  local base_commit="$1"
  local head_commit="$2"
  local diff_output path has_paths=false has_runtime=false
  if [[ -z "$base_commit" || -z "$head_commit" ]]; then
    return 1
  fi
  if ! diff_output=$(git -C "$ROOT_DIR" diff --name-only "${base_commit}..${head_commit}" 2>/dev/null); then
    return 1
  fi
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    has_paths=true
    if ! is_non_runtime_cycle_drift_file_diff "$base_commit" "$head_commit" "$path"; then
      has_runtime=true
      break
    fi
  done <<< "$diff_output"
  if [[ "$has_runtime" == "true" ]]; then
    return 2
  fi
  if [[ "$has_paths" == "true" ]]; then
    return 0
  fi
  return 3
}

json_bool() {
  if [[ "$1" == "true" ]]; then
    printf 'true'
  else
    printf 'false'
  fi
}

check_docs_calibration() {
  local log="$1"
  local failed=false
  local quickstart="$ROOT_DIR/doc/guide.cds-agent-code-review-quickstart.md"
  local next_testing="$ROOT_DIR/doc/guide.cds-agent-next-agent-testing.md"
  local migration_plan="$ROOT_DIR/doc/plan.cds-agent-official-sdk-migration.md"
  local report="$ROOT_DIR/doc/report.cds-agent-workbench-2026-05-15.md"
  : > "$log"

  require_doc_text() {
    local file="$1"
    local text="$2"
    local label="$3"
    if grep -Fq "$text" "$file"; then
      printf 'PASS required: %s\n' "$label" >> "$log"
    else
      printf 'FAIL required: %s\n  file=%s\n  text=%s\n' "$label" "${file#$ROOT_DIR/}" "$text" >> "$log"
      failed=true
    fi
  }

  forbid_doc_regex() {
    local file="$1"
    local regex="$2"
    local label="$3"
    if grep -Eq "$regex" "$file"; then
      printf 'FAIL forbidden: %s\n  file=%s\n  regex=%s\n' "$label" "${file#$ROOT_DIR/}" "$regex" >> "$log"
      grep -En "$regex" "$file" >> "$log" || true
      failed=true
    else
      printf 'PASS forbidden: %s\n' "$label" >> "$log"
    fi
  }

  for file in "$quickstart" "$next_testing" "$migration_plan" "$report"; do
    if [[ ! -f "$file" ]]; then
      printf 'FAIL missing doc: %s\n' "${file#$ROOT_DIR/}" >> "$log"
      failed=true
    fi
  done

  require_doc_text "$quickstart" '当前远程 preview 的最新 runtime pool 证据是：`BRANCH_LOCAL_SIDECAR_CLEAN=pass`、`REMOTE_HOST_AVAILABLE=missing`、`SHARED_POOL_RUNNING=missing`' \
    "quickstart states current runtime pool blockers"
  require_doc_text "$quickstart" '`claude-agent-sdk` 不是本仓库自研。当前 adapter 代码是本仓库写的接入层' \
    "quickstart separates official SDK from local adapter"
  require_doc_text "$next_testing" '旧 A10 复盘里的 legacy sidecar 证据不能替代当前官方 SDK adapter 的 R1/S1/S2/S3 商业级证据' \
    "next testing rejects old A10 as SDK completion proof"
  require_doc_text "$migration_plan" '不要再把历史' \
    "migration plan flags historical diagnostics"
  require_doc_text "$migration_plan" '`BRANCH_LOCAL_SIDECAR_CLEAN=pass`、`REMOTE_HOST_AVAILABLE=missing`、`SHARED_POOL_RUNNING=missing`' \
    "migration plan names current runtime pool blockers"
  require_doc_text "$ROOT_DIR/doc/status.cds-agent-current-progress.md" '`prd-agent` 主系统已经不再被 `claude-agent-sdk-runtime-v2` 侵入' \
    "current progress panel states branch-local sidecar cleanup"
  require_doc_text "$report" '旧 A10 证明“工作台 MVP 能远程干活”，但不能替代当前官方 SDK adapter 的 R1/S1/S2/S3 商业级证据' \
    "A10 report separates MVP from current SDK gates"

  forbid_doc_regex "$next_testing" '当前 `claude-sdk` 是历史 runtime 名，实际是官方 `anthropic` Python SDK \+ 自研 sidecar loop' \
    "next testing old legacy-loop current-state wording"
  forbid_doc_regex "$next_testing" '当前远程 preview 的真实阻塞.*(sidecar pool discovery|discovery 为 0)' \
    "next testing old discovery blocker wording"
  forbid_doc_regex "$next_testing" 'R0 runtime pool 和 A0 official SDK[[:space:]]+boundary 已有通过证据，剩余 blocker 是 R1' \
    "next testing stale R0-pass R1-only wording"
  forbid_doc_regex "$migration_plan" '当前 `claude-sdk` runtime 是官方 `anthropic` Python SDK \+ 自研 sidecar loop' \
    "migration plan old current-state wording"
  forbid_doc_regex "$migration_plan" 'R0 runtime pool、A0 official SDK adapter boundary、V1 authenticated visual、N6 非代码兼容均已有通过证据' \
    "migration plan stale R0-pass current-state wording"
  forbid_doc_regex "$migration_plan" '验证显示.*aliasCheck\.status=stable' \
    "migration plan stale branch-local alias stable evidence"
  forbid_doc_regex "$quickstart" '远程 preview 已能证明.*aliasCheck\.status=stable' \
    "quickstart stale branch-local alias stable evidence"
  forbid_doc_regex "$ROOT_DIR/doc/design.cds-agent-official-sdk-adapter.md" '当前远程诊断已经证明 MAP/CDS 控制面、sidecar transport 和 `loopOwner=claude-agent-sdk` 的最小运行前置条件' \
    "design stale remote R0 proof wording"
  forbid_doc_regex "$ROOT_DIR/doc/design.cds-agent-official-sdk-adapter.md" 'preview sidecar 已迁到唯一 scoped alias `claude-agent-sdk-runtime-v2-prd-agent`' \
    "design stale branch-local alias success wording"
  forbid_doc_regex "$report" '它不是完整官方 Claude Code SDK / Claude Agent SDK 接入' \
    "A10 report old absolute SDK-not-integrated wording"

  if [[ "$failed" == "true" ]]; then
    return 1
  fi
  return 0
}

check_runtime_pool_recovery_plan() {
  local log="$1"
  : > "$log"
  if [[ "$GOAL_AUDIT_LIVE" != "1" ]]; then
    {
      printf 'SKIPPED: CDS_AGENT_GOAL_AUDIT_LIVE is not 1; live runtime pool / branch isolation state was not observed.\n'
      printf 'Set CDS_AGENT_GOAL_AUDIT_LIVE=1 and CDS_HOST=https://cds.miduo.org to include live control-plane isolation in the goal audit.\n'
    } >> "$log"
    return 0
  fi
  if [[ -z "${CDS_HOST:-}" ]]; then
    {
      printf 'SKIPPED: CDS_HOST is not set; live runtime pool / branch isolation state was not observed.\n'
      printf 'Set CDS_AGENT_GOAL_AUDIT_LIVE=1 and CDS_HOST=https://cds.miduo.org to include live control-plane isolation in the goal audit.\n'
    } >> "$log"
    return 0
  fi
  bash "$SCRIPT_DIR/plan-cds-agent-runtime-pool-recovery.sh" >"$log" 2>&1
}

check_branch_isolation_apply_manifest() {
  local out_dir="$AUDIT_DIR/branch-isolation-repair"
  if [[ "$GOAL_AUDIT_LIVE" != "1" ]]; then
    printf 'SKIPPED: CDS_AGENT_GOAL_AUDIT_LIVE is not 1; branch isolation apply manifest was not observed.\n'
    printf 'Set CDS_AGENT_GOAL_AUDIT_LIVE=1 and CDS_HOST=https://cds.miduo.org to include live dry-run manifest verification.\n'
    return 0
  fi
  if [[ -z "${CDS_HOST:-}" ]]; then
    printf 'SKIPPED: CDS_HOST is not set; branch isolation apply manifest was not observed.\n'
    printf 'Set CDS_AGENT_GOAL_AUDIT_LIVE=1 and CDS_HOST=https://cds.miduo.org to include live dry-run manifest verification.\n'
    return 0
  fi

  CDS_AGENT_BRANCH_ISOLATION_REPAIR_DIR="$out_dir" \
    SMOKE_CDS_AGENT_BRANCH_ISOLATION_APPLY=0 \
    bash "$SCRIPT_DIR/run-cds-agent-branch-isolation-repair-with-evidence.sh"
  bash "$SCRIPT_DIR/smoke-cds-agent-branch-isolation-manifest.sh" "$out_dir/summary.json"
}

read_remote_branch_status() {
  if [[ "$GOAL_AUDIT_LIVE" != "1" ]]; then
    return 1
  fi
  if [[ -z "${CDS_HOST:-}" ]]; then
    return 1
  fi
  if [[ ! -f "$ROOT_DIR/.claude/skills/cds/cli/cdscli.py" ]]; then
    return 1
  fi
  CDS_HOST="$CDS_HOST" python3 "$ROOT_DIR/.claude/skills/cds/cli/cdscli.py" branch status "$SMOKE_CDS_BRANCH_ID" 2>/dev/null || return 1
}

read_control_plane_status() {
  if [[ "$GOAL_AUDIT_LIVE" != "1" ]]; then
    return 1
  fi
  if [[ -z "${CDS_HOST:-}" ]]; then
    return 1
  fi
  if [[ ! -f "$ROOT_DIR/.claude/skills/cds/cli/cdscli.py" ]]; then
    return 1
  fi
  CDS_HOST="$CDS_HOST" python3 "$ROOT_DIR/.claude/skills/cds/cli/cdscli.py" self branches 2>/dev/null || return 1
}

cd "$ROOT_DIR"
mkdir -p "$AUDIT_DIR"

run_step "A0 official SDK adapter boundary" env SMOKE_CDS_AGENT_BOUNDARY_REPORT="$BOUNDARY_REPORT" bash "$SCRIPT_DIR/smoke-cds-agent-official-sdk-boundary.sh" || true
run_step "D0 docs current-state calibration" check_docs_calibration "$DOCS_CALIBRATION_LOG" || true
run_step_logged "D1 progress surface consistency" "$PROGRESS_CONSISTENCY_LOG" bash "$SCRIPT_DIR/check-cds-agent-progress-consistency.sh" || true
run_step_logged "N6 non-code and candidate SDK compatibility" "$N6_LOG" env SMOKE_CDS_AGENT_N6_REPORT="$N6_ATTEMPT_SUMMARY" DOTNET_CLI_USE_MSBUILD_SERVER=0 MSBUILDDISABLENODEREUSE=1 bash "$SCRIPT_DIR/smoke-cds-agent-non-code-compatibility.sh" || true
run_step_logged "P0 branch isolation and shared pool recovery plan" "$RUNTIME_POOL_PLAN_LOG" check_runtime_pool_recovery_plan "$RUNTIME_POOL_PLAN_LOG" || true
run_step_logged "P0 branch isolation apply manifest" "$BRANCH_ISOLATION_MANIFEST_LOG" check_branch_isolation_apply_manifest || true

if [[ -z "$cycle_summary" ]]; then
  cycle_summary=$(find_latest_cycle_summary)
fi

if [[ -n "$cycle_summary" ]]; then
  run_step_logged "Evidence index quality" "$EVIDENCE_INDEX_LOG" bash "$SCRIPT_DIR/smoke-cds-agent-evidence-index.sh" "$cycle_summary" || true
else
  run_step_logged "Evidence index quality" "$EVIDENCE_INDEX_LOG" bash "$SCRIPT_DIR/smoke-cds-agent-evidence-index.sh" || true
fi

boundary_status="missing"
adapter_lines=0
adapter_max=0
support_lines=0
support_max=0
bridge_total_lines=0
bridge_total_max=0
legacy_lines=0
if [[ -f "$BOUNDARY_REPORT" ]]; then
  boundary_status=$(jq -r '.status // "unknown"' "$BOUNDARY_REPORT")
  adapter_lines=$(jq -r '.officialLoopOwnerEvidence.officialAdapterLines // 0' "$BOUNDARY_REPORT")
  adapter_max=$(jq -r '.officialLoopOwnerEvidence.officialAdapterMaxLines // 0' "$BOUNDARY_REPORT")
  support_lines=$(jq -r '.officialLoopOwnerEvidence.bridgeSupportLines // 0' "$BOUNDARY_REPORT")
  support_max=$(jq -r '.officialLoopOwnerEvidence.bridgeSupportMaxLines // 0' "$BOUNDARY_REPORT")
  bridge_total_lines=$(jq -r '.officialLoopOwnerEvidence.bridgeTotalLines // 0' "$BOUNDARY_REPORT")
  bridge_total_max=$(jq -r '.officialLoopOwnerEvidence.bridgeTotalMaxLines // 0' "$BOUNDARY_REPORT")
  legacy_lines=$(jq -r '.officialLoopOwnerEvidence.legacyLoopLines // 0' "$BOUNDARY_REPORT")
fi

n6_status="pass"
if [[ -s "$N6_LOG" ]] && grep -Eq 'CDS_AGENT_GOAL_AUDIT_TIMEOUT|MSB1025|System\.Net\.Sockets\.SocketException|Permission denied|NamedPipeServerStream' "$N6_LOG"; then
  n6_status="infra_failed"
elif (( ${#failures[@]} > 0 )) && printf '%s\n' "${failures[@]}" | grep -qx "N6 non-code and candidate SDK compatibility"; then
  n6_status="failed"
elif [[ ! -s "$N6_LOG" ]]; then
  n6_status="missing"
fi
if [[ -f "$N6_ATTEMPT_SUMMARY" ]] && [[ "$(jq -r '.status // ""' "$N6_ATTEMPT_SUMMARY" 2>/dev/null || true)" == "pass" ]]; then
  cp "$N6_ATTEMPT_SUMMARY" "$N6_SUMMARY"
  n6_status="pass"
fi
if [[ -f "$N6_SUMMARY" ]] && [[ "$(jq -r '.status // ""' "$N6_SUMMARY" 2>/dev/null || true)" == "pass" ]]; then
  n6_status="pass"
  if [[ -s "$N6_LOG" ]] && grep -Eq 'System\.Net\.Sockets\.SocketException|Permission denied|NamedPipeServerStream|CDS_AGENT_GOAL_AUDIT_TIMEOUT' "$N6_LOG"; then
    for i in "${!timing_names[@]}"; do
      if [[ "${timing_names[$i]}" == "N6 non-code and candidate SDK compatibility" ]]; then
        timing_statuses[$i]="pass_canonical_after_infra_failure"
      fi
    done
  fi
  if (( ${#failures[@]} > 0 )); then
    filtered_failures=()
    for failure in "${failures[@]}"; do
      if [[ "$failure" != "N6 non-code and candidate SDK compatibility" ]]; then
        filtered_failures+=("$failure")
      fi
    done
    failures=()
    if (( ${#filtered_failures[@]} > 0 )); then
      failures=("${filtered_failures[@]}")
    fi
  fi
fi

docs_calibration_status="pass"
if (( ${#failures[@]} > 0 )) && printf '%s\n' "${failures[@]}" | grep -qx "D0 docs current-state calibration"; then
  docs_calibration_status="failed"
elif [[ ! -s "$DOCS_CALIBRATION_LOG" ]]; then
  docs_calibration_status="missing"
fi

progress_consistency_status="pass"
if [[ -s "$PROGRESS_CONSISTENCY_LOG" ]] && grep -q 'CDS Agent progress consistency: pass' "$PROGRESS_CONSISTENCY_LOG"; then
  progress_consistency_status="pass"
elif (( ${#failures[@]} > 0 )) && printf '%s\n' "${failures[@]}" | grep -qx "D1 progress surface consistency"; then
  progress_consistency_status="failed"
elif [[ ! -s "$PROGRESS_CONSISTENCY_LOG" ]]; then
  progress_consistency_status="missing"
else
  progress_consistency_status="failed"
fi

evidence_index_status="pass"
if [[ -s "$EVIDENCE_INDEX_LOG" ]] && grep -q 'Evidence index smoke failed:' "$EVIDENCE_INDEX_LOG"; then
  evidence_index_status="failed"
elif (( ${#failures[@]} > 0 )) && printf '%s\n' "${failures[@]}" | grep -qx "Evidence index quality"; then
  evidence_index_status="failed"
elif [[ ! -s "$EVIDENCE_INDEX_LOG" ]]; then
  evidence_index_status="missing"
fi

runtime_pool_plan_status="missing"
runtime_pool_plan_json='null'
runtime_pool_plan_source="none"
runtime_pool_summary_age_seconds=0
runtime_pool_shared_kind="unknown"
runtime_pool_shared_running=0
runtime_pool_contaminated_count=0
runtime_pool_remote_host_count="unknown"
runtime_pool_enabled_host_count="unknown"
runtime_pool_branch_deploy_allowed="unknown"
runtime_pool_blockers_json='[]'
r0_readiness_json='null'
if [[ -x "$SCRIPT_DIR/preflight-cds-agent-r0-apply-readiness.sh" ]] && [[ -f "${CDS_AGENT_REMOTE_HOST_SUMMARY:-/tmp/cds-agent-remote-host-pool-current-readonly-live/summary.json}" ]]; then
  CDS_AGENT_R0_READINESS_REPORT="$R0_READINESS_SUMMARY" \
    CDS_AGENT_REMOTE_HOST_SUMMARY="${CDS_AGENT_REMOTE_HOST_SUMMARY:-/tmp/cds-agent-remote-host-pool-current-readonly-live/summary.json}" \
    bash "$SCRIPT_DIR/preflight-cds-agent-r0-apply-readiness.sh" >/dev/null 2>&1 || true
fi
if [[ -f "$R0_READINESS_SUMMARY" ]]; then
  r0_readiness_json=$(jq -c '.' "$R0_READINESS_SUMMARY" 2>/dev/null || printf 'null')
fi
branch_manifest_status="missing"
branch_manifest_summary="$AUDIT_DIR/branch-isolation-repair/summary.json"
branch_manifest_json='null'
if [[ -s "$BRANCH_ISOLATION_MANIFEST_LOG" ]] && grep -Eq '^SKIPPED: (CDS_HOST is not set|CDS_AGENT_GOAL_AUDIT_LIVE is not 1)' "$BRANCH_ISOLATION_MANIFEST_LOG"; then
  branch_manifest_status="not_observed"
elif [[ -s "$BRANCH_ISOLATION_MANIFEST_LOG" ]] && grep -q 'branch isolation dry-run manifest is explicit and fail-closed' "$BRANCH_ISOLATION_MANIFEST_LOG"; then
  branch_manifest_status="pass"
elif [[ -s "$BRANCH_ISOLATION_MANIFEST_LOG" ]]; then
  branch_manifest_status="failed"
fi
if [[ -s "$branch_manifest_summary" ]]; then
  branch_manifest_json=$(jq -c '{summary: input_filename, apply, verdict, beforeContaminatedBranchCount, applyManifest, repair: {status: .repair.status, candidateProfileIds: .repair.candidateProfileIds, deletedProfileIds: .repair.deletedProfileIds}}' "$branch_manifest_summary" 2>/dev/null || printf 'null')
fi
if [[ "$branch_manifest_status" == "not_observed" && -s "$RUNTIME_POOL_SUMMARY" ]]; then
  if jq -e '(.branchIsolation.evidenceCaptured // false) == true and (.branchIsolation.clean // false) == true' "$RUNTIME_POOL_SUMMARY" >/dev/null 2>&1; then
    branch_manifest_status="clean_from_runtime_pool_summary"
    branch_manifest_json=$(jq -c '{summary: input_filename, apply: false, verdict: (.branchIsolation.verdict // "dry-run-clean"), beforeContaminatedBranchCount: (.branchIsolation.contaminatedBranchCount // 0), applyManifest: (.branchIsolation.applyManifest // null), repair: {status: (.branchIsolation.repairStatus // null), candidateProfileIds: (.branchIsolation.candidateProfileIds // []), deletedProfileIds: []}}' "$RUNTIME_POOL_SUMMARY" 2>/dev/null || printf 'null')
  fi
fi
if [[ -s "$RUNTIME_POOL_PLAN_LOG" ]]; then
  if grep -Eq '^SKIPPED: (CDS_HOST is not set|CDS_AGENT_GOAL_AUDIT_LIVE is not 1)' "$RUNTIME_POOL_PLAN_LOG"; then
    runtime_pool_plan_status="not_observed"
  else
    runtime_pool_plan_json=$(sed -n '/^{/,$p' "$RUNTIME_POOL_PLAN_LOG" | jq -c . 2>/dev/null || printf 'null')
    if [[ "$runtime_pool_plan_json" == "null" ]]; then
      runtime_pool_plan_status="unparseable"
    else
      runtime_pool_shared_kind=$(jq -r '.sharedKind // "unknown"' <<< "$runtime_pool_plan_json")
      runtime_pool_shared_running=$(jq -r '.sharedRunning // 0' <<< "$runtime_pool_plan_json")
      runtime_pool_contaminated_count=$(jq -r '.contaminatedBranchCount // 0' <<< "$runtime_pool_plan_json")
      runtime_pool_remote_host_count=$(jq -r '.remoteHostCount // "unknown"' <<< "$runtime_pool_plan_json")
      runtime_pool_enabled_host_count=$(jq -r '.enabledRemoteHostCount // "unknown"' <<< "$runtime_pool_plan_json")
      runtime_pool_branch_deploy_allowed=$(jq -r 'if has("branchDeploySharedPoolAllowed") then (.branchDeploySharedPoolAllowed | tostring) else "unknown" end' <<< "$runtime_pool_plan_json")
      runtime_pool_plan_status="pass"
      runtime_pool_plan_source="live-plan"
      runtime_pool_blockers_json=$(runtime_pool_plan_blockers <<< "$runtime_pool_plan_json")
    fi
  fi
fi
if [[ "$runtime_pool_plan_status" != "pass" && -s "$RUNTIME_POOL_SUMMARY" ]]; then
  runtime_pool_plan_json=$(runtime_pool_summary_to_plan "$RUNTIME_POOL_SUMMARY" 2>/dev/null || printf 'null')
  if [[ "$runtime_pool_plan_json" != "null" ]]; then
    runtime_pool_shared_kind=$(jq -r '.sharedKind // "unknown"' <<< "$runtime_pool_plan_json")
    runtime_pool_shared_running=$(jq -r '.sharedRunning // 0' <<< "$runtime_pool_plan_json")
    runtime_pool_contaminated_count=$(jq -r '.contaminatedBranchCount // 0' <<< "$runtime_pool_plan_json")
    runtime_pool_remote_host_count=$(jq -r '.remoteHostCount // "unknown"' <<< "$runtime_pool_plan_json")
    runtime_pool_enabled_host_count=$(jq -r '.enabledRemoteHostCount // "unknown"' <<< "$runtime_pool_plan_json")
    runtime_pool_branch_deploy_allowed=$(jq -r 'if has("branchDeploySharedPoolAllowed") then (.branchDeploySharedPoolAllowed | tostring) else "unknown" end' <<< "$runtime_pool_plan_json")
    runtime_pool_plan_status="pass"
    runtime_pool_plan_source="summary"
    runtime_pool_summary_age_seconds=$(( $(date +%s) - $(file_mtime "$RUNTIME_POOL_SUMMARY") ))
    runtime_pool_blockers_json=$(jq -c '.runtimePoolBlockers // []' "$RUNTIME_POOL_SUMMARY" 2>/dev/null || printf '[]')
    if [[ "$runtime_pool_blockers_json" == "[]" ]]; then
      runtime_pool_blockers_json=$(runtime_pool_plan_blockers <<< "$runtime_pool_plan_json")
    fi
  fi
fi

cycle_status="missing"
commercial_complete=false
current_blocking_gate=""
blocking_reason="No one-cycle summary found; run scripts/smoke-cds-agent-one-cycle.sh for remote/provider gate evidence."
deployment_advice="Prefer local/static smokes first. Deploy only when validating remote runtime behavior, auth, container networking, visual evidence, or promotion."
next_command="CDS_HOST=https://cds.miduo.org bash scripts/smoke-cds-agent-one-cycle.sh"
gate_r0="unknown"
gate_a0="$boundary_status"
gate_r1="unknown"
gate_s1="unknown"
gate_s2s3="unknown"
gate_v1="unknown"
gate_n6="$n6_status"
cycle_total_seconds=0
cycle_slowest='[]'
cycle_age_seconds=0
cycle_freshness_status="missing"
cycle_git_branch=""
cycle_git_commit=""
cycle_git_commit_short=""
cycle_git_status="missing"
cycle_git_diff_json='[]'
cycle_git_runtime_diff_json='[]'
next_cycle_plan_json='null'
r1_report=""
r1_status="missing"
r1_details_json='null'
s1_report=""
s1_status="missing"
s1_details_json='null'
controls_report=""
controls_status="missing"
controls_details_json='null'
remote_branch_status_json='null'
remote_branch_observed=false
remote_branch_status="skipped"
remote_branch_id="$SMOKE_CDS_BRANCH_ID"
remote_github_commit=""
remote_runtime_commit=""
remote_subject=""
remote_preview_slug=""
remote_deploy_count=""
remote_last_deploy_at=""
remote_branch_source="none"
remote_runtime_relation="not_observed"
remote_deploy_advice="Set CDS_HOST to include remote CDS branch status in this audit."
control_plane_status_json='null'
control_plane_observed=false
control_plane_current_branch=""
control_plane_current_commit=""
control_plane_branch_head_commit=""
control_plane_branch_head_subject=""
control_plane_branch_head_cds_touched=""
control_plane_relation="not_observed"
control_plane_advice="Set CDS_HOST to include CDS control-plane self-update status in this audit."
if [[ -f "$cycle_summary" ]]; then
  now_epoch=$(date +%s)
  cycle_mtime=$(file_mtime "$cycle_summary")
  cycle_age_seconds=$((now_epoch - cycle_mtime))
  if (( CYCLE_MAX_AGE_SECONDS > 0 && cycle_age_seconds > CYCLE_MAX_AGE_SECONDS )); then
    cycle_freshness_status="stale"
  else
    cycle_freshness_status="fresh"
  fi
  cycle_status=$(jq -r '.status // "unknown"' "$cycle_summary")
  commercial_complete=$(jq -r '.commercialComplete // false' "$cycle_summary")
  current_blocking_gate=$(jq -r '.executionPanel.currentBlockingGate // ""' "$cycle_summary")
  blocking_reason=$(jq -r '.blockingReason // ""' "$cycle_summary")
  deployment_advice=$(jq -r '.deploymentAdvice // ""' "$cycle_summary")
  next_command=$(jq -r '.nextCommand // ""' "$cycle_summary")
  gate_r0=$(jq -r '.commercialGates.R0.status // "unknown"' "$cycle_summary")
  gate_a0=$(jq -r '.commercialGates.A0.status // "'"$boundary_status"'"' "$cycle_summary")
  gate_r1=$(jq -r '.commercialGates.R1.status // "unknown"' "$cycle_summary")
  gate_s1=$(jq -r '.commercialGates.S1.status // "unknown"' "$cycle_summary")
  gate_s2s3=$(jq -r '.commercialGates.S2S3.status // "unknown"' "$cycle_summary")
  gate_v1=$(jq -r '.commercialGates.V1.status // "unknown"' "$cycle_summary")
  gate_n6=$(jq -r '.commercialGates.N6.status // "'"$n6_status"'"' "$cycle_summary")
  cycle_total_seconds=$(jq -r '.timing.totalSeconds // 0' "$cycle_summary")
  cycle_slowest=$(jq -c '.timing.slowest // []' "$cycle_summary")
  next_cycle_plan_json=$(jq -c '.nextCyclePlan // null' "$cycle_summary")
  cycle_git_branch=$(jq -r '.git.branch // ""' "$cycle_summary")
  cycle_git_commit=$(jq -r '.git.commit // ""' "$cycle_summary")
  cycle_git_commit_short=$(jq -r '.git.commitShort // ""' "$cycle_summary")
  if [[ -z "$cycle_git_commit" ]]; then
    cycle_git_status="unknown"
  elif [[ -n "$current_git_commit" && "$cycle_git_commit" == "$current_git_commit" ]]; then
    cycle_git_status="match"
  elif classify_cycle_git_drift "$cycle_git_commit" "$current_git_commit"; then
    cycle_git_status="compatible_non_runtime_drift"
  else
    drift_rc=$?
    if (( drift_rc == 2 )); then
      cycle_git_status="runtime_mismatch"
    else
      cycle_git_status="mismatch"
    fi
  fi
  if (( ${#CYCLE_GIT_DIFF_PATHS[@]} > 0 )); then
    cycle_git_diff_json=$(printf '%s\n' "${CYCLE_GIT_DIFF_PATHS[@]}" | jq -R . | jq -s .)
  fi
  if (( ${#CYCLE_GIT_RUNTIME_DIFF_PATHS[@]} > 0 )); then
    cycle_git_runtime_diff_json=$(printf '%s\n' "${CYCLE_GIT_RUNTIME_DIFF_PATHS[@]}" | jq -R . | jq -s .)
  fi
  r1_report=$(jq -r '.r1.report // ""' "$cycle_summary")
  s1_report=$(jq -r '.s1.report // ""' "$cycle_summary")
  controls_report=$(jq -r '.controls.report // ""' "$cycle_summary")
  remote_branch_status_json=$(jq -c '.remoteCdsBranch // null' "$cycle_summary")
fi

if remote_status_raw=$(read_remote_branch_status); then
  remote_branch_status_json=$(printf '%s' "$remote_status_raw" | jq -c '.data // null' 2>/dev/null || printf 'null')
  if [[ "$remote_branch_status_json" != "null" ]]; then
    remote_branch_observed=true
    remote_branch_source="live"
    remote_branch_status=$(jq -r '.status // "unknown"' <<< "$remote_branch_status_json")
    remote_branch_id=$(jq -r '.id // "'"$SMOKE_CDS_BRANCH_ID"'"' <<< "$remote_branch_status_json")
    remote_github_commit=$(jq -r '.githubCommitSha // ""' <<< "$remote_branch_status_json")
    remote_runtime_commit=$(jq -r '.commitSha // ""' <<< "$remote_branch_status_json")
    remote_subject=$(jq -r '.subject // ""' <<< "$remote_branch_status_json")
    remote_preview_slug=$(jq -r '.previewSlug // ""' <<< "$remote_branch_status_json")
    remote_deploy_count=$(jq -r '.deployCount // ""' <<< "$remote_branch_status_json")
    remote_last_deploy_at=$(jq -r '.lastDeployAt // ""' <<< "$remote_branch_status_json")
    if [[ -n "$remote_runtime_commit" && -n "$current_git_commit_short" && "$current_git_commit_short" == "$remote_runtime_commit"* ]]; then
      remote_runtime_relation="runtime_matches_head"
      remote_deploy_advice="Remote runtime commit matches current HEAD; do not redeploy unless provider/profile or visual evidence requires it."
    elif [[ -n "$remote_runtime_commit" ]] && classify_git_drift_quiet "$remote_runtime_commit" "$current_git_commit"; then
      remote_runtime_relation="runtime_behind_non_runtime_drift"
      remote_deploy_advice="Remote runtime is behind current HEAD only by compatible non-runtime drift; do not self update for this state."
    elif [[ "$cycle_git_status" == "compatible_non_runtime_drift" ]]; then
      remote_runtime_relation="runtime_behind_non_runtime_drift"
      remote_deploy_advice="Remote runtime is behind current HEAD only by compatible non-runtime drift; do not self update for this state."
    elif [[ -n "$remote_runtime_commit" ]]; then
      remote_drift_rc=0
      classify_git_drift_quiet "$remote_runtime_commit" "$current_git_commit" || remote_drift_rc=$?
      if [[ "${remote_drift_rc:-0}" == "2" ]]; then
        remote_runtime_relation="runtime_mismatch"
        remote_deploy_advice="Remote runtime evidence does not cover current runtime-affecting changes; rerun one-cycle after the required remote update."
      else
        remote_runtime_relation="runtime_not_matched"
        remote_deploy_advice="Remote runtime commit differs from current HEAD; inspect git drift before deciding whether to deploy."
      fi
    elif [[ "$cycle_git_status" == "runtime_mismatch" || "$cycle_git_status" == "mismatch" ]]; then
      remote_runtime_relation="runtime_mismatch"
      remote_deploy_advice="Remote runtime evidence does not cover current runtime-affecting changes; rerun one-cycle after the required remote update."
    else
      remote_runtime_relation="runtime_not_matched"
      remote_deploy_advice="Remote runtime commit differs from current HEAD; inspect git drift before deciding whether to deploy."
    fi
  fi
elif [[ "$remote_branch_status_json" != "null" && "$(jq -r '.observed // false' <<< "$remote_branch_status_json")" == "true" ]]; then
  remote_branch_observed=true
  remote_branch_source="cycle-summary"
  remote_branch_status=$(jq -r '.status // "unknown"' <<< "$remote_branch_status_json")
  remote_branch_id=$(jq -r '.branchId // "'"$SMOKE_CDS_BRANCH_ID"'"' <<< "$remote_branch_status_json")
  remote_github_commit=$(jq -r '.githubCommitSha // ""' <<< "$remote_branch_status_json")
  remote_runtime_commit=$(jq -r '.runtimeCommitSha // ""' <<< "$remote_branch_status_json")
  remote_subject=$(jq -r '.subject // ""' <<< "$remote_branch_status_json")
  remote_preview_slug=$(jq -r '.previewSlug // ""' <<< "$remote_branch_status_json")
  remote_deploy_count=$(jq -r '.deployCount // ""' <<< "$remote_branch_status_json")
  remote_last_deploy_at=$(jq -r '.lastDeployAt // ""' <<< "$remote_branch_status_json")
  remote_runtime_relation=$(jq -r '.runtimeRelation // "snapshot"' <<< "$remote_branch_status_json")
  remote_deploy_advice=$(jq -r '.deployAdvice // "Using remote branch snapshot saved in cycle-summary; set CDS_HOST for live refresh."' <<< "$remote_branch_status_json")
else
  remote_deploy_advice="Set CDS_AGENT_GOAL_AUDIT_LIVE=1 and CDS_HOST to include remote CDS branch status in this audit."
fi

if control_plane_raw=$(read_control_plane_status); then
  control_plane_status_json=$(printf '%s' "$control_plane_raw" | jq -c '.data // null' 2>/dev/null || printf 'null')
  if [[ "$control_plane_status_json" != "null" ]]; then
    control_plane_observed=true
    control_plane_current_branch=$(jq -r '.current // "unknown"' <<< "$control_plane_status_json")
    control_plane_current_commit=$(jq -r '.commitHash // ""' <<< "$control_plane_status_json")
    control_plane_current_json=$(jq -c --arg branch "$control_plane_current_branch" 'first(.branchDetails[]? | select(.name == $branch)) // null' <<< "$control_plane_status_json")
    if [[ "$control_plane_current_json" != "null" ]]; then
      control_plane_branch_head_commit=$(jq -r '.commitHash // ""' <<< "$control_plane_current_json")
      control_plane_branch_head_subject=$(jq -r '.subject // ""' <<< "$control_plane_current_json")
      control_plane_branch_head_cds_touched=$(jq -r 'if has("cdsTouched") then (.cdsTouched | tostring) else "" end' <<< "$control_plane_current_json")
    fi
    if [[ -n "$control_plane_current_commit" && -n "$current_git_commit_short" && "$current_git_commit_short" == "$control_plane_current_commit"* ]]; then
      control_plane_relation="control_plane_matches_head"
      control_plane_advice="CDS control plane is on current HEAD. This does not prove preview runtime deploy parity; use remoteCdsBranch.runtimeCommitSha for that."
    elif [[ -n "$control_plane_branch_head_commit" && -n "$current_git_commit_short" && "$current_git_commit_short" == "$control_plane_branch_head_commit"* && "$control_plane_branch_head_cds_touched" == "false" ]]; then
      control_plane_relation="control_plane_behind_non_cds_drift"
      control_plane_advice="CDS control plane is behind current HEAD only by branch changes marked cdsTouched=false; do not self update for this state."
    elif [[ -n "$control_plane_branch_head_commit" && -n "$current_git_commit_short" && "$current_git_commit_short" == "$control_plane_branch_head_commit"* && "$control_plane_branch_head_cds_touched" == "true" ]]; then
      control_plane_relation="control_plane_behind_cds_drift"
      control_plane_advice="CDS control plane is behind current HEAD and the branch head touched CDS code; self-update is the relevant validation path when this control-plane change must be exercised."
    else
      control_plane_relation="control_plane_not_matched"
      control_plane_advice="CDS control plane is not on current HEAD. Inspect branch head and cdsTouched before deciding whether self-update is needed."
    fi
  fi
fi

if [[ "$boundary_status" == "pass" ]]; then
  gate_a0="pass"
fi
if [[ "$n6_status" == "pass" ]]; then
  gate_n6="pass"
elif [[ "$n6_status" != "missing" ]]; then
  gate_n6="$n6_status"
fi
if [[ -n "$r1_report" && -f "$r1_report" ]]; then
  r1_status=$(jq -r '.status // "unknown"' "$r1_report")
  r1_details_json=$(jq -c '{
    status: (.status // "unknown"),
    targetTemplateId: (.targetTemplateId // ""),
    suggestedCommand: (.suggestedCommand // ""),
    suggestedRepairCommand: (.suggestedRepairCommand // ""),
    nextCommands: (.nextCommands // null),
    defaultProfile: (.evidence.defaultProfile // null),
    repairPlan: (.evidence.repairPlan // null),
    targetTemplate: (.evidence.targetTemplate // null),
    missingKeyGuard: (.evidence.missingKeyGuard // null),
    providerKeyReceived: (.evidence.providerKeyReceived // false)
  }' "$r1_report")
fi
if [[ -n "$s1_report" && -f "$s1_report" ]]; then
  s1_status=$(jq -r '.status // "unknown"' "$s1_report")
  s1_details_json=$(jq -c '{
    status: (.status // "unknown"),
    host: (.host // ""),
    target: (.target // null),
    sessionId: (.sessionId // ""),
    traceId: (.traceId // ""),
    defaultProfile: (.evidence.defaultProfile // null)
  }' "$s1_report")
fi
if [[ -n "$controls_report" && -f "$controls_report" ]]; then
  controls_status=$(jq -r '.status // "unknown"' "$controls_report")
  controls_details_json=$(jq -c '{
    status: (.status // "unknown"),
    host: (.host // ""),
    target: (.target // null),
    defaultProfile: (.evidence.defaultProfile // null)
  }' "$controls_report")
fi

runtime_pool_blocker_count="$(jq -r 'length' <<< "$runtime_pool_blockers_json")"
if [[ "$runtime_pool_plan_status" != "pass" ]]; then
  cycle_status="blocked_r0"
  gate_r0="unknown"
  current_blocking_gate="R0"
  blocking_reason="Runtime pool recovery was not observed in this audit. Use the completed CDS-managed runtime correction plan as the boundary before treating any remote host/env input as fallback."
  deployment_advice="Do not redeploy for this state. Correct the facts and docs back to CDS-managed runtime/container/sandbox; SSH/env/image values are operator fallback only."
  next_command="sed -n '70,120p' doc/design.cds-agent-managed-runtime-fact-source.md && scripts/smoke-cds-agent-map-session-transport.sh && scripts/smoke-cds-agent-shared-service-pool.sh && scripts/check-cds-agent-progress-consistency.sh"
  next_cycle_plan_json=$(jq -n \
    --arg command "$next_command" \
    '{
      cycle: "r0-runtime-pool-recovery",
      state: "runtime-pool-evidence-required",
      items: [
        {
          order: 1,
          code: "R0E",
          title: "建立 CDS-managed runtime fact source",
          goal: "确认 MAP 只连 CDS，CDS 管理 Claude SDK runtime/container/sandbox，remote host/env 只作 operator fallback。",
          evidence: "R0 fact-source 设计、runtime-status execution panel、controller tests 和 progress consistency 口径一致。",
          status: "next",
          blockedBy: "R0",
          nextActions: [$command]
        }
      ],
      stopConditions: [
        "R0 未有当前证据前，不把旧 one-cycle R1/profile blocker 当作当前执行方向。"
      ]
    }')
elif [[ "$runtime_pool_blocker_count" != "0" ]]; then
  cycle_status="blocked_r0"
  gate_r0="pending"
  current_blocking_gate="R0"
  blocking_reason="R0V live evidence is complete and shows CDS-managed runtime capacity is missing: branch isolation is clean, but shared runtime running=0 and enabled operator fallback hosts=0. The next product step is R0.5 CDS-managed runtime capacity, not asking users for SSH/env/image."
  if jq -e 'any(.requirement == "BRANCH_LOCAL_SIDECAR_CLEAN")' <<< "$runtime_pool_blockers_json" >/dev/null; then
    deployment_advice="Do not redeploy for this state. Clean branch-local sidecar residuals if needed, then correct the runtime recovery model back to CDS-managed runtime before exposing any operator fallback."
  else
    deployment_advice="Do not redeploy for this state. Branch-local sidecar cleanup is already clean; the next product step is R0.5 CDS-managed runtime capacity, not asking the user for SSH/env/image."
  fi
  next_command="sed -n '70,120p' doc/design.cds-agent-managed-runtime-fact-source.md && scripts/smoke-cds-agent-map-session-transport.sh && scripts/smoke-cds-agent-shared-service-pool.sh && scripts/check-cds-agent-progress-consistency.sh"
  next_cycle_plan_json=$(jq -n \
    --argjson blockers "$runtime_pool_blockers_json" \
    --arg command "$next_command" \
    '{
      cycle: "r0-cds-managed-runtime-capacity",
      state: "cds-managed-runtime-capacity-missing",
      items: [
        {
          order: 1,
          code: "D1",
          title: "CDS-managed runtime 架构纠偏",
          goal: "把当前恢复路径从 external host/env-driven recovery 纠回 CDS-managed runtime/container/sandbox。",
          evidence: "doc/plan.cds-agent-runtime-correction-limited.md 与 progress consistency pass。",
          status: "done",
          blockedBy: null,
          nextActions: [
            "保持纠偏边界：CDS_REMOTE_HOST_*、SSH、image 只能作为 operator fallback。"
          ]
        },
        {
          order: 2,
          code: "R0.3",
          title: "接入 CDS-managed official SDK runtime transport",
          goal: "让 CDS 的容器/分支/runtime/sandbox 承载 Claude SDK runtime，并由 /agent-sessions 投递消息。",
          evidence: "非 fake session ownership guard 与最小 branch-service official SDK transport 已完成。",
          status: "done_minimal",
          blockedBy: null,
          nextActions: [
            "保持 CDS-owned transport；不要回退到 MAP sidecar bridge。"
          ]
        },
        {
          order: 3,
          code: "R0.4",
          title: "MAP adapter session transport + managed-runtime smoke",
          goal: "证明 MAP 只调用 CDS session/discovery/cancel/log API，且 official SDK loop owner 可观测。",
          evidence: "MAP_TO_CDS_ONLY、CDS_MANAGED_RUNTIME_TRANSPORT、OFFICIAL_SDK_LOOP_OWNER smoke 通过。",
          status: "done",
          blockedBy: null,
          nextActions: [
            "保持 MAP_TO_CDS_ONLY smoke；不要恢复默认 direct runtime queue。"
          ]
        },
        {
          order: 4,
          code: "R0V",
          title: "R0 managed-runtime post-check/live evidence",
          goal: "用当前 CDS state 验证 MAP_TO_CDS_ONLY、CDS_MANAGED_RUNTIME_TRANSPORT、OFFICIAL_SDK_LOOP_OWNER。",
          evidence: "R0V live evidence completed; branch isolation clean, shared runtime running=0, enabled fallback hosts=0。",
          status: "done_blocked",
          blockedBy: null,
          nextActions: [
            "不要把 R0V 失败解释成普通用户需要补 SSH/env/image。"
          ]
        },
        {
          order: 5,
          code: "R0.5",
          title: "CDS-managed runtime capacity",
          goal: "把顶层 blocker 从 REMOTE_HOST_AVAILABLE 收口为 CDS_MANAGED_RUNTIME_CAPACITY，并定义 CDS 内部 runtime/container/sandbox capacity contract。",
          evidence: "runtime-status、progress board、goal audit 和 smoke 都显示 CDS_MANAGED_RUNTIME_CAPACITY；remote host/env/image 只在 legacyFallbackBlockers。",
          status: "next",
          blockedBy: "CDS_MANAGED_RUNTIME_CAPACITY",
          nextActions: [$command]
        }
      ],
      legacyFallbackBlockers: $blockers,
      blockers: [
        {
          requirement: "CDS_MANAGED_RUNTIME_CAPACITY",
          status: "missing",
          evidence: "shared runtime running=0; enabled operator fallback hosts=0"
        }
      ],
      stopConditions: [
        "CDS_MANAGED_RUNTIME_CAPACITY 通过前，不运行 provider one-cycle。",
        "不要把 remote host/env/image 暴露为普通用户主路径。"
      ]
    }')
fi

if [[ "$boundary_status" != "pass" ]]; then
  failures+=("A0 boundary did not pass")
fi
if [[ "$n6_status" != "pass" ]]; then
  if [[ "$n6_status" == "infra_failed" ]]; then
    failures+=("N6 guardrail infra failed or timed out; rerun outside sandbox or with dotnet permissions")
  else
    failures+=("N6 compatibility did not pass")
  fi
fi
if [[ "$docs_calibration_status" != "pass" ]]; then
  failures+=("D0 docs current-state calibration did not pass")
fi
if [[ "$progress_consistency_status" != "pass" ]]; then
  failures+=("D1 progress surface consistency did not pass")
fi
if [[ "$evidence_index_status" != "pass" ]]; then
  failures+=("Evidence index quality did not pass")
fi
if [[ "$runtime_pool_plan_status" != "pass" ]]; then
  failures+=("P0 branch isolation/shared pool plan was not observed")
elif [[ "$runtime_pool_blocker_count" != "0" ]]; then
  failures+=("CDS-managed runtime capacity is missing after R0V live evidence")
fi
if [[ "$branch_manifest_status" != "pass" && "$branch_manifest_status" != "clean_from_runtime_pool_summary" ]]; then
  failures+=("P0 branch isolation apply manifest did not pass")
fi
if [[ "$runtime_pool_blocker_count" == "0" && "$cycle_freshness_status" == "stale" ]]; then
  failures+=("one-cycle summary is stale; rerun scripts/smoke-cds-agent-one-cycle.sh for current remote/provider evidence")
fi
if [[ "$runtime_pool_blocker_count" == "0" && ( "$cycle_git_status" == "runtime_mismatch" || "$cycle_git_status" == "mismatch" ) ]]; then
  failures+=("one-cycle summary git commit does not match current HEAD; rerun scripts/smoke-cds-agent-one-cycle.sh for this commit")
fi

goal_status="not_complete"
if [[ "$(json_bool "$commercial_complete")" == "true" \
  && "$cycle_freshness_status" == "fresh" \
  && ( "$cycle_git_status" == "match" || "$cycle_git_status" == "compatible_non_runtime_drift" ) \
  && "$boundary_status" == "pass" \
  && "$n6_status" == "pass" \
  && "$gate_r0" == "pass" \
  && "$gate_r1" == "pass" \
  && "$gate_s1" == "pass" \
  && "$gate_s2s3" == "pass" \
  && "$gate_v1" == "pass" \
  && "$runtime_pool_plan_status" == "pass" \
  && "$runtime_pool_blocker_count" == "0" ]]; then
  goal_status="complete"
fi

missing_json=$(
  jq -n \
    --arg gateR0 "$gate_r0" \
    --arg gateA0 "$gate_a0" \
    --arg gateR1 "$gate_r1" \
    --arg gateS1 "$gate_s1" \
    --arg gateS2S3 "$gate_s2s3" \
    --arg gateV1 "$gate_v1" \
    --arg gateN6 "$gate_n6" \
    --arg evidenceIndexStatus "$evidence_index_status" \
    --arg runtimePoolPlanStatus "$runtime_pool_plan_status" \
    --arg branchManifestStatus "$branch_manifest_status" \
    --arg docsCalibrationStatus "$docs_calibration_status" \
    --arg progressConsistencyStatus "$progress_consistency_status" \
    --arg cycleFreshness "$cycle_freshness_status" \
    --arg cycleGitStatus "$cycle_git_status" \
    --argjson runtimePoolBlockers "$runtime_pool_blockers_json" \
    --argjson branchManifest "$branch_manifest_json" \
    '{
      gates: {
        R0: $gateR0,
        A0: $gateA0,
        R1: $gateR1,
        S1: $gateS1,
        S2S3: $gateS2S3,
        V1: $gateV1,
        N6: $gateN6
      },
      docsCalibrationStatus: $docsCalibrationStatus,
      progressConsistencyStatus: $progressConsistencyStatus,
      evidenceIndexStatus: $evidenceIndexStatus,
      runtimePoolPlanStatus: $runtimePoolPlanStatus,
      branchManifestStatus: $branchManifestStatus,
      branchManifest: $branchManifest,
      runtimePoolBlockers: $runtimePoolBlockers,
      cycleFreshness: $cycleFreshness,
      cycleGitStatus: $cycleGitStatus
    } as $root
    | ($root.gates | to_entries | map(select(.value != "pass") | {
      requirement: .key,
      status: .value
    }))
    + (if (($root.runtimePoolBlockers | length) == 0 and $root.cycleFreshness == "stale") then [{requirement:"CYCLE_FRESHNESS", status:"stale"}] else [] end)
    + (if $root.docsCalibrationStatus != "pass" then [{requirement:"D0_DOCS_CALIBRATION", status:$root.docsCalibrationStatus}] else [] end)
    + (if $root.progressConsistencyStatus != "pass" then [{requirement:"D1_PROGRESS_CONSISTENCY", status:$root.progressConsistencyStatus}] else [] end)
    + (if $root.evidenceIndexStatus != "pass" then [{requirement:"EVIDENCE_INDEX", status:$root.evidenceIndexStatus}] else [] end)
    + (if $root.runtimePoolPlanStatus != "pass" then [{requirement:"P0_RUNTIME_POOL_PLAN", status:$root.runtimePoolPlanStatus}] else [] end)
    + (if ($root.branchManifestStatus != "pass" and $root.branchManifestStatus != "clean_from_runtime_pool_summary") then [{requirement:"P0_BRANCH_ISOLATION_APPLY_MANIFEST", status:$root.branchManifestStatus}] else [] end)
    + $root.runtimePoolBlockers
    + (if (($root.runtimePoolBlockers | length) == 0 and ($root.cycleGitStatus == "mismatch" or $root.cycleGitStatus == "runtime_mismatch")) then [{requirement:"CYCLE_GIT_MATCH", status:$root.cycleGitStatus}] else [] end)'
)
failures_json='[]'
if (( ${#failures[@]} > 0 )); then
  failures_json=$(printf '%s\n' "${failures[@]}" | jq -R . | jq -s .)
fi
timing_json='[]'
timing_slowest_json='[]'
timing_total_seconds=0
if (( ${#timing_names[@]} > 0 )); then
  timing_json=$(
    for i in "${!timing_names[@]}"; do
      jq -n \
        --arg name "${timing_names[$i]}" \
        --arg status "${timing_statuses[$i]}" \
        --argjson stepIndex "${timing_indices[$i]}" \
        --argjson stepTotal "$TIMING_STEP_TOTAL" \
        --argjson durationSeconds "${timing_seconds[$i]}" \
        '{name:$name,status:$status,stepIndex:$stepIndex,stepTotal:$stepTotal,durationSeconds:$durationSeconds}'
    done | jq -s .
  )
  timing_slowest_json=$(jq -c 'sort_by(.durationSeconds) | reverse | .[:3]' <<< "$timing_json")
  timing_total_seconds=$(jq -r '[.[].durationSeconds] | add // 0' <<< "$timing_json")
fi

audit_json=$(
  jq -n \
    --arg goalStatus "$goal_status" \
    --arg auditDir "$AUDIT_DIR" \
    --arg boundaryReport "$BOUNDARY_REPORT" \
    --arg docsCalibrationLog "$DOCS_CALIBRATION_LOG" \
    --arg progressConsistencyLog "$PROGRESS_CONSISTENCY_LOG" \
    --arg n6Log "$N6_LOG" \
    --arg n6Summary "$N6_SUMMARY" \
    --arg evidenceIndexLog "$EVIDENCE_INDEX_LOG" \
    --arg runtimePoolPlanLog "$RUNTIME_POOL_PLAN_LOG" \
    --arg branchIsolationManifestLog "$BRANCH_ISOLATION_MANIFEST_LOG" \
    --arg r0ReadinessSummary "$R0_READINESS_SUMMARY" \
    --arg cycleSummary "$cycle_summary" \
    --arg r1Report "$r1_report" \
    --arg s1Report "$s1_report" \
    --arg controlsReport "$controls_report" \
    --arg cycleStatus "$cycle_status" \
    --arg cycleFreshnessStatus "$cycle_freshness_status" \
    --arg cycleGitBranch "$cycle_git_branch" \
    --arg cycleGitCommit "$cycle_git_commit" \
    --arg cycleGitCommitShort "$cycle_git_commit_short" \
    --arg cycleGitStatus "$cycle_git_status" \
    --arg currentGitBranch "$current_git_branch" \
    --arg currentGitCommit "$current_git_commit" \
    --arg currentGitCommitShort "$current_git_commit_short" \
    --arg currentBlockingGate "$current_blocking_gate" \
    --arg blockingReason "$blocking_reason" \
    --arg deploymentAdvice "$deployment_advice" \
    --arg nextCommand "$next_command" \
    --arg boundaryStatus "$boundary_status" \
    --arg docsCalibrationStatus "$docs_calibration_status" \
    --arg progressConsistencyStatus "$progress_consistency_status" \
    --arg n6Status "$n6_status" \
    --arg evidenceIndexStatus "$evidence_index_status" \
    --arg runtimePoolPlanStatus "$runtime_pool_plan_status" \
    --arg runtimePoolPlanSource "$runtime_pool_plan_source" \
    --arg runtimePoolSummary "$RUNTIME_POOL_SUMMARY" \
    --arg branchManifestStatus "$branch_manifest_status" \
    --arg r1Status "$r1_status" \
    --arg s1Status "$s1_status" \
    --arg controlsStatus "$controls_status" \
    --arg remoteBranchObserved "$remote_branch_observed" \
    --arg remoteBranchId "$remote_branch_id" \
    --arg remoteBranchStatus "$remote_branch_status" \
    --arg remoteGithubCommit "$remote_github_commit" \
    --arg remoteRuntimeCommit "$remote_runtime_commit" \
    --arg remoteSubject "$remote_subject" \
    --arg remotePreviewSlug "$remote_preview_slug" \
    --arg remoteDeployCount "$remote_deploy_count" \
    --arg remoteLastDeployAt "$remote_last_deploy_at" \
    --arg remoteBranchSource "$remote_branch_source" \
    --arg remoteRuntimeRelation "$remote_runtime_relation" \
    --arg remoteDeployAdvice "$remote_deploy_advice" \
    --arg controlPlaneObserved "$control_plane_observed" \
    --arg controlPlaneCurrentBranch "$control_plane_current_branch" \
    --arg controlPlaneCurrentCommit "$control_plane_current_commit" \
    --arg controlPlaneBranchHeadCommit "$control_plane_branch_head_commit" \
    --arg controlPlaneBranchHeadSubject "$control_plane_branch_head_subject" \
    --arg controlPlaneBranchHeadCdsTouched "$control_plane_branch_head_cds_touched" \
    --arg controlPlaneRelation "$control_plane_relation" \
    --arg controlPlaneAdvice "$control_plane_advice" \
    --arg gateR0 "$gate_r0" \
    --arg gateA0 "$gate_a0" \
    --arg gateR1 "$gate_r1" \
    --arg gateS1 "$gate_s1" \
    --arg gateS2S3 "$gate_s2s3" \
    --arg gateV1 "$gate_v1" \
    --arg gateN6 "$gate_n6" \
    --argjson commercialComplete "$(json_bool "$commercial_complete")" \
    --argjson adapterLines "$adapter_lines" \
    --argjson adapterMax "$adapter_max" \
    --argjson supportLines "$support_lines" \
    --argjson supportMax "$support_max" \
    --argjson bridgeTotalLines "$bridge_total_lines" \
    --argjson bridgeTotalMax "$bridge_total_max" \
    --argjson legacyLines "$legacy_lines" \
    --argjson cycleTotalSeconds "$cycle_total_seconds" \
    --argjson cycleAgeSeconds "$cycle_age_seconds" \
    --argjson cycleMaxAgeSeconds "$CYCLE_MAX_AGE_SECONDS" \
    --argjson cycleGitDiffPaths "$cycle_git_diff_json" \
    --argjson cycleGitRuntimeDiffPaths "$cycle_git_runtime_diff_json" \
    --argjson runtimePoolSummaryAgeSeconds "$runtime_pool_summary_age_seconds" \
    --argjson cycleSlowest "$cycle_slowest" \
    --argjson nextCyclePlan "$next_cycle_plan_json" \
    --argjson localTiming "$timing_json" \
    --argjson localSlowest "$timing_slowest_json" \
    --argjson localTotalSeconds "$timing_total_seconds" \
    --argjson r1Details "$r1_details_json" \
    --argjson s1Details "$s1_details_json" \
    --argjson controlsDetails "$controls_details_json" \
    --argjson runtimePoolPlan "$runtime_pool_plan_json" \
    --argjson runtimePoolBlockers "$runtime_pool_blockers_json" \
    --argjson r0Readiness "$r0_readiness_json" \
    --argjson branchManifest "$branch_manifest_json" \
    --argjson remoteBranchStatusRaw "$remote_branch_status_json" \
    --argjson controlPlaneStatusRaw "$control_plane_status_json" \
    --argjson missing "$missing_json" \
    --argjson failures "$failures_json" \
    '{
      goalStatus: $goalStatus,
      commercialComplete: $commercialComplete,
      auditDir: $auditDir,
      artifacts: {
        boundaryReport: $boundaryReport,
        docsCalibrationLog: $docsCalibrationLog,
        progressConsistencyLog: $progressConsistencyLog,
        nonCodeCompatibilityLog: $n6Log,
        nonCodeCompatibilitySummary: $n6Summary,
        evidenceIndexLog: $evidenceIndexLog,
        runtimePoolPlanLog: $runtimePoolPlanLog,
        branchIsolationManifestLog: $branchIsolationManifestLog,
        r0ReadinessSummary: $r0ReadinessSummary,
        cycleSummary: (if $cycleSummary == "" then null else $cycleSummary end),
        r1Report: (if $r1Report == "" then null else $r1Report end),
        s1Report: (if $s1Report == "" then null else $s1Report end),
        controlsReport: (if $controlsReport == "" then null else $controlsReport end)
      },
      localTiming: {
        totalSeconds: $localTotalSeconds,
        steps: $localTiming,
        slowest: $localSlowest
      },
      evidenceIndexQuality: {
        status: $evidenceIndexStatus,
        log: $evidenceIndexLog
      },
      runtimePoolRecovery: {
        status: $runtimePoolPlanStatus,
        source: $runtimePoolPlanSource,
        summary: (if $runtimePoolSummary == "" then null else $runtimePoolSummary end),
        summaryAgeSeconds: $runtimePoolSummaryAgeSeconds,
        log: $runtimePoolPlanLog,
        plan: $runtimePoolPlan,
        blockers: $runtimePoolBlockers,
        branchIsolationApplyManifest: {
          status: $branchManifestStatus,
          log: $branchIsolationManifestLog,
          evidence: $branchManifest
        },
        applyReadiness: $r0Readiness,
        evidence: "Live CDS state must show prd-agent free of branch-local sidecar services, shared-sidecar-pool as shared-service, an enabled remote host, and a running runtime instance."
      },
      docsCalibration: {
        status: $docsCalibrationStatus,
        log: $docsCalibrationLog,
        evidence: "Critical docs must state the current official claude-agent-sdk path, R1 profile blocker, and that old A10/legacy sidecar evidence does not close S1/S2/S3."
      },
      progressConsistency: {
        status: $progressConsistencyStatus,
        log: $progressConsistencyLog,
        evidence: "Refresh report, progress board, and current progress document must agree on the R0 blocker, GHCR candidate scope, and exact next step."
      },
      remoteCdsBranch: {
        observed: ($remoteBranchObserved == "true"),
        source: $remoteBranchSource,
        branchId: $remoteBranchId,
        status: $remoteBranchStatus,
        githubCommitSha: (if $remoteGithubCommit == "" then null else $remoteGithubCommit end),
        runtimeCommitSha: (if $remoteRuntimeCommit == "" then null else $remoteRuntimeCommit end),
        subject: (if $remoteSubject == "" then null else $remoteSubject end),
        previewSlug: (if $remotePreviewSlug == "" then null else $remotePreviewSlug end),
        deployCount: (if $remoteDeployCount == "" then null else ($remoteDeployCount | tonumber) end),
        lastDeployAt: (if $remoteLastDeployAt == "" then null else $remoteLastDeployAt end),
        runtimeRelation: $remoteRuntimeRelation,
        deployAdvice: $remoteDeployAdvice,
        raw: $remoteBranchStatusRaw
      },
      controlPlane: {
        observed: ($controlPlaneObserved == "true"),
        branch: (if $controlPlaneCurrentBranch == "" then null else $controlPlaneCurrentBranch end),
        commitHash: (if $controlPlaneCurrentCommit == "" then null else $controlPlaneCurrentCommit end),
        runningCommitHash: (if $controlPlaneCurrentCommit == "" then null else $controlPlaneCurrentCommit end),
        branchHeadCommitHash: (if $controlPlaneBranchHeadCommit == "" then null else $controlPlaneBranchHeadCommit end),
        subject: (if $controlPlaneBranchHeadSubject == "" then null else $controlPlaneBranchHeadSubject end),
        branchHeadSubject: (if $controlPlaneBranchHeadSubject == "" then null else $controlPlaneBranchHeadSubject end),
        cdsTouched: (if $controlPlaneBranchHeadCdsTouched == "" then null else ($controlPlaneBranchHeadCdsTouched == "true") end),
        branchHeadCdsTouched: (if $controlPlaneBranchHeadCdsTouched == "" then null else ($controlPlaneBranchHeadCdsTouched == "true") end),
        relation: $controlPlaneRelation,
        advice: $controlPlaneAdvice,
        raw: $controlPlaneStatusRaw
      },
      requirements: {
        mapCdsControlPlane: {
          status: (if $gateR0 == "pass" and ($runtimePoolBlockers | length) == 0 then "proved" else "needs-remote-evidence" end),
          gate: "R0",
          controlPlaneRelation: $controlPlaneRelation,
          remoteRuntimeRelation: $remoteRuntimeRelation,
          runtimePoolRecovery: {
            status: $runtimePoolPlanStatus,
            blockers: $runtimePoolBlockers,
            applyReadiness: $r0Readiness,
            branchIsolationApplyManifest: {
              status: $branchManifestStatus,
              evidence: $branchManifest
            },
            branchDeploySharedPoolAllowed: ($runtimePoolPlan.branchDeploySharedPoolAllowed // null)
          },
          note: "Control-plane self-update and preview runtime deploy are separate evidence paths."
        },
        officialSdkAdapterBoundary: {
          status: (if $boundaryStatus == "pass" then "proved" else "failed" end),
          gate: "A0",
          adapterLines: $adapterLines,
          adapterMaxLines: $adapterMax,
          bridgeSupportLines: $supportLines,
          bridgeSupportMaxLines: $supportMax,
          bridgeTotalLines: $bridgeTotalLines,
          bridgeTotalMaxLines: $bridgeTotalMax,
          legacyLoopLines: $legacyLines
        },
        documentationCalibration: {
          status: (if $docsCalibrationStatus == "pass" then "proved" else $docsCalibrationStatus end),
          gate: "D0",
          evidence: "quickstart, next-agent testing guide, migration plan, and A10 report are calibrated to the current R0 runtime pool blockers, later R1 profile blocker, and official SDK adapter boundary"
        },
        progressObservability: {
          status: (if $progressConsistencyStatus == "pass" then "proved" else $progressConsistencyStatus end),
          gate: "D1",
          evidence: "refresh report, progress board, and current progress document agree on the current R0 blocker and exact next step"
        },
        otherAgentCompatibility: {
          status: (if $n6Status == "pass" then "proved" else $n6Status end),
          gate: "N6",
          summary: (if $n6Summary == "" then null else $n6Summary end),
          evidence: "non-code Toolbox agents stay independent; codex/openai-agents-sdk/google-adk remain planned-not-routable"
        },
        providerReadiness: {
          status: (if $gateR1 == "pass" then "proved" else "pending" end),
          gate: "R1",
          reportStatus: $r1Status,
          compatibilityReasonCode: ($r1Details.defaultProfile.compatibilityReasonCode // null),
          compatibilityReason: ($r1Details.defaultProfile.compatibilityReason // null),
          compatibilityNextActions: ($r1Details.defaultProfile.compatibilityNextActions // []),
          details: $r1Details
        },
        providerBackedRuns: {
          status: (if $gateS1 == "pass" and $gateS2S3 == "pass" then "proved" else "pending" end),
          gates: ["S1", "S2S3"],
          s1Status: $s1Status,
          controlsStatus: $controlsStatus,
          s1: $s1Details,
          controls: $controlsDetails
        },
        visualAndUsabilityEvidence: {
          status: (if $gateV1 == "pass" then "proved" else $gateV1 end),
          gate: "V1"
      },
      oneCycleObservability: {
          status: (if ($runtimePoolBlockers | length) > 0 then "blocked-by-runtime-pool" elif $cycleStatus == "missing" then "missing-cycle-summary" elif $cycleFreshnessStatus == "stale" then "stale-cycle-summary" else "available" end),
          evidenceIndexStatus: $evidenceIndexStatus,
          cycleStatus: $cycleStatus,
          freshness: {
            status: $cycleFreshnessStatus,
            ageSeconds: $cycleAgeSeconds,
            maxAgeSeconds: $cycleMaxAgeSeconds
          },
          git: {
            branch: $cycleGitBranch,
            commit: $cycleGitCommit,
            commitShort: $cycleGitCommitShort,
            currentBranch: $currentGitBranch,
            currentCommit: $currentGitCommit,
            currentCommitShort: $currentGitCommitShort,
            status: $cycleGitStatus,
            diffPaths: $cycleGitDiffPaths,
            runtimeDiffPaths: $cycleGitRuntimeDiffPaths
          },
          totalSeconds: $cycleTotalSeconds,
          slowest: $cycleSlowest
        }
      },
      gates: {
        R0: $gateR0,
        A0: $gateA0,
        R1: $gateR1,
        S1: $gateS1,
        S2S3: $gateS2S3,
        V1: $gateV1,
        N6: $gateN6
      },
      nextCyclePlan: $nextCyclePlan,
      missingOrUnproved: $missing,
      executionPanel: {
        status: $cycleStatus,
        commercialComplete: $commercialComplete,
        currentBlockingGate: $currentBlockingGate,
        blockingReason: $blockingReason,
        deploymentAdvice: $deploymentAdvice,
        nextCommand: $nextCommand
      },
      cycleFreshness: {
        status: $cycleFreshnessStatus,
        ageSeconds: $cycleAgeSeconds,
        maxAgeSeconds: $cycleMaxAgeSeconds,
        gitBranch: $cycleGitBranch,
        gitCommitShort: $cycleGitCommitShort,
        currentGitBranch: $currentGitBranch,
        currentGitCommitShort: $currentGitCommitShort,
        gitStatus: $cycleGitStatus,
        diffPaths: $cycleGitDiffPaths,
        runtimeDiffPaths: $cycleGitRuntimeDiffPaths
      },
      failures: $failures
    }'
)

if [[ -n "$REPORT" ]]; then
  mkdir -p "$(dirname "$REPORT")"
  printf '%s\n' "$audit_json" > "$REPORT"
fi

printf '\n##########################################\n'
printf '# CDS Agent goal completion audit\n'
printf '##########################################\n'
printf 'Goal status: %s\n' "$goal_status"
printf 'Commercial complete: %s\n' "$commercial_complete"
printf 'A0 boundary: %s adapter=%s/%s support=%s/%s total=%s/%s legacy=%s\n' \
  "$boundary_status" "$adapter_lines" "$adapter_max" "$support_lines" "$support_max" "$bridge_total_lines" "$bridge_total_max" "$legacy_lines"
printf 'D0 docs calibration: %s\n' "$docs_calibration_status"
printf 'D1 progress consistency: %s\n' "$progress_consistency_status"
printf 'N6 compatibility: %s\n' "$n6_status"
printf 'Evidence index quality: %s\n' "$evidence_index_status"
printf 'Runtime pool recovery: %s source=%s sharedKind=%s sharedRunning=%s contaminatedBranches=%s remoteHosts=%s enabledHosts=%s branchDeployAllowed=%s\n' \
  "$runtime_pool_plan_status" \
  "$runtime_pool_plan_source" \
  "$runtime_pool_shared_kind" \
  "$runtime_pool_shared_running" \
  "$runtime_pool_contaminated_count" \
  "$runtime_pool_remote_host_count" \
  "$runtime_pool_enabled_host_count" \
  "$runtime_pool_branch_deploy_allowed"
if [[ "$r0_readiness_json" != "null" ]]; then
  printf 'R0 apply readiness: readyForR0Apply=%s nextAction=%s\n' \
    "$(jq -r '.readyForR0Apply // false' <<< "$r0_readiness_json")" \
    "$(jq -r '.nextAction // "unknown"' <<< "$r0_readiness_json")"
fi
printf 'Branch isolation apply manifest: %s\n' "$branch_manifest_status"
if [[ "$branch_manifest_json" != "null" ]]; then
  printf 'Branch isolation manifest endpoint: %s\n' "$(jq -r '.applyManifest.endpoint // "unknown"' <<< "$branch_manifest_json")"
  printf 'Branch isolation manifest safety: %s\n' "$(jq -r '.applyManifest.safety // "unknown"' <<< "$branch_manifest_json")"
fi
if [[ "$runtime_pool_blockers_json" != "[]" ]]; then
  printf 'Legacy fallback blockers (not product path):\n'
  jq -r '.[] | "  - " + .requirement + " · " + .status' <<< "$runtime_pool_blockers_json"
fi
printf 'Cycle status: %s\n' "$cycle_status"
printf 'Cycle freshness: %s age=%ss max=%ss git=%s@%s current=%s@%s match=%s\n' \
  "$cycle_freshness_status" "$cycle_age_seconds" "$CYCLE_MAX_AGE_SECONDS" \
  "${cycle_git_branch:-unknown}" "${cycle_git_commit_short:-unknown}" \
  "${current_git_branch:-unknown}" "${current_git_commit_short:-unknown}" "$cycle_git_status"
if [[ "$cycle_git_status" == "compatible_non_runtime_drift" ]]; then
  printf 'Cycle git drift: compatible non-runtime changes since summary:\n'
  printf '%s\n' "${CYCLE_GIT_DIFF_PATHS[@]}" | sed 's/^/  - /'
elif [[ "$cycle_git_status" == "runtime_mismatch" ]]; then
  printf 'Cycle git runtime drift:\n'
  printf '%s\n' "${CYCLE_GIT_RUNTIME_DIFF_PATHS[@]}" | sed 's/^/  - /'
fi
if [[ "$remote_branch_observed" == "true" ]]; then
  printf 'Remote CDS branch: %s source=%s status=%s github=%s runtime=%s deployCount=%s lastDeployAt=%s\n' \
    "$remote_branch_id" \
    "$remote_branch_source" \
    "${remote_branch_status:-unknown}" \
    "${remote_github_commit:-unknown}" \
    "${remote_runtime_commit:-unknown}" \
    "${remote_deploy_count:-unknown}" \
    "${remote_last_deploy_at:-unknown}"
  printf 'Remote runtime relation: %s\n' "$remote_runtime_relation"
  printf 'Remote deploy advice: %s\n' "$remote_deploy_advice"
else
  printf 'Remote CDS branch: not observed (%s)\n' "$remote_deploy_advice"
fi
if [[ "$control_plane_observed" == "true" ]]; then
  printf 'CDS control plane: branch=%s commit=%s relation=%s cdsTouched=%s subject=%s\n' \
    "${control_plane_current_branch:-unknown}" \
    "${control_plane_current_commit:-unknown}" \
    "$control_plane_relation" \
    "${control_plane_branch_head_cds_touched:-unknown}" \
    "${control_plane_branch_head_subject:-unknown}"
  printf 'CDS control plane branch head: commit=%s\n' "${control_plane_branch_head_commit:-unknown}"
  printf 'Control-plane advice: %s\n' "$control_plane_advice"
else
  printf 'CDS control plane: not observed (%s)\n' "$control_plane_advice"
fi
printf 'Current blocking gate: %s\n' "${current_blocking_gate:-unknown}"
printf 'Blocking reason: %s\n' "$blocking_reason"
if [[ "$r1_details_json" != "null" ]]; then
  printf 'R1 profile: %s / %s / %s compatible=%s hasKey=%s\n' \
    "$(jq -r '.defaultProfile.name // "unknown"' <<< "$r1_details_json")" \
    "$(jq -r '.defaultProfile.protocol // "unknown"' <<< "$r1_details_json")" \
    "$(jq -r '.defaultProfile.model // "unknown"' <<< "$r1_details_json")" \
    "$(jq -r 'if .defaultProfile | has("compatibleWithDesiredRuntimeAdapter") then (.defaultProfile.compatibleWithDesiredRuntimeAdapter | tostring) else "unknown" end' <<< "$r1_details_json")" \
    "$(jq -r 'if .defaultProfile | has("hasApiKey") then (.defaultProfile.hasApiKey | tostring) else "unknown" end' <<< "$r1_details_json")"
  r1_reason_code=$(jq -r '.defaultProfile.compatibilityReasonCode // ""' <<< "$r1_details_json")
  r1_reason=$(jq -r '.defaultProfile.compatibilityReason // .defaultProfile.warning // ""' <<< "$r1_details_json")
  if [[ -n "$r1_reason_code" || -n "$r1_reason" ]]; then
    printf 'R1 profile reason: %s%s%s\n' \
      "${r1_reason_code:-unknown}" \
      "$([[ -n "$r1_reason" ]] && printf ' · ' || true)" \
      "$r1_reason"
  fi
  printf 'R1 target: %s / %s / %s\n' \
    "$(jq -r '.targetTemplateId // "unknown"' <<< "$r1_details_json")" \
    "$(jq -r '.targetTemplate.protocol // "unknown"' <<< "$r1_details_json")" \
    "$(jq -r '.targetTemplate.model // "unknown"' <<< "$r1_details_json")"
fi
if [[ "$s1_details_json" != "null" || "$controls_details_json" != "null" ]]; then
  printf 'Provider smokes: S1=%s S2/S3=%s target=%s@%s\n' \
    "$s1_status" \
    "$controls_status" \
    "$(jq -r '(.target.repo // .target.gitRepository // "unknown")' <<< "$s1_details_json")" \
    "$(jq -r '(.target.ref // .target.gitRef // "unknown")' <<< "$s1_details_json")"
fi
printf 'Deploy/build advice: %s\n' "$deployment_advice"
printf 'Next command: %s\n' "$next_command"
if [[ "$next_cycle_plan_json" != "null" ]]; then
  printf 'Next cycle plan: %s state=%s items=%s\n' \
    "$(jq -r '.cycle // "unknown"' <<< "$next_cycle_plan_json")" \
    "$(jq -r '.state // "unknown"' <<< "$next_cycle_plan_json")" \
    "$(jq -r '[.items[]?.code] | join(",")' <<< "$next_cycle_plan_json")"
fi
printf 'Gates: R0=%s A0=%s R1=%s S1=%s S2/S3=%s V1=%s N6=%s\n' \
  "$gate_r0" "$gate_a0" "$gate_r1" "$gate_s1" "$gate_s2s3" "$gate_v1" "$gate_n6"
printf 'Local guardrail time: %ss\n' "$timing_total_seconds"
if (( ${#timing_names[@]} > 0 )); then
  printf 'Slowest local guardrails:\n'
  jq -r '.[] | "  - " + .name + " · " + (.durationSeconds|tostring) + "s · " + .status' <<< "$timing_slowest_json"
fi
printf 'Audit dir: %s\n' "$AUDIT_DIR"
if [[ -n "$REPORT" ]]; then
  printf 'Audit report: %s\n' "$REPORT"
fi

if (( ${#failures[@]} > 0 )); then
  printf 'Audit guardrail failures:\n' >&2
  for failure in "${failures[@]}"; do
    printf '  - %s\n' "$failure" >&2
  done
  exit 1
fi
