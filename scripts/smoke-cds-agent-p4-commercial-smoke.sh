#!/usr/bin/env bash
# ============================================
# CDS Agent P4 commercial preview smoke
# ============================================
#
# One command for the commercial preview baseline:
#   - preview HTTP 200 and bundle sanity
#   - session list / stale running guard
#   - runtime-status and readiness gates through one-cycle smoke
#   - optional provider-backed S1/S2/S3 when SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1
#   - authenticated visual smoke with screenshot
#   - single machine-readable summary under artifacts/cds-agent/YYYY-MM-DD
#
# This wrapper does not replace the lower-level smoke scripts. It standardizes
# evidence location and gives deploy/preview changes one stable acceptance entry.
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"
smoke_require_tools

SMOKE_CDS_AGENT_P4_LABEL="${SMOKE_CDS_AGENT_P4_LABEL:-p4-25-commercial-smoke}"
SMOKE_CDS_AGENT_PREVIEW_BRANCH_ID="${SMOKE_CDS_AGENT_PREVIEW_BRANCH_ID:-prd-agent-main}"
SMOKE_CDS_AGENT_FAIL_ON_STALE_RUNNING="${SMOKE_CDS_AGENT_FAIL_ON_STALE_RUNNING:-1}"
SMOKE_CDS_AGENT_REMEDIATE_STALE_RUNNING="${SMOKE_CDS_AGENT_REMEDIATE_STALE_RUNNING:-1}"
SMOKE_CDS_AGENT_SESSION_LIMIT="${SMOKE_CDS_AGENT_SESSION_LIMIT:-50}"
SMOKE_CDS_AGENT_HTTP_BODY_BYTES="${SMOKE_CDS_AGENT_HTTP_BODY_BYTES:-200000}"

smoke_infer_preview_host
export SMOKE_TEST_HOST="$SMOKE_HOST"

RUN_ID="$(date +%Y%m%d%H%M%S)"
RUN_DATE="$(date +%Y-%m-%d)"
RUN_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_STARTED_SEC="$(date +%s)"
ARTIFACT_ROOT="${SMOKE_CDS_AGENT_ARTIFACT_ROOT:-$ROOT_DIR/artifacts/cds-agent/$RUN_DATE}"
RUN_DIR="${SMOKE_CDS_AGENT_RUN_DIR:-$ARTIFACT_ROOT/$SMOKE_CDS_AGENT_P4_LABEL-$RUN_ID}"
SUMMARY="$RUN_DIR/summary.json"
ONE_CYCLE_DIR="$RUN_DIR/one-cycle"
PREVIEW_URL="${SMOKE_CDS_AGENT_WORKBENCH_URL:-${SMOKE_HOST%/}/cds-agent?viewMode=simple}"
TRACE_ID="${SMOKE_CDS_AGENT_TRACE_ID:-$SMOKE_CDS_AGENT_P4_LABEL-$RUN_ID}"

mkdir -p "$RUN_DIR" "$ONE_CYCLE_DIR"

json_string_or_null() {
  local value="${1:-}"
  if [[ -z "$value" ]]; then
    printf 'null'
  else
    jq -n --arg value "$value" '$value'
  fi
}

