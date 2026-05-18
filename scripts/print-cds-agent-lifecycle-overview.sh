#!/usr/bin/env bash
# Print a goal-level lifecycle overview for CDS Agent.
# This answers "where are we in the whole lifecycle" rather than only
# "what is the next command".

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

AUDIT="${CDS_AGENT_GOAL_AUDIT_REPORT:-/tmp/cds-agent-goal-audit-current-with-readiness.json}"
READINESS="${CDS_AGENT_R0_READINESS_SUMMARY:-/tmp/cds-agent-r0-apply-readiness-current.json}"
OUTPUT="${CDS_AGENT_LIFECYCLE_OVERVIEW:-}"
REMOTE_HOST_SUMMARY="${CDS_AGENT_REMOTE_HOST_SUMMARY:-/tmp/cds-agent-remote-host-pool-current-readonly-live/summary.json}"
SIDECAR_IMAGE_BUILD_REPORT="${CDS_AGENT_SIDECAR_IMAGE_BUILD_REPORT:-/tmp/cds-agent-sidecar-image-build-current.json}"
SIDECAR_IMAGE_PUBLISH_REPORT="${CDS_AGENT_SIDECAR_IMAGE_PUBLISH_REPORT:-/tmp/cds-agent-sidecar-image-publish-current.json}"
REMOTE_PULL_REPORT="${CDS_AGENT_REMOTE_PULL_REPORT:-/tmp/cds-agent-remote-sidecar-pull-current.json}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "missing dependency: jq"
[[ -f "$AUDIT" ]] || fail "goal audit not found: $AUDIT"

if [[ -x "$SCRIPT_DIR/preflight-cds-agent-r0-apply-readiness.sh" && -f "$REMOTE_HOST_SUMMARY" ]]; then
  CDS_AGENT_R0_READINESS_REPORT="$READINESS" \
  CDS_AGENT_REMOTE_HOST_SUMMARY="$REMOTE_HOST_SUMMARY" \
    bash "$SCRIPT_DIR/preflight-cds-agent-r0-apply-readiness.sh" >/dev/null 2>&1 || true
fi

goal_status=$(jq -r '.goalStatus // "unknown"' "$AUDIT")
commercial_complete=$(jq -r '.commercialComplete // false' "$AUDIT")
blocking_gate=$(jq -r '.executionPanel.currentBlockingGate // "unknown"' "$AUDIT")
blocking_reason=$(jq -r '.executionPanel.blockingReason // "unknown"' "$AUDIT")
deployment_advice=$(jq -r '.executionPanel.deploymentAdvice // "unknown"' "$AUDIT")
r0=$(jq -r '.gates.R0 // "unknown"' "$AUDIT")
a0=$(jq -r '.gates.A0 // "unknown"' "$AUDIT")
r1=$(jq -r '.gates.R1 // "unknown"' "$AUDIT")
s1=$(jq -r '.gates.S1 // "unknown"' "$AUDIT")
s2s3=$(jq -r '.gates.S2S3 // "unknown"' "$AUDIT")
v1=$(jq -r '.gates.V1 // "unknown"' "$AUDIT")
n6=$(jq -r '.gates.N6 // "unknown"' "$AUDIT")

ready_for_r0="unknown"
missing_config="unknown"
image_readiness="unknown"
image_next_action="unknown"
image_build_context="unknown"
image_local_build="not checked"
image_publish="not checked"
remote_pull="not checked"
if [[ -f "$READINESS" ]]; then
  ready_for_r0=$(jq -r '.readyForR0Apply // false' "$READINESS")
  missing_config=$(jq -r '(.missingConfig // []) | join(", ")' "$READINESS")
  image_readiness=$(jq -r '.imageReadiness.status // "unknown"' "$READINESS")
  image_next_action=$(jq -r '.imageReadiness.nextAction // "unknown"' "$READINESS")
  image_build_context=$(jq -r '.imageReadiness.buildContextStatus // "unknown"' "$READINESS")
else
  ready_for_r0=$(jq -r '.runtimePoolRecovery.applyReadiness.readyForR0Apply // "unknown"' "$AUDIT")
  missing_config=$(jq -r '(.runtimePoolRecovery.applyReadiness.missingConfig // []) | join(", ")' "$AUDIT")
  image_readiness=$(jq -r '.runtimePoolRecovery.applyReadiness.imageReadiness.status // "unknown"' "$AUDIT")
  image_next_action=$(jq -r '.runtimePoolRecovery.applyReadiness.imageReadiness.nextAction // "unknown"' "$AUDIT")
  image_build_context=$(jq -r '.runtimePoolRecovery.applyReadiness.imageReadiness.buildContextStatus // "unknown"' "$AUDIT")
fi
if [[ -f "$SIDECAR_IMAGE_BUILD_REPORT" ]]; then
  image_local_build=$(jq -r '.status // "unknown"' "$SIDECAR_IMAGE_BUILD_REPORT")
