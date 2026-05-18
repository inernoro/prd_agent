#!/usr/bin/env bash
# Print the current CDS Agent goal board from local evidence files.
# This is read-only and never prints secret values.

set -euo pipefail

DEFAULT_GOAL_AUDIT="/tmp/cds-agent-goal-audit-r0-current.json"
if [[ -f "/tmp/cds-agent-goal-audit-current.json" ]]; then
  DEFAULT_GOAL_AUDIT="/tmp/cds-agent-goal-audit-current.json"
fi
GOAL_AUDIT="${CDS_AGENT_GOAL_AUDIT_REPORT:-$DEFAULT_GOAL_AUDIT}"
DEFAULT_REMOTE_HOST_SUMMARY="/tmp/cds-agent-remote-host-pool-current-readonly-live/summary.json"
if [[ -f "/tmp/cds-agent-runtime-pool-evidence-after-capacity-latest/summary.json" ]]; then
  DEFAULT_REMOTE_HOST_SUMMARY="/tmp/cds-agent-runtime-pool-evidence-after-capacity-latest/summary.json"
fi
REMOTE_HOST_SUMMARY="${CDS_AGENT_REMOTE_HOST_SUMMARY:-$DEFAULT_REMOTE_HOST_SUMMARY}"
HANDOFF_SUMMARY="${CDS_AGENT_REMOTE_HOST_HANDOFF_SUMMARY:-$REMOTE_HOST_SUMMARY}"
N6_SUMMARY="${CDS_AGENT_N6_SUMMARY:-/tmp/cds-agent-n6-non-code-compatibility-current.json}"
R0_READINESS_SUMMARY="${CDS_AGENT_R0_READINESS_SUMMARY:-/tmp/cds-agent-r0-apply-readiness-current.json}"
SIDECAR_IMAGE_BUILD_REPORT="${CDS_AGENT_SIDECAR_IMAGE_BUILD_REPORT:-/tmp/cds-agent-sidecar-image-build-current.json}"
SIDECAR_IMAGE_PUBLISH_REPORT="${CDS_AGENT_SIDECAR_IMAGE_PUBLISH_REPORT:-/tmp/cds-agent-sidecar-image-publish-current.json}"
SIDECAR_REGISTRY_VERIFY_REPORT="${CDS_AGENT_SIDECAR_REGISTRY_VERIFY_REPORT:-/tmp/cds-agent-sidecar-registry-image-current.json}"
REMOTE_PULL_REPORT="${CDS_AGENT_REMOTE_PULL_REPORT:-/tmp/cds-agent-remote-sidecar-pull-current.json}"
SIDECAR_PUBLISH_HANDOFF="${CDS_AGENT_SIDECAR_PUBLISH_HANDOFF:-/tmp/cds-agent-sidecar-publish-handoff-current.md}"
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
runtime_capacity_status=$(jq_read "$REMOTE_HOST_SUMMARY" '(.remoteHost.runtimeCapacityStatus // ([.runtimeCapacity.entries[]? | select(.step == "capacity-after") | .payload.status] | last) // "unknown")')
runtime_capacity_running=$(jq_read "$REMOTE_HOST_SUMMARY" '(.remoteHost.runtimeCapacityRunning // ([.runtimeCapacity.entries[]? | select(.step == "capacity-after") | .payload.runningOfficialSdkRuntimeCount] | last) // 0)')
runtime_capacity_available=false
if [[ "$runtime_capacity_status" == "available" ]] || [[ "$runtime_capacity_running" =~ ^[0-9]+$ && "$runtime_capacity_running" -gt 0 ]]; then
  runtime_capacity_available=true
  status="blocked_r1"
  gate="R1"
  r0="pass"
  shared_running="$runtime_capacity_running"
  ready_deploy=true
  ready_smoke=true
  verdict="cds-managed-runtime-capacity-available"
fi
r0_readiness_line="not checked"
image_readiness="unknown"
image_next_action="unknown"
image_build_context="unknown"
image_local_build="not checked"
image_publish="not checked"
image_publish_candidate="ghcr.io/inernoro/prd-agent/claude-sidecar:$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD 2>/dev/null || printf local)"
image_publish_tag="not checked"
image_push_attempted="false"
image_registry_visible="not checked"
remote_pull="not checked"
if [[ -f "$R0_READINESS_SUMMARY" ]]; then
  r0_ready=$(jq_read "$R0_READINESS_SUMMARY" '.readyForR0Apply // false')
  r0_next_action=$(jq_read "$R0_READINESS_SUMMARY" '.nextAction // "unknown"')
  image_readiness=$(jq_read "$R0_READINESS_SUMMARY" '.imageReadiness.status // "unknown"')
  image_next_action=$(jq_read "$R0_READINESS_SUMMARY" '.imageReadiness.nextAction // "unknown"')
  image_build_context=$(jq_read "$R0_READINESS_SUMMARY" '.imageReadiness.buildContextStatus // "unknown"')
  r0_readiness_line="readyForR0Apply=$r0_ready; nextAction=$r0_next_action"