write_summary() {
  local status="$1"
  local failure_code="${2:-}"
  local failure_message="${3:-}"
  local completed_at elapsed provider_required provider_status visual_status runtime_status stale_status
  local preview_json="$RUN_DIR/preview-http.json"
  local sessions_json="$RUN_DIR/session-hygiene.json"
  local cycle_json="$ONE_CYCLE_DIR/cycle-summary.json"
  local deploy_json="$RUN_DIR/deploy-evidence.json"
  completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  elapsed=$(( $(date +%s) - RUN_STARTED_SEC ))
  provider_required=false
  [[ "${SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL:-0}" == "1" ]] && provider_required=true

  [[ -f "$preview_json" ]] || printf 'null\n' > "$preview_json"
  [[ -f "$sessions_json" ]] || printf 'null\n' > "$sessions_json"
  [[ -f "$cycle_json" ]] || printf 'null\n' > "$cycle_json"
  [[ -f "$deploy_json" ]] || printf 'null\n' > "$deploy_json"

  runtime_status="unknown"
  provider_status="not_requested"
  visual_status="unknown"
  stale_status="unknown"
  if [[ "$(jq -r 'type' "$cycle_json" 2>/dev/null || printf null)" == "object" ]]; then
    runtime_status=$(jq -r '.commercialGates.R0.status // .gates.R0 // "unknown"' "$cycle_json")
    provider_status=$(jq -r '(.commercialGates.S1.status // .gates.S1 // "unknown") + "/" + (.commercialGates.S2S3.status // .gates.S2S3 // "unknown")' "$cycle_json")
    visual_status=$(jq -r '.commercialGates.V1.status // .gates.V1 // "unknown"' "$cycle_json")
  fi
  if [[ "$(jq -r 'type' "$sessions_json" 2>/dev/null || printf null)" == "object" ]]; then
    stale_status=$(jq -r '.status // "unknown"' "$sessions_json")
  fi

  jq -n \
    --arg schemaVersion "cds-agent-p4-commercial-smoke/v1" \
    --arg runLabel "$SMOKE_CDS_AGENT_P4_LABEL" \
    --arg runId "$RUN_ID" \
    --arg status "$status" \
    --arg startedAt "$RUN_STARTED_AT" \
    --arg completedAt "$completed_at" \
    --arg host "$SMOKE_HOST" \
    --arg previewUrl "$PREVIEW_URL" \
    --arg traceId "$TRACE_ID" \
    --arg runDir "$RUN_DIR" \
    --arg summaryPath "$SUMMARY" \
    --arg screenshot "$RUN_DIR/workbench-visual.png" \
    --arg coverage "$RUN_DIR/workbench-visual.coverage.json" \
    --arg failureCode "$failure_code" \
    --arg failureMessage "$failure_message" \
    --arg runtimeStatus "$runtime_status" \
    --arg providerStatus "$provider_status" \
    --arg visualStatus "$visual_status" \
    --arg staleStatus "$stale_status" \
    --argjson elapsedSeconds "$elapsed" \
    --argjson providerRequired "$provider_required" \
    --slurpfile preview "$preview_json" \
    --slurpfile sessions "$sessions_json" \
    --slurpfile cycle "$cycle_json" \
    --slurpfile deploy "$deploy_json" \
    '{
      schemaVersion: $schemaVersion,
      "label": $runLabel,
      runId: $runId,
      status: $status,
      startedAt: $startedAt,
      completedAt: $completedAt,
      elapsedSeconds: $elapsedSeconds,
      traceId: $traceId,
      target: {
        host: $host,
        previewUrl: $previewUrl
      },
      gates: {
        previewHttp: (($preview[0].status // "missing") as $s | $s),
        runtime: $runtimeStatus,
        provider: $providerStatus,
        visual: $visualStatus,
        sessionHygiene: $staleStatus
      },
      providerRequired: $providerRequired,
      artifacts: {
        runDir: $runDir,
        summary: $summaryPath,
        previewHttp: ($runDir + "/preview-http.json"),
        sessionHygiene: ($runDir + "/session-hygiene.json"),
        oneCycleSummary: ($runDir + "/one-cycle/cycle-summary.json"),
        screenshot: $screenshot,
        visualCoverage: $coverage,
        logsDir: ($runDir + "/one-cycle")
      },
      deployEvidence: ($deploy[0] // null),
      preview: ($preview[0] // null),
      sessionHygiene: ($sessions[0] // null),
      oneCycle: ($cycle[0] // null),
      error: (if $status == "pass" then null else {
        code: $failureCode,
        message: $failureMessage,
        traceId: $traceId,
        source: "smoke-cds-agent-p4-commercial-smoke",
        elapsedSeconds: $elapsedSeconds
      } end)
    }' > "$SUMMARY"
}

fail_with_summary() {
  local code="$1"
  local message="$2"
  write_summary "failed" "$code" "$message"
  printf '❌ %s: %s\n' "$code" "$message" >&2
  printf 'Summary: %s\n' "$SUMMARY" >&2
  exit 1
}

write_session_hygiene() {
  local input_json="$1"
  local output_json="$2"
  jq -n --slurpfile raw "$input_json" --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    def normalize_time($v):
      if ($v | type) != "string" then ""
      else ($v | sub("\\.[0-9]+Z$"; "Z"))
      end;
    def parse_time($v): try (normalize_time($v) | fromdateiso8601) catch 0;
    def live_status($s):
      if ($s.status == "running" or $s.status == "creating" or $s.status == "idle") then true else false end;
    ($raw[0].data.items // []) as $items
    | ($checkedAt | fromdateiso8601) as $checkedAtSec
    | [ $items[]
        | . as $s
        | (parse_time($s.startedAt // $s.createdAt // $s.updatedAt // "")) as $started
        | (($s.timeoutSeconds // 900) | tonumber) as $timeout
        | select(live_status($s))
        | select($started > 0)
        | select(($checkedAtSec - $started) > ($timeout + 120))
        | {
            id: $s.id,
            title: $s.title,
            status: $s.status,
            traceId: $s.traceId,
            startedAt: $s.startedAt,
            timeoutSeconds: $s.timeoutSeconds,
            ageSeconds: ($checkedAtSec - $started)
          }
      ] as $stale
    | {
        checkedAt: $checkedAt,
        status: (if ($stale | length) == 0 then "pass" else "failed" end),
        total: ($items | length),
        staleRunningCount: ($stale | length),
        staleRunning: $stale,
        remediated: false,
        rule: "running/creating/idle older than timeoutSeconds+120s must not lead the commercial workbench"
      }' > "$output_json"
}

fetch_sessions() {
  local output_json="$1"
  local code
  code=$(curl --max-time "$SMOKE_TIMEOUT" --show-error --silent \
    --output "$output_json" \
    --write-out '%{http_code}' \
    -H "X-AI-Access-Key: ${AI_ACCESS_KEY:-}" \
    -H "X-AI-Impersonate: ${SMOKE_USER:-admin}" \
    -H "Accept: application/json" \
    "${SMOKE_HOST%/}/api/infra-agent-sessions?limit=$SMOKE_CDS_AGENT_SESSION_LIMIT" || true)
  printf '%s' "$code"
}

printf '##########################################\n'
printf '# CDS Agent P4 commercial preview smoke\n'
printf '##########################################\n'
printf 'Host: %s\n' "$SMOKE_HOST"
printf 'Preview: %s\n' "$PREVIEW_URL"
printf 'Provider calls: %s\n' "${SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL:-0}"
printf 'Artifacts: %s\n' "$RUN_DIR"

printf '\n[01/05] Preview HTTP and bundle sanity\n'
preview_body="$RUN_DIR/preview.html"
preview_headers="$RUN_DIR/preview.headers"
preview_code=$(curl --max-time "$SMOKE_TIMEOUT" --show-error --silent \
  --dump-header "$preview_headers" \
  --output "$preview_body" \
  --write-out '%{http_code}' \
  --range "0-$SMOKE_CDS_AGENT_HTTP_BODY_BYTES" \
  "$PREVIEW_URL" || true)
bundle_local_count=$( (grep -Eo '[^"]+-local\.(js|css)' "$preview_body" 2>/dev/null || true) | wc -l | tr -d ' ' )
bundle_asset_count=$( (grep -Eo '/assets/[^"]+\.(js|css)' "$preview_body" 2>/dev/null || true) | sort -u | wc -l | tr -d ' ' )
preview_status="pass"
preview_error=""
if [[ "$preview_code" != "200" && "$preview_code" != "206" ]]; then
  preview_status="failed"
  preview_error="preview_http_${preview_code}"
elif (( bundle_local_count > 0 )); then
  preview_status="failed"
  preview_error="old_local_bundle_detected"
fi
jq -n \
  --arg status "$preview_status" \
  --arg url "$PREVIEW_URL" \
  --arg httpStatus "$preview_code" \
  --arg error "$preview_error" \
  --arg headers "$preview_headers" \
  --arg body "$preview_body" \
  --argjson bundleAssetCount "$bundle_asset_count" \
  --argjson localBundleCount "$bundle_local_count" \
  '{
    status: $status,
    url: $url,
    httpStatus: $httpStatus,
    error: (if $error == "" then null else $error end),
    bundle: {
      assetCount: $bundleAssetCount,
      localBundleCount: $localBundleCount,
      oldLocalBundleDetected: ($localBundleCount > 0)
    },
    evidence: { headers: $headers, body: $body }
  }' > "$RUN_DIR/preview-http.json"
[[ "$preview_status" == "pass" ]] || fail_with_summary "$preview_error" "Preview is not commercially usable: HTTP=$preview_code localBundles=$bundle_local_count"
printf 'Preview OK: HTTP=%s assets=%s localBundles=%s\n' "$preview_code" "$bundle_asset_count" "$bundle_local_count"

printf '\n[02/05] Session hygiene guard\n'
sessions_raw="$RUN_DIR/sessions.json"
sessions_code=$(fetch_sessions "$sessions_raw")
if [[ "$sessions_code" != "200" ]]; then
  fail_with_summary "session_list_http_${sessions_code}" "Could not read session list for stale-running guard"
fi
write_session_hygiene "$sessions_raw" "$RUN_DIR/session-hygiene.json"
stale_status=$(jq -r '.status' "$RUN_DIR/session-hygiene.json")
stale_count=$(jq -r '.staleRunningCount' "$RUN_DIR/session-hygiene.json")
if [[ "$stale_status" != "pass" && "$SMOKE_CDS_AGENT_REMEDIATE_STALE_RUNNING" == "1" ]]; then
  remediation_log="$RUN_DIR/session-hygiene-remediation.log"
  printf 'Remediating %s stale running sessions with stop+archive...\n' "$stale_count" | tee "$remediation_log"
  while IFS= read -r stale_session_id; do
    [[ -z "$stale_session_id" ]] && continue
    printf 'session=%s stop\n' "$stale_session_id" | tee -a "$remediation_log"
    curl --max-time "$SMOKE_TIMEOUT" --show-error --silent \
      --output "$RUN_DIR/session-stop-$stale_session_id.json" \
      -X POST \
      -H "X-AI-Access-Key: ${AI_ACCESS_KEY:-}" \
      -H "X-AI-Impersonate: ${SMOKE_USER:-admin}" \
      -H "Content-Type: application/json" \
      --data '{}' \
      "${SMOKE_HOST%/}/api/infra-agent-sessions/$stale_session_id/stop" >/dev/null || true
    printf 'session=%s archive\n' "$stale_session_id" | tee -a "$remediation_log"
    curl --max-time "$SMOKE_TIMEOUT" --show-error --silent \
      --output "$RUN_DIR/session-archive-$stale_session_id.json" \
      -X POST \
      -H "X-AI-Access-Key: ${AI_ACCESS_KEY:-}" \
      -H "X-AI-Impersonate: ${SMOKE_USER:-admin}" \
      -H "Content-Type: application/json" \
      --data '{}' \
      "${SMOKE_HOST%/}/api/infra-agent-sessions/$stale_session_id/archive" >/dev/null || true
  done < <(jq -r '.staleRunning[].id' "$RUN_DIR/session-hygiene.json")
  sessions_after="$RUN_DIR/sessions-after-remediation.json"
  sessions_after_code=$(fetch_sessions "$sessions_after")
  if [[ "$sessions_after_code" == "200" ]]; then
    write_session_hygiene "$sessions_after" "$RUN_DIR/session-hygiene.json"
    tmp_hygiene="$RUN_DIR/session-hygiene.tmp.json"
    jq '.remediated = true' "$RUN_DIR/session-hygiene.json" > "$tmp_hygiene"
    mv "$tmp_hygiene" "$RUN_DIR/session-hygiene.json"
    stale_status=$(jq -r '.status' "$RUN_DIR/session-hygiene.json")
    stale_count=$(jq -r '.staleRunningCount' "$RUN_DIR/session-hygiene.json")
  fi
fi
if [[ "$stale_status" != "pass" && "$SMOKE_CDS_AGENT_FAIL_ON_STALE_RUNNING" == "1" ]]; then
  fail_with_summary "stale_running_sessions" "Found $stale_count stale running sessions that can mislead the preview"
fi
printf 'Session hygiene: %s staleRunning=%s\n' "$stale_status" "$stale_count"

printf '\n[03/05] Deploy evidence snapshot\n'
deploy_status="not_observed"
deploy_error=""
branch_status_json="null"
if [[ -n "${CDS_HOST:-}" && -f "$ROOT_DIR/.claude/skills/cds/cli/cdscli.py" ]]; then
  if branch_raw=$(CDS_HOST="$CDS_HOST" python3 "$ROOT_DIR/.claude/skills/cds/cli/cdscli.py" branch status "$SMOKE_CDS_AGENT_PREVIEW_BRANCH_ID" 2>"$RUN_DIR/deploy-evidence.stderr"); then
    branch_status_json=$(printf '%s' "$branch_raw" | jq -c '.data // null' 2>/dev/null || printf 'null')
    deploy_status="observed"
  else
    deploy_status="failed"
    deploy_error="cds_branch_status_failed"
  fi
fi
jq -n \
  --arg status "$deploy_status" \
  --arg error "$deploy_error" \
  --arg branchId "$SMOKE_CDS_AGENT_PREVIEW_BRANCH_ID" \
  --arg traceId "$TRACE_ID" \
  --argjson branch "$branch_status_json" \
  '{
    status: $status,
    error: (if $error == "" then null else $error end),
    traceId: $traceId,
    branchId: $branchId,
    commit: ($branch.commitSha // null),
    githubCommit: ($branch.githubCommitSha // null),
    previewSlug: ($branch.previewSlug // null),
    deployCount: ($branch.deployCount // null),
    lastDeployAt: ($branch.lastDeployAt // null),
    daemonRestarted: null,
    webOnly: null,
    elapsedSeconds: null,
    raw: $branch
  }' > "$RUN_DIR/deploy-evidence.json"
printf 'Deploy evidence: %s\n' "$deploy_status"

printf '\n[04/05] One-cycle commercial smoke\n'
export SMOKE_CDS_AGENT_CYCLE_DIR="$ONE_CYCLE_DIR"
export SMOKE_CDS_AGENT_CYCLE_SUMMARY="$ONE_CYCLE_DIR/cycle-summary.json"
export SMOKE_CDS_AGENT_WORKBENCH_URL="$PREVIEW_URL"
export SMOKE_CDS_AGENT_SCREENSHOT="$RUN_DIR/workbench-visual.png"
export SMOKE_CDS_AGENT_TEXT_DUMP="$RUN_DIR/workbench-visual.txt"
export SMOKE_CDS_AGENT_VISUAL_COVERAGE="$RUN_DIR/workbench-visual.coverage.json"
if ! bash "$SCRIPT_DIR/smoke-cds-agent-one-cycle.sh" 2>&1 | tee "$RUN_DIR/one-cycle.log"; then
  fail_with_summary "one_cycle_failed" "One-cycle commercial smoke failed; inspect $RUN_DIR/one-cycle.log"
fi

printf '\n[05/05] Final commercial gate check\n'
if [[ ! -f "$ONE_CYCLE_DIR/cycle-summary.json" ]]; then
  fail_with_summary "missing_cycle_summary" "One-cycle did not write cycle-summary.json"
fi
cycle_status=$(jq -r '.status // "unknown"' "$ONE_CYCLE_DIR/cycle-summary.json")
commercial_complete=$(jq -r '.commercialComplete // false' "$ONE_CYCLE_DIR/cycle-summary.json")
v1_gate=$(jq -r '.commercialGates.V1.status // .gates.V1 // "unknown"' "$ONE_CYCLE_DIR/cycle-summary.json")
if [[ "${SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL:-0}" == "1" ]]; then
  [[ "$commercial_complete" == "true" ]] || fail_with_summary "commercial_not_complete" "Provider run was requested but commercialComplete is not true (cycle=$cycle_status)"
else
  [[ "$v1_gate" == "pass" ]] || fail_with_summary "visual_not_pass" "Provider calls disabled, but visual gate still must pass"
fi
write_summary "pass"
printf '✅ P4 commercial preview smoke passed · summary=%s\n' "$SUMMARY"
