#!/usr/bin/env bash
# Print the current CDS Agent goal board from local evidence files.
# This is read-only and never prints secret values.

set -euo pipefail

GOAL_AUDIT="${CDS_AGENT_GOAL_AUDIT_REPORT:-/tmp/cds-agent-goal-audit-r0-current.json}"
REMOTE_HOST_SUMMARY="${CDS_AGENT_REMOTE_HOST_SUMMARY:-/tmp/cds-agent-remote-host-pool-current-readonly-live/summary.json}"
HANDOFF_SUMMARY="${CDS_AGENT_REMOTE_HOST_HANDOFF_SUMMARY:-$REMOTE_HOST_SUMMARY}"
N6_SUMMARY="${CDS_AGENT_N6_SUMMARY:-/tmp/cds-agent-n6-non-code-compatibility-current.json}"
R0_READINESS_SUMMARY="${CDS_AGENT_R0_READINESS_SUMMARY:-/tmp/cds-agent-r0-apply-readiness-current.json}"
SIDECAR_IMAGE_BUILD_REPORT="${CDS_AGENT_SIDECAR_IMAGE_BUILD_REPORT:-/tmp/cds-agent-sidecar-image-build-current.json}"
SIDECAR_IMAGE_PUBLISH_REPORT="${CDS_AGENT_SIDECAR_IMAGE_PUBLISH_REPORT:-/tmp/cds-agent-sidecar-image-publish-current.json}"
REMOTE_PULL_REPORT="${CDS_AGENT_REMOTE_PULL_REPORT:-/tmp/cds-agent-remote-sidecar-pull-current.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "missing dependency: jq"
[[ -f "$GOAL_AUDIT" ]] || fail "goal audit not found: $GOAL_AUDIT"
[[ -f "$REMOTE_HOST_SUMMARY" ]] || fail "remote host summary not found: $REMOTE_HOST_SUMMARY"

if [[ -x "$SCRIPT_DIR/preflight-cds-agent-r0-apply-readiness.sh" ]]; then
  CDS_AGENT_R0_READINESS_REPORT="$R0_READINESS_SUMMARY" \
  CDS_AGENT_REMOTE_HOST_SUMMARY="$REMOTE_HOST_SUMMARY" \
    bash "$SCRIPT_DIR/preflight-cds-agent-r0-apply-readiness.sh" >/dev/null 2>&1 || true
fi

jq_read() {
  local file="$1"
  local expr="$2"
  jq -r "$expr" "$file"
}

