#!/usr/bin/env bash
# Print safe, copyable R0 remote host recovery commands from a dry-run summary.
# This script never prints private key contents. It uses placeholders for secrets.

set -euo pipefail

SUMMARY="${1:-${CDS_AGENT_REMOTE_HOST_HANDOFF_SUMMARY:-/tmp/cds-agent-remote-host-pool-current-readonly-live/summary.json}}"

fail() {
  printf '❌ %s\n' "$*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "缺少依赖: jq"
[[ -f "$SUMMARY" ]] || fail "summary 不存在: $SUMMARY"

verdict=$(jq -r '.verdict // .status // "unknown"' "$SUMMARY")
preflight_ready=$(jq -r '(if has("prepare") and .prepare != null then .prepare else . end).preflightReady // false' "$SUMMARY")
target_host_id=$(jq -r '(if has("prepare") and .prepare != null then .prepare else . end).targetHostId // ""' "$SUMMARY")
will_create_host=$(jq -r 'if ((if has("prepare") and .prepare != null then .prepare else . end) | has("willCreateHost")) then ((if has("prepare") and .prepare != null then .prepare else . end).willCreateHost | tostring) else "true" end' "$SUMMARY")
missing_config=$(jq -r '((if has("prepare") and .prepare != null then .prepare else . end).missingConfig // []) | join(",")' "$SUMMARY")
invalid_config=$(jq -r '((if has("prepare") and .prepare != null then .prepare else . end).invalidConfig // []) | join(",")' "$SUMMARY")
enabled_hosts=$(jq -r '(if has("prepare") and .prepare != null then .prepare else . end).enabledHostCount // .beforeEnabledRemoteHostCount // "unknown"' "$SUMMARY")
shared_running=$(jq -r '.beforeSharedRunning // "unknown"' "$SUMMARY")

printf '# CDS Agent R0 Remote Host Handoff\n\n'
printf '%s\n' "- summary: \`$SUMMARY\`"
printf '%s\n' "- verdict: \`$verdict\`"
printf '%s\n' "- preflightReady: \`$preflight_ready\`"
printf '%s\n' "- enabledHostCount: \`$enabled_hosts\`"
printf '%s\n' "- sharedRunning: \`$shared_running\`"
printf '%s\n' "- targetHostId: \`${target_host_id:-none}\`"
printf '%s\n' "- willCreateHost: \`$will_create_host\`"
printf '%s\n' "- missingConfig: \`${missing_config:-none}\`"
printf '%s\n\n' "- invalidConfig: \`${invalid_config:-none}\`"

if [[ -n "$invalid_config" ]]; then
  printf 'Fix invalid config before any apply:\n\n'
  jq -r '((if has("prepare") and .prepare != null then .prepare else . end).invalidConfig // [])[] | "- " + .' "$SUMMARY"
  exit 0
fi

if [[ "$will_create_host" == "true" ]]; then
  cat <<'EOF'
## Step 1: create enabled remote host

```bash
CDS_HOST=https://cds.miduo.org \
CDS_AGENT_REMOTE_HOST_APPLY=1 \
CDS_REMOTE_HOST_NAME=<name> \
CDS_REMOTE_HOST_HOST=<host-or-ip-no-protocol> \
CDS_REMOTE_HOST_SSH_USER=<ssh-user> \
CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE=<private-key-file> \
  bash scripts/run-cds-agent-remote-host-pool-with-evidence.sh
```

Expected after Step 1:

```text
verdict=applied-host-ready
readyForSharedRuntimeDeploy=true
```
EOF
else
  cat <<EOF
## Step 1: reuse existing enabled remote host

\`\`\`bash
CDS_HOST=https://cds.miduo.org \\
CDS_AGENT_REMOTE_HOST_APPLY=1 \\
CDS_REMOTE_HOST_ID=${target_host_id:-<existing-enabled-host-id>} \\
  bash scripts/run-cds-agent-remote-host-pool-with-evidence.sh
\`\`\`

Expected after Step 1:

\`\`\`text
verdict=applied-host-ready
readyForSharedRuntimeDeploy=true
\`\`\`
EOF
fi

cat <<'EOF'

## Step 2: deploy shared official SDK runtime

```bash
CDS_HOST=https://cds.miduo.org \
CDS_AGENT_REMOTE_HOST_APPLY=1 \
CDS_AGENT_REMOTE_HOST_DEPLOY_SIDECAR=1 \
CDS_AGENT_SIDECAR_IMAGE=<official-sdk-sidecar-image> \
CDS_AGENT_SIDECAR_PORT=7400 \
  bash scripts/run-cds-agent-remote-host-pool-with-evidence.sh
```

Expected after Step 2:

```text
verdict=applied-running
readyForProviderSmokes=true
```

## Step 3: post-check

```bash
CDS_HOST=https://cds.miduo.org \
SMOKE_CDS_AGENT_SHARED_POOL_REMOTE=1 \
  bash scripts/smoke-cds-agent-shared-service-pool.sh
```
EOF