fi
if [[ "$runtime_capacity_available" == "true" ]]; then
  r0_readiness_line="readyForR0Apply=passed_by_runtime_capacity; nextAction=continue R1 profile repair and provider smokes"
fi
if [[ -f "$SIDECAR_IMAGE_BUILD_REPORT" ]]; then
  image_local_build=$(jq_read "$SIDECAR_IMAGE_BUILD_REPORT" '.status // "unknown"')
fi
if [[ -f "$SIDECAR_IMAGE_PUBLISH_REPORT" ]]; then
  image_publish=$(jq_read "$SIDECAR_IMAGE_PUBLISH_REPORT" '.status // "unknown"')
  image_publish_tag=$(jq_read "$SIDECAR_IMAGE_PUBLISH_REPORT" '.tagPassed // false')
  image_push_attempted=$(jq_read "$SIDECAR_IMAGE_PUBLISH_REPORT" '.pushAttempted // false')
  image_publish_candidate=$(jq_read "$SIDECAR_IMAGE_PUBLISH_REPORT" '.candidateTargetImage // empty')
  [[ -n "$image_publish_candidate" ]] || image_publish_candidate="ghcr.io/inernoro/prd-agent/claude-sidecar:$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD 2>/dev/null || printf local)"
fi
if [[ -f "$SIDECAR_REGISTRY_VERIFY_REPORT" ]]; then
  image_registry_visible=$(jq_read "$SIDECAR_REGISTRY_VERIFY_REPORT" '.status // "unknown"')
fi
if [[ -f "$REMOTE_PULL_REPORT" ]]; then
  remote_pull=$(jq_read "$REMOTE_PULL_REPORT" '.status // "unknown"')
fi

if [[ "$runtime_capacity_available" == "true" ]]; then
  image_readiness="operator-fallback-only"
  image_next_action="not product path"
  image_registry_visible="operator-fallback-only"
  remote_pull="operator-fallback-only"
fi

if [[ -z "$missing_config" ]]; then
  missing_config="none"
fi
if [[ -z "$invalid_config" ]]; then
  invalid_config="none"
fi

exact_next_step=""
if [[ "$runtime_capacity_available" == "true" ]]; then
  exact_next_step=$(cat <<'EOF'
R0 CDS-managed runtime capacity is available. Continue R1 profile repair and provider smokes; do not spend time on remote host/image fallback for the product path.

```bash
CDS_HOST=https://cds.miduo.org SMOKE_CDS_AGENT_ANTHROPIC_API_KEY=<sk-ant-...> SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-one-cycle.sh
```
EOF
)
elif [[ "$image_build_context" != "pass" ]]; then
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
elif [[ "$missing_config" != "none" || "$image_readiness" == "missing" ]]; then
  exact_next_step=$(cat <<'EOF'
Continue R0.7 CDS-managed runtime live evidence work. R0.7 now has the local liveApply container path; next is running it against the real CDS shared-service runtime and proving sharedRunning > 0. `CDS_REMOTE_HOST_*`, SSH keys, and `CDS_AGENT_SIDECAR_IMAGE` are operator/debug fallback details, not the product path.

```bash
sed -n '70,120p' doc/design.cds-agent-managed-runtime-fact-source.md
npm --prefix cds test -- --run tests/routes/remote-hosts-instances.test.ts
scripts/smoke-cds-agent-map-session-transport.sh
scripts/smoke-cds-agent-shared-service-pool.sh
scripts/check-cds-agent-progress-consistency.sh
```
EOF
)
elif [[ "$image_publish" != "push_ready" && "$image_publish" != "push_pass" ]]; then
  exact_next_step=$(printf '%s\n\n```bash\n%s\n```' \
    'Choose a registry-qualified image tag and run publish dry-run. This does not push unless `CDS_AGENT_SIDECAR_IMAGE_PUSH=1` is set.' \
    "CDS_AGENT_SIDECAR_IMAGE=$image_publish_candidate scripts/publish-cds-agent-sidecar-image.sh")
elif [[ "$image_publish" == "push_ready" && "$image_registry_visible" != "manifest_visible" ]]; then
  exact_next_step=$(printf '%s\n\n```bash\n%s\n```' \
    'Use the manual GitHub Actions publish handoff. This keeps the external registry write auditable and does not push from Codex.' \
    'scripts/print-cds-agent-sidecar-publish-handoff.sh')