status=$(jq_read "$GOAL_AUDIT" '.executionPanel.status // .status // "unknown"')
gate=$(jq_read "$GOAL_AUDIT" '.executionPanel.currentBlockingGate // .currentBlockingGate // "unknown"')
gate_status_expr='def gate_status($name):
  if (.gates[$name] | type) == "object" then .gates[$name].status
  elif (.gates[$name] // null) != null then .gates[$name]
  elif (.[$name] | type) == "object" then .[$name].status
  else .[$name] // "unknown"
  end;'
r0=$(jq_read "$GOAL_AUDIT" "$gate_status_expr gate_status(\"R0\")")
a0=$(jq_read "$GOAL_AUDIT" "$gate_status_expr gate_status(\"A0\")")
v1=$(jq_read "$GOAL_AUDIT" "$gate_status_expr gate_status(\"V1\")")
n6=$(jq_read "$GOAL_AUDIT" "$gate_status_expr gate_status(\"N6\")")
if [[ -f "$N6_SUMMARY" ]]; then
  n6_latest=$(jq_read "$N6_SUMMARY" '.status // empty')
  if [[ "$n6_latest" == "pass" ]]; then
    n6="pass"
  fi
fi

verdict=$(jq_read "$REMOTE_HOST_SUMMARY" '.verdict // .status // "unknown"')
enabled_hosts=$(jq_read "$REMOTE_HOST_SUMMARY" '(if has("prepare") and .prepare != null then .prepare.enabledHostCount else .beforeEnabledRemoteHostCount end) // "unknown"')
shared_running=$(jq_read "$REMOTE_HOST_SUMMARY" '.beforeSharedRunning // "unknown"')
ready_deploy=$(jq_read "$REMOTE_HOST_SUMMARY" '.readyForSharedRuntimeDeploy // false')
ready_smoke=$(jq_read "$REMOTE_HOST_SUMMARY" '.readyForProviderSmokes // false')
will_create_host=$(jq_read "$REMOTE_HOST_SUMMARY" '(if has("prepare") and .prepare != null then .prepare.willCreateHost else true end) // true')
target_host_id=$(jq_read "$REMOTE_HOST_SUMMARY" '(if has("prepare") and .prepare != null then .prepare.targetHostId else null end) // "none"')
missing_config=$(jq_read "$REMOTE_HOST_SUMMARY" '((if has("prepare") and .prepare != null then .prepare.missingConfig else [] end) // []) | join(", ")')
invalid_config=$(jq_read "$REMOTE_HOST_SUMMARY" '((if has("prepare") and .prepare != null then .prepare.invalidConfig else [] end) // []) | join(", ")')
total_seconds=$(jq_read "$REMOTE_HOST_SUMMARY" '.totalSeconds // "unknown"')
r0_readiness_line="not checked"
image_readiness="unknown"
image_next_action="unknown"
image_build_context="unknown"
image_local_build="not checked"
image_publish="not checked"
remote_pull="not checked"
if [[ -f "$R0_READINESS_SUMMARY" ]]; then
  r0_ready=$(jq_read "$R0_READINESS_SUMMARY" '.readyForR0Apply // false')
  r0_next_action=$(jq_read "$R0_READINESS_SUMMARY" '.nextAction // "unknown"')
  image_readiness=$(jq_read "$R0_READINESS_SUMMARY" '.imageReadiness.status // "unknown"')
  image_next_action=$(jq_read "$R0_READINESS_SUMMARY" '.imageReadiness.nextAction // "unknown"')
  image_build_context=$(jq_read "$R0_READINESS_SUMMARY" '.imageReadiness.buildContextStatus // "unknown"')
  r0_readiness_line="readyForR0Apply=$r0_ready; nextAction=$r0_next_action"
fi
if [[ -f "$SIDECAR_IMAGE_BUILD_REPORT" ]]; then
  image_local_build=$(jq_read "$SIDECAR_IMAGE_BUILD_REPORT" '.status // "unknown"')
fi
if [[ -f "$SIDECAR_IMAGE_PUBLISH_REPORT" ]]; then
  image_publish=$(jq_read "$SIDECAR_IMAGE_PUBLISH_REPORT" '.status // "unknown"')
fi
if [[ -f "$REMOTE_PULL_REPORT" ]]; then
  remote_pull=$(jq_read "$REMOTE_PULL_REPORT" '.status // "unknown"')
fi

if [[ -z "$missing_config" ]]; then
  missing_config="none"
fi
if [[ -z "$invalid_config" ]]; then
  invalid_config="none"
fi

exact_next_step=""
if [[ "$image_build_context" != "pass" ]]; then
  exact_next_step=$(cat <<'EOF'
Run the sidecar image context preflight:

```bash
scripts/preflight-cds-agent-sidecar-image.sh
```
EOF
)
elif [[ "$image_local_build" != "build_pass" ]]; then
  exact_next_step=$(cat <<'EOF'
Run the local sidecar image build smoke. This builds only; it does not push or deploy.

```bash
scripts/smoke-cds-agent-sidecar-image-build.sh
```
EOF
)
elif [[ "$image_publish" != "push_ready" && "$image_publish" != "push_pass" ]]; then
  exact_next_step=$(cat <<'EOF'
Choose a registry-qualified image tag and run publish dry-run. This does not push unless `CDS_AGENT_SIDECAR_IMAGE_PUSH=1` is set.

```bash
CDS_AGENT_SIDECAR_IMAGE=<registry>/<namespace>/claude-sidecar:<tag> scripts/publish-cds-agent-sidecar-image.sh
```
EOF
)
elif [[ "$image_publish" == "push_ready" ]]; then
  exact_next_step=$(cat <<'EOF'
Push the sidecar image only after choosing the approved registry tag. This is an explicit write action.

```bash
CDS_AGENT_SIDECAR_IMAGE=<registry>/<namespace>/claude-sidecar:<tag> CDS_AGENT_SIDECAR_IMAGE_PUSH=1 scripts/publish-cds-agent-sidecar-image.sh
```
EOF
)
elif [[ "$remote_pull" != "dry_run_ready" && "$remote_pull" != "pull_pass" ]]; then
  exact_next_step=$(cat <<'EOF'
Validate remote host pull prerequisites. This does not SSH unless `CDS_AGENT_REMOTE_PULL_VERIFY=1` is set.

```bash
CDS_AGENT_SIDECAR_IMAGE=<registry>/<namespace>/claude-sidecar:<tag> CDS_REMOTE_HOST_HOST=<host-or-ip-no-protocol> CDS_REMOTE_HOST_SSH_USER=<ssh-user> CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE=<private-key-file> scripts/verify-cds-agent-remote-sidecar-pull.sh
```
EOF
)
elif [[ "$remote_pull" == "dry_run_ready" ]]; then
  exact_next_step=$(cat <<'EOF'
Verify the target remote host can pull the sidecar image. This SSHs to the host and runs only `docker pull`.

```bash
CDS_AGENT_SIDECAR_IMAGE=<registry>/<namespace>/claude-sidecar:<tag> CDS_REMOTE_HOST_HOST=<host-or-ip-no-protocol> CDS_REMOTE_HOST_SSH_USER=<ssh-user> CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE=<private-key-file> CDS_AGENT_REMOTE_PULL_VERIFY=1 scripts/verify-cds-agent-remote-sidecar-pull.sh
```
EOF
)
elif [[ "$missing_config" != "none" || "$invalid_config" != "none" ]]; then
  exact_next_step=$(cat <<EOF
Generate the safe R0 remote-host handoff command:

\`\`\`bash
scripts/print-cds-agent-remote-host-handoff.sh \\
  $HANDOFF_SUMMARY
\`\`\`

Then fill only placeholders locally. Do not paste private key contents into chat or logs.
EOF
)
else
  exact_next_step=$(cat <<'EOF'
Run R0 remote host apply and shared runtime deploy with evidence, then run the shared-service pool post-check.

```bash
CDS_HOST=https://cds.miduo.org CDS_AGENT_REMOTE_HOST_APPLY=1 CDS_AGENT_REMOTE_HOST_DEPLOY_SIDECAR=1 CDS_AGENT_SIDECAR_IMAGE=<registry>/<namespace>/claude-sidecar:<tag> bash scripts/run-cds-agent-remote-host-pool-with-evidence.sh
```
EOF
)
fi

cat <<EOF
# CDS Agent Progress Board

Generated: $(date '+%Y-%m-%d %H:%M:%S %Z')
Branch: $(git -C "$ROOT_DIR" branch --show-current 2>/dev/null || printf 'unknown')
Goal: keep MAP/CDS as control plane; shrink custom agent loop into official SDK adapters.

## Current State

- Overall status: $status
- Current blocking gate: $gate
- Gate status: A0=$a0, R0=$r0, V1=$v1, N6=$n6
- R0 remote host verdict: $verdict
- Remote hosts enabled: $enabled_hosts
- Shared official SDK runtime running: $shared_running
- Ready for shared runtime deploy: $ready_deploy
- Ready for provider smokes: $ready_smoke
- Evidence refresh cost: ${total_seconds}s
- R0 local apply readiness: $r0_readiness_line
- Sidecar image readiness: $image_readiness; $image_next_action
- Sidecar build context: $image_build_context
- Sidecar local docker build: $image_local_build
- Sidecar registry publish: $image_publish
- Remote host docker pull: $remote_pull

## Task Board

| Step | State | Next action | ETA after prerequisites |
| --- | --- | --- | --- |
| A0 Official SDK adapter boundary | done | Keep legacy loop as explicit fallback only | done |
| R0.1 Branch-local sidecar cleanup | done | Keep branch services api/admin only | done |
| R0.2 Remote host carrier | blocked | Provide/apply remote host SSH config | 1-3 min |
| R0.3 Shared official SDK runtime | blocked | Deploy shared sidecar image on enabled host | 2-5 min |
| R0V Post-check | waiting | Run shared-service pool smoke after R0.2/R0.3 | 15-30 sec |
| R1 Profile repair | pending | Configure official Anthropic/Claude-compatible profile after R0 | 5-15 min |
| S1/S2/S3 One-cycle smokes | pending | Run read-only/approval/cancel cycles after R0/R1 | 10-25 min |
| V1 Visual verification | partial | Use runtime-status/execution panel screenshot after live runtime exists | 3-8 min |

## Current Blockers

- missingConfig: $missing_config
- invalidConfig: $invalid_config
- imageReadiness: $image_readiness
- imageBuildContext: $image_build_context
- imageLocalBuild: $image_local_build
- imagePublish: $image_publish
- remotePull: $remote_pull
- targetHostId: $target_host_id
- willCreateHost: $will_create_host

## Exact Next Step

$exact_next_step

## Do Not Spend Time On Now

- Do not repeat normal preview redeploys for this blocker.
- Do not run provider one-cycle before REMOTE_HOST_AVAILABLE and SHARED_POOL_RUNNING pass.
- Do not add claude-agent-sdk-runtime-v2 back into prd-agent branch services.
- Do not treat UI preview running as proof that shared-service runtime pool recovered.

## Evidence Files

- goal audit: $GOAL_AUDIT
- remote host summary: $REMOTE_HOST_SUMMARY
- handoff summary: $HANDOFF_SUMMARY
- N6 summary: $N6_SUMMARY
- R0 readiness summary: $R0_READINESS_SUMMARY
- sidecar image build summary: $SIDECAR_IMAGE_BUILD_REPORT
- sidecar image publish summary: $SIDECAR_IMAGE_PUBLISH_REPORT
- remote sidecar pull summary: $REMOTE_PULL_REPORT
EOF