fi
if [[ -f "$SIDECAR_IMAGE_PUBLISH_REPORT" ]]; then
  image_publish=$(jq -r '.status // "unknown"' "$SIDECAR_IMAGE_PUBLISH_REPORT")
fi
if [[ -f "$REMOTE_PULL_REPORT" ]]; then
  remote_pull=$(jq -r '.status // "unknown"' "$REMOTE_PULL_REPORT")
fi
[[ -n "$missing_config" ]] || missing_config="none"

stage_state() {
  local status="$1"
  case "$status" in
    pass|proved) printf done ;;
    pending|blocked|needs-remote-evidence) printf blocked ;;
    *) printf '%s' "$status" ;;
  esac
}

render() {
  cat <<EOF
# CDS Agent Lifecycle Overview

Generated: $(date '+%Y-%m-%d %H:%M:%S %Z')
Branch: $(git -C "$ROOT_DIR" branch --show-current 2>/dev/null || printf unknown)
Goal status: $goal_status
Commercial complete: $commercial_complete
Current blocking gate: $blocking_gate

## Executive Summary

The implementation is not complete. The code-side official SDK adapter boundary and non-code agent compatibility guardrails are proved, but the remote CDS shared runtime pool is not recovered.

Current blocker:

$blocking_reason

Deployment advice:

$deployment_advice

## Lifecycle

| Order | Lifecycle phase | State | Evidence | Remaining distance |
| --- | --- | --- | --- | --- |
| 1 | Design and boundary: MAP/CDS as control plane, official SDK owns loop | $(stage_state "$a0") | A0=$a0, adapter boundary smoke | Keep legacy loop explicit fallback only |
| 2 | Other-agent compatibility | $(stage_state "$n6") | N6=$n6, non-code/candidate SDK smoke | Re-run after provider cycle |
| 3 | R0 shared official SDK runtime pool | $(stage_state "$r0") | R0=$r0, readyForR0Apply=$ready_for_r0 | Provide remote host SSH config and sidecar image |
| 4 | R1 Anthropic/Claude profile | $(stage_state "$r1") | R1=$r1 | Configure compatible default profile after R0 |
| 5 | S1 provider read-only run | $(stage_state "$s1") | S1=$s1 | Run after R0/R1 with explicit provider opt-in |
| 6 | S2/S3 approval and interrupt controls | $(stage_state "$s2s3") | S2S3=$s2s3 | Run approval/stop smokes after S1 |
| 7 | V1 visual/usability evidence | partial | V1=$v1 historical/page evidence | Re-capture true live runtime session after R0/R1/S1-S3 |
| 8 | Commercial closure | blocked | goalStatus=$goal_status | Audit must show all gates pass with fresh current evidence |

## Distance To Target

- Done: A0 official SDK boundary; N6 compatibility; progress/audit/handoff observability.
- Blocking now: R0 remote runtime pool.
- Not yet started in current valid cycle: R1, S1, S2/S3, final live V1.
- Missing R0 inputs: $missing_config
- Sidecar image readiness: $image_readiness; $image_next_action
- Sidecar build context: $image_build_context
- Sidecar local docker build: $image_local_build
- Sidecar registry publish: $image_publish
- Remote host docker pull: $remote_pull

## Critical Path

1. R0.2: register/reuse enabled remote host. ETA after inputs: 1-3 min.
2. R0.3: deploy shared official SDK sidecar image. ETA after image/host: 2-5 min.
3. R0V: run shared pool post-check. ETA: 15-30 sec.
4. R1: configure Anthropic/Claude-compatible default profile. ETA: 5-15 min.
5. S1/S2/S3: run provider read-only, approval, and stop cycle. ETA: 10-25 min.
6. V1: capture real live-runtime page evidence. ETA: 3-8 min.

## Fixed Inspection Commands

\`\`\`bash
scripts/print-cds-agent-current-progress.sh
scripts/print-cds-agent-r0-operator-handoff.sh
scripts/preflight-cds-agent-r0-apply-readiness.sh
CDS_AGENT_GOAL_AUDIT_REPORT=/tmp/cds-agent-goal-audit-current-with-readiness.json bash scripts/audit-cds-agent-goal.sh
\`\`\`

## Evidence Files

- goal audit: $AUDIT
- R0 readiness: $READINESS
- sidecar image build smoke: $SIDECAR_IMAGE_BUILD_REPORT
- sidecar image publish: $SIDECAR_IMAGE_PUBLISH_REPORT
- remote sidecar pull: $REMOTE_PULL_REPORT
- R0 handoff: /tmp/cds-agent-r0-operator-handoff-current.md
- N6 summary: /tmp/cds-agent-n6-non-code-compatibility-current.json
EOF
}

if [[ -n "$OUTPUT" ]]; then
  mkdir -p "$(dirname "$OUTPUT")"
  render > "$OUTPUT"
  printf 'CDS Agent lifecycle overview: %s\n' "$OUTPUT"
else
  render
fi
