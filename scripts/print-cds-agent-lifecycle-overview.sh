#!/usr/bin/env bash
# Print a goal-level lifecycle overview for CDS Agent.
# This answers "where are we in the whole lifecycle" rather than only
# "what is the next command".

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DEFAULT_AUDIT="/tmp/cds-agent-goal-audit-current-with-readiness.json"
if [[ -f "/tmp/cds-agent-goal-audit-current.json" ]]; then
  DEFAULT_AUDIT="/tmp/cds-agent-goal-audit-current.json"
fi
AUDIT="${CDS_AGENT_GOAL_AUDIT_REPORT:-$DEFAULT_AUDIT}"
READINESS="${CDS_AGENT_R0_READINESS_SUMMARY:-/tmp/cds-agent-r0-apply-readiness-current.json}"
OUTPUT="${CDS_AGENT_LIFECYCLE_OVERVIEW:-}"
DEFAULT_RUNTIME_SUMMARY="/tmp/cds-agent-remote-host-pool-current-readonly-live/summary.json"
if [[ -f "/tmp/cds-agent-runtime-pool-evidence-after-capacity-latest/summary.json" ]]; then
  DEFAULT_RUNTIME_SUMMARY="/tmp/cds-agent-runtime-pool-evidence-after-capacity-latest/summary.json"
fi
REMOTE_HOST_SUMMARY="${CDS_AGENT_REMOTE_HOST_SUMMARY:-$DEFAULT_RUNTIME_SUMMARY}"
SIDECAR_IMAGE_BUILD_REPORT="${CDS_AGENT_SIDECAR_IMAGE_BUILD_REPORT:-/tmp/cds-agent-sidecar-image-build-current.json}"
SIDECAR_IMAGE_PUBLISH_REPORT="${CDS_AGENT_SIDECAR_IMAGE_PUBLISH_REPORT:-/tmp/cds-agent-sidecar-image-publish-current.json}"
SIDECAR_REGISTRY_VERIFY_REPORT="${CDS_AGENT_SIDECAR_REGISTRY_VERIFY_REPORT:-/tmp/cds-agent-sidecar-registry-image-current.json}"
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
image_registry_visible="not checked"
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
if [[ -f "$SIDECAR_REGISTRY_VERIFY_REPORT" ]]; then
  image_registry_visible=$(jq -r '.status // "unknown"' "$SIDECAR_REGISTRY_VERIFY_REPORT")
fi
if [[ -f "$REMOTE_PULL_REPORT" ]]; then
  remote_pull=$(jq -r '.status // "unknown"' "$REMOTE_PULL_REPORT")
fi
[[ -n "$missing_config" ]] || missing_config="none"

if [[ "$r0" == "pass" && "$blocking_gate" == "R1" ]]; then
  ready_for_r0="passed_by_runtime_capacity"
  missing_config="operator-fallback-only"
  image_readiness="operator-fallback-only"
  image_next_action="not product path"
  image_registry_visible="operator-fallback-only"
  remote_pull="operator-fallback-only"
fi

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

The implementation is not complete. The control-plane architecture is back on the CDS-managed runtime path, R0 live capacity is proved, and the current blocker is R1 provider/profile proof.

Current blocker:

$blocking_reason

Deployment advice:

$deployment_advice

## Lifecycle

| Order | Lifecycle phase | State | Evidence | Remaining distance |
| --- | --- | --- | --- | --- |
| 1 | Design and boundary: MAP/CDS as control plane, official SDK owns loop | $(stage_state "$a0") | A0=$a0, adapter boundary smoke | Keep legacy loop explicit fallback only |
| 2 | Other-agent compatibility | $(stage_state "$n6") | N6=$n6, non-code/candidate SDK smoke | Re-run after provider cycle |
| 3 | R0 CDS-managed official SDK runtime pool | $(stage_state "$r0") | R0=$r0, readyForR0Apply=$ready_for_r0 | Keep SSH/image/remote host as operator fallback only |
| 4 | R1 Anthropic/Claude profile | $(stage_state "$r1") | R1=$r1 | Configure compatible default profile after R0 |
| 5 | S1 provider read-only run | $(stage_state "$s1") | S1=$s1 | Run after R0/R1 with explicit provider opt-in |
| 6 | S2/S3 approval and interrupt controls | $(stage_state "$s2s3") | S2S3=$s2s3 | Run approval/stop smokes after S1 |
| 7 | V1 visual/usability evidence | $(stage_state "$v1") | V1=$v1 current authenticated page evidence | Re-capture true provider-backed page after R1/S1-S3 |
| 8 | Commercial closure | blocked | goalStatus=$goal_status | Audit must show all gates pass with fresh current evidence |

## Distance To Target

- Done: A0 official SDK boundary; D1 architecture correction; R0 CDS-managed runtime live capacity; N6 compatibility; V1 dry-run visual evidence.
- Blocking now: R1 Anthropic/Claude-compatible default provider profile.
- Not yet started in current provider-backed cycle: S1, S2/S3, final live V1 recapture.
- Legacy fallback missing inputs: $missing_config
- Legacy fallback sidecar image readiness: $image_readiness; $image_next_action
- Sidecar build context: $image_build_context
- Sidecar local docker build: $image_local_build
- Sidecar registry publish: $image_publish
- Sidecar registry manifest: $image_registry_visible
- Remote host docker pull: $remote_pull

## Critical Path

1. R1: configure or select an Anthropic/Claude-compatible default profile. ETA after key/profile is available: 5-15 min.
2. S1: run provider-backed read-only official SDK cycle. ETA: 5-10 min.
3. S2/S3: run approval and stop/cancel controls. ETA: 5-15 min.
4. V1: capture provider-backed live-runtime page evidence. ETA: 3-8 min.
5. Final audit and docs archive. ETA: 10-20 min.

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
- sidecar registry manifest: $SIDECAR_REGISTRY_VERIFY_REPORT
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
