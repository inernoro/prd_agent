#!/usr/bin/env bash
# Generate one safe R0 operator handoff bundle.
# It aggregates progress, local readiness, and remote-host handoff commands
# without printing secret values.

set -euo pipefail

SUMMARY="${CDS_AGENT_REMOTE_HOST_SUMMARY:-/tmp/cds-agent-remote-host-pool-current-readonly-live/summary.json}"
READINESS_REPORT="${CDS_AGENT_R0_READINESS_REPORT:-/tmp/cds-agent-r0-apply-readiness-current.json}"
OUTPUT="${CDS_AGENT_R0_OPERATOR_HANDOFF:-/tmp/cds-agent-r0-operator-handoff-current.md}"
SIDECAR_IMAGE_BUILD_REPORT="${CDS_AGENT_SIDECAR_IMAGE_BUILD_REPORT:-/tmp/cds-agent-sidecar-image-build-current.json}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "missing dependency: jq"
[[ -f "$SUMMARY" ]] || fail "remote host summary not found: $SUMMARY"

# Refresh local readiness first. It is local-only and does not call CDS.
CDS_AGENT_REMOTE_HOST_SUMMARY="$SUMMARY" \
CDS_AGENT_R0_READINESS_REPORT="$READINESS_REPORT" \
  bash scripts/preflight-cds-agent-r0-apply-readiness.sh >/dev/null

[[ -f "$READINESS_REPORT" ]] || fail "readiness report not found: $READINESS_REPORT"

tmp_handoff="$(mktemp)"
scripts/print-cds-agent-remote-host-handoff.sh "$SUMMARY" > "$tmp_handoff"

ready_for_r0=$(jq -r '.readyForR0Apply // false' "$READINESS_REPORT")
ready_for_host=$(jq -r '.readyForHostApply // false' "$READINESS_REPORT")
ready_for_deploy=$(jq -r '.readyForDeployRequest // false' "$READINESS_REPORT")
next_action=$(jq -r '.nextAction // "unknown"' "$READINESS_REPORT")
summary_verdict=$(jq -r '.summaryVerdict // "unknown"' "$READINESS_REPORT")
enabled_hosts=$(jq -r '.remoteState.enabledHostCount // 0' "$READINESS_REPORT")
shared_running=$(jq -r '.remoteState.sharedRunning // 0' "$READINESS_REPORT")
will_create_host=$(jq -r '.remoteState.willCreateHost // true' "$READINESS_REPORT")
missing=$(jq -r '(.missingConfig // []) | join(", ")' "$READINESS_REPORT")
invalid=$(jq -r '(.invalidConfig // []) | join(", ")' "$READINESS_REPORT")
warnings=$(jq -r '(.warnings // []) | join("; ")' "$READINESS_REPORT")
image_status=$(jq -r '.imageReadiness.status // "unknown"' "$READINESS_REPORT")
image_next_action=$(jq -r '.imageReadiness.nextAction // "unknown"' "$READINESS_REPORT")
image_build_context_status=$(jq -r '.imageReadiness.buildContextStatus // "unknown"' "$READINESS_REPORT")
image_preflight_report=$(jq -r '.imageReadiness.preflightReport // "unknown"' "$READINESS_REPORT")
image_build_command=$(jq -r '.imageReadiness.candidateBuildCommand // ""' "$READINESS_REPORT")
image_push_command=$(jq -r '.imageReadiness.candidatePushCommand // ""' "$READINESS_REPORT")
image_local_build="not checked"
if [[ -f "$SIDECAR_IMAGE_BUILD_REPORT" ]]; then
  image_local_build=$(jq -r '.status // "unknown"' "$SIDECAR_IMAGE_BUILD_REPORT")
fi