elif [[ "$image_registry_visible" != "manifest_visible" ]]; then
  exact_next_step=$(cat <<'EOF'
Verify the sidecar image is visible in the registry before SSHing to a remote host.

```bash
CDS_AGENT_SIDECAR_IMAGE=<registry>/<namespace>/claude-sidecar:<tag> CDS_AGENT_SIDECAR_REGISTRY_VERIFY=1 scripts/verify-cds-agent-sidecar-registry-image.sh
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
- R0 managed runtime capacity: status=$runtime_capacity_status; sharedRunning=$shared_running; readyForProviderSmokes=$ready_smoke
- Operator fallback remote host verdict: $verdict
- Operator fallback remote hosts enabled: $enabled_hosts
- Operator fallback ready for shared runtime deploy: $ready_deploy
- Ready for provider smokes: $ready_smoke
- Evidence refresh cost: ${total_seconds}s
- R0 local apply readiness: $r0_readiness_line
- Legacy fallback sidecar image readiness: $image_readiness; $image_next_action
- Sidecar build context: $image_build_context
- Sidecar local docker build: $image_local_build
- Sidecar registry publish: $image_publish
- Sidecar local registry tag: $image_publish_tag
- Sidecar push attempted: $image_push_attempted
- Sidecar registry manifest: $image_registry_visible
- Remote host docker pull: $remote_pull

## Task Board

| Step | State | Next action | ETA after prerequisites |
| --- | --- | --- | --- |
| A0 Official SDK adapter boundary | done | Keep legacy loop as explicit fallback only | done |
| R0.1 Branch-local sidecar cleanup | done | Keep branch services api/admin only | done |
| D1 Runtime architecture correction | done | Keep CDS-managed runtime/container/sandbox as product path | done |
| R0.2 CDS-managed runtime fact source | done | Session ownership guard is in place; non-fake messages no longer delegate to MAP sidecar bridge | done |
| R0.2F Operator fallback host path | fallback | Keep SSH/env/image only as CDS operator fallback | later |
| R0.3 CDS-managed official SDK runtime | done_minimal | CDS agent sessions can dispatch to CDS-managed branch-service official SDK transport | done |
| R0.4 MAP session transport smoke | done | MAP uses CDS session/discovery/cancel/log APIs; direct runtime queue is explicit fallback only | done |
| R0V Post-check | $([[ "$runtime_capacity_available" == "true" ]] && printf 'done' || printf 'done_blocked') | $([[ "$runtime_capacity_available" == "true" ]] && printf 'Live evidence complete; CDS-managed runtime capacity is available' || printf 'Live evidence complete; shared runtime running=0 and enabled fallback hosts=0') | done |
| R0.5 CDS-managed runtime capacity contract | done_minimal | CDS exposes /api/projects/:id/runtime-capacity and separates product runtime from operator fallback | done |
| R0.6 CDS-managed runtime capacity reconciler | done_minimal | CDS exposes dry-run/apply reconciler and route tests prove product runtime capacity path | done |
| R0.7 CDS-managed runtime live apply | $([[ "$runtime_capacity_available" == "true" ]] && printf 'done_live' || printf 'in_progress') | $([[ "$runtime_capacity_available" == "true" ]] && printf 'Live evidence shows running official SDK runtime count >0' || printf 'Local liveApply path is wired; run live evidence so sharedRunning becomes >0') | $([[ "$runtime_capacity_available" == "true" ]] && printf 'done' || printf 'next') |
| R1 Profile repair | $([[ "$runtime_capacity_available" == "true" ]] && printf 'current_blocker' || printf 'pending') | Configure official Anthropic/Claude-compatible profile after R0 | 5-15 min |
| S1/S2/S3 One-cycle smokes | pending | Run read-only/approval/cancel cycles after R1 provider profile is available | 10-25 min |
| V1 Visual verification | $([[ "$runtime_capacity_available" == "true" ]] && printf 'pass_dry_run' || printf 'partial') | Re-capture provider-backed runtime page after S1/S2/S3 | 3-8 min |

## Legacy Fallback Blockers

- fallbackMissingConfig: $missing_config
- invalidConfig: $invalid_config
- fallbackImageReadiness: $image_readiness
- imageBuildContext: $image_build_context
- imageLocalBuild: $image_local_build
- imagePublish: $image_publish
- imagePublishTag: $image_publish_tag
- imagePushAttempted: $image_push_attempted
- imageRegistryManifest: $image_registry_visible
- remotePull: $remote_pull
- targetHostId: $target_host_id
- willCreateHost: $will_create_host

## Exact Next Step

$exact_next_step

## Do Not Spend Time On Now

- Do not repeat normal preview redeploys for this blocker.
- Do not run provider one-cycle before R1 has a real Anthropic/Claude-compatible keyed profile.
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
- sidecar registry manifest summary: $SIDECAR_REGISTRY_VERIFY_REPORT
- remote sidecar pull summary: $REMOTE_PULL_REPORT
- sidecar publish handoff: $SIDECAR_PUBLISH_HANDOFF
EOF