mkdir -p "$(dirname "$OUTPUT")"
{
  printf '# CDS Agent R0 Operator Handoff\n\n'
  printf -- '- generatedAt: `%s`\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf -- '- branch: `%s`\n' "$(git branch --show-current 2>/dev/null || printf unknown)"
  printf -- '- objective: keep MAP/CDS as control plane; restore shared official SDK runtime before provider smokes.\n'
  printf -- '- output: `%s`\n' "$OUTPUT"
  printf -- '- remoteHostSummary: `%s`\n' "$SUMMARY"
  printf -- '- readinessReport: `%s`\n\n' "$READINESS_REPORT"

  printf '## Current Decision\n\n'
  printf -- '- status: `%s`\n' "$(if [[ "$ready_for_r0" == "true" ]]; then printf ready_for_r0_apply; else printf blocked_before_apply; fi)"
  printf -- '- nextAction: `%s`\n' "$next_action"
  printf -- '- summaryVerdict: `%s`\n' "$summary_verdict"
  printf -- '- enabledHostCount: `%s`\n' "$enabled_hosts"
  printf -- '- sharedRunning: `%s`\n' "$shared_running"
  printf -- '- willCreateHost: `%s`\n' "$will_create_host"
  printf -- '- readyForHostApply: `%s`\n' "$ready_for_host"
  printf -- '- readyForDeployRequest: `%s`\n' "$ready_for_deploy"
  printf -- '- readyForR0Apply: `%s`\n\n' "$ready_for_r0"

  printf '## Missing Or Invalid Inputs\n\n'
  printf -- '- missingConfig: `%s`\n' "${missing:-none}"
  printf -- '- invalidConfig: `%s`\n' "${invalid:-none}"
  printf -- '- warnings: `%s`\n\n' "${warnings:-none}"
  printf -- '- imageReadiness: `%s`\n' "$image_status"
  printf -- '- imageBuildContext: `%s`\n' "$image_build_context_status"
  printf -- '- imageLocalBuild: `%s`\n' "$image_local_build"
  printf -- '- imagePreflightReport: `%s`\n' "$image_preflight_report"
  printf -- '- imageNextAction: `%s`\n\n' "$image_next_action"

  printf '## Timeline\n\n'
  printf '| Step | Expected Time | Start Condition | Evidence |\n'
  printf '| --- | --- | --- | --- |\n'
  printf '| R0.2 remote host apply | 1-3 min | missingConfig except `CDS_AGENT_SIDECAR_IMAGE` is empty | `applied-host-ready` |\n'
  printf '| R0.3 shared official SDK runtime deploy | 2-5 min | enabled host + `CDS_AGENT_SIDECAR_IMAGE` | `applied-running` |\n'
  printf '| R0V post-check | 15-30 sec | shared runtime running | `smoke-cds-agent-shared-service-pool.sh` pass |\n'
  printf '| R1/S1-S3/V1 | after R0 | default Anthropic/Claude profile + provider opt-in | one-cycle evidence |\n\n'

  printf '## Do Not Do\n\n'
  printf -- '- Do not repeat normal preview redeploys for this R0 blocker.\n'
  printf -- '- Do not run provider one-cycle before `REMOTE_HOST_AVAILABLE` and `SHARED_POOL_RUNNING` pass.\n'
  printf -- '- Do not add `claude-agent-sdk-runtime-v2` back into `prd-agent` branch services.\n'
  printf -- '- Do not paste private key contents into chat or logs; use `CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE`.\n\n'

  printf '## Sidecar Image\n\n'
  printf 'CDS remote deployer uses `docker pull`; it does not build from this repository on the remote host.\n\n'
  printf 'Local sidecar build context preflight is `%s`; this only proves the repository can describe a candidate image, not that the remote host can pull it.\n\n' "$image_build_context_status"
  printf 'Local docker build smoke is `%s`; build smoke never pushes or deploys.\n\n' "$image_local_build"
  if [[ -n "$image_build_command" ]]; then
    printf 'Candidate local build command:\n\n'
    printf '```bash\n%s\n```\n\n' "$image_build_command"
  fi
  if [[ -n "$image_push_command" ]]; then
    printf 'Candidate push command after choosing a pullable registry/tag:\n\n'
    printf '```bash\n%s\n```\n\n' "$image_push_command"
  fi
  printf 'Set `CDS_AGENT_SIDECAR_IMAGE` only to an image reference the target remote host can pull.\n\n'

  printf '## Safe Commands\n\n'
  cat "$tmp_handoff"

  printf '\n## Local Preflight Commands\n\n'
  cat <<'EOF'
```bash
scripts/preflight-cds-agent-r0-apply-readiness.sh
scripts/smoke-cds-agent-sidecar-image-build.sh
scripts/print-cds-agent-current-progress.sh
```
EOF
} > "$OUTPUT"

rm -f "$tmp_handoff"

printf 'CDS Agent R0 operator handoff: %s\n' "$OUTPUT"
