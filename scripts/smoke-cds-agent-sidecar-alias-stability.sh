#!/usr/bin/env bash
# ============================================
# 冒烟测试: CDS Agent sidecar alias stability
# ============================================
#
# Runs inside the remote API container through cdscli branch exec and curls the
# configured sidecar DNS alias repeatedly. This catches stale Docker/CDS aliases
# that can make MAP alternate between a new healthy sidecar and an old /readyz
# 503 instance.
#
# Required:
#   CDS_HOST
#
# Optional:
#   SMOKE_CDS_BRANCH_ID                  default: prd-agent-codex-cds-agent-workbench-ui
#   SMOKE_CDS_AGENT_API_PROFILE          default: api-prd-agent
#   SMOKE_CDS_AGENT_SIDECAR_ALIAS        default: claude-agent-sdk-runtime-v2-prd-agent
#   SMOKE_CDS_AGENT_SIDECAR_PORT         default: 7400
#   SMOKE_CDS_AGENT_ALIAS_ATTEMPTS       default: 6
#   SMOKE_CDS_AGENT_ALIAS_DIAGNOSE_IPS   default: 1
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_CDS_BRANCH_ID="${SMOKE_CDS_BRANCH_ID:-prd-agent-codex-cds-agent-workbench-ui}"
SMOKE_CDS_AGENT_API_PROFILE="${SMOKE_CDS_AGENT_API_PROFILE:-api-prd-agent}"
SMOKE_CDS_AGENT_SIDECAR_ALIAS="${SMOKE_CDS_AGENT_SIDECAR_ALIAS:-claude-agent-sdk-runtime-v2-prd-agent}"
SMOKE_CDS_AGENT_SIDECAR_PORT="${SMOKE_CDS_AGENT_SIDECAR_PORT:-7400}"
SMOKE_CDS_AGENT_ALIAS_ATTEMPTS="${SMOKE_CDS_AGENT_ALIAS_ATTEMPTS:-6}"
SMOKE_CDS_AGENT_ALIAS_DIAGNOSE_IPS="${SMOKE_CDS_AGENT_ALIAS_DIAGNOSE_IPS:-1}"
SMOKE_STEP_TOTAL=5

smoke_init "CDS Agent Sidecar Alias Stability"

if [[ -z "${CDS_HOST:-}" ]]; then
  smoke_fail "CDS_HOST is required so cdscli can exec inside the remote API container"
fi

smoke_step "确认 cdscli 可用"
if [[ ! -f ".claude/skills/cds/cli/cdscli.py" ]]; then
  smoke_fail ".claude/skills/cds/cli/cdscli.py not found"
fi
smoke_ok "cdscli found"

smoke_step "从 API 容器连续访问 sidecar alias"
remote_url="http://${SMOKE_CDS_AGENT_SIDECAR_ALIAS}:${SMOKE_CDS_AGENT_SIDECAR_PORT}/readyz"
remote_cmd="echo hosts; getent hosts ${SMOKE_CDS_AGENT_SIDECAR_ALIAS} || true; printf '\\n---cds-agent-alias-hosts---\\n'; "
for attempt in $(seq 1 "$SMOKE_CDS_AGENT_ALIAS_ATTEMPTS"); do
  remote_cmd="${remote_cmd}echo sample=${attempt}; curl -sS --max-time 10 ${remote_url} || true; printf '\\n---cds-agent-alias-sample---\\n'; sleep 1; "
done
exec_resp=$(CDS_HOST="$CDS_HOST" python3 .claude/skills/cds/cli/cdscli.py branch exec "$SMOKE_CDS_BRANCH_ID" --profile "$SMOKE_CDS_AGENT_API_PROFILE" "$remote_cmd")
smoke_verbose "$exec_resp"
smoke_assert_eq "$(printf '%s' "$exec_resp" | jq -r '.ok')" "true" "cdscli.branch.exec.ok"
smoke_assert_eq "$(printf '%s' "$exec_resp" | jq -r '.data.exitCode')" "0" "cdscli.branch.exec.exitCode"
stdout=$(printf '%s' "$exec_resp" | jq -r '.data.stdout // ""')
stderr=$(printf '%s' "$exec_resp" | jq -r '.data.stderr // ""')
smoke_assert_nonempty "$stdout" "cdscli.branch.exec.stdout"
printf '%s\n' "$stdout"
if [[ -n "$stderr" ]]; then
  smoke_fail "remote sidecar alias curl wrote stderr: $stderr"
fi

if [[ "$SMOKE_CDS_AGENT_ALIAS_DIAGNOSE_IPS" == "1" ]]; then
  ip_list=$(printf '%s\n' "$stdout" | awk -v alias="$SMOKE_CDS_AGENT_SIDECAR_ALIAS" '$2 == alias {print $1}' | sort -u)
  if [[ -n "$ip_list" ]]; then
    diag_cmd="echo ip-diagnostics; "
    while IFS= read -r ip; do
      [[ -z "$ip" ]] && continue
      diag_cmd="${diag_cmd}echo ip=${ip}; curl -sS --max-time 5 http://${ip}:${SMOKE_CDS_AGENT_SIDECAR_PORT}/readyz || true; printf '\\n---cds-agent-alias-ip---\\n'; "
    done <<< "$ip_list"
    diag_resp=$(CDS_HOST="$CDS_HOST" python3 .claude/skills/cds/cli/cdscli.py branch exec "$SMOKE_CDS_BRANCH_ID" --profile "$SMOKE_CDS_AGENT_API_PROFILE" "$diag_cmd")
    smoke_assert_eq "$(printf '%s' "$diag_resp" | jq -r '.ok')" "true" "cdscli.branch.exec.ipDiagnostics.ok"
    smoke_assert_eq "$(printf '%s' "$diag_resp" | jq -r '.data.exitCode')" "0" "cdscli.branch.exec.ipDiagnostics.exitCode"
    diag_stdout=$(printf '%s' "$diag_resp" | jq -r '.data.stdout // ""')
    diag_stderr=$(printf '%s' "$diag_resp" | jq -r '.data.stderr // ""')
    printf '%s\n' "$diag_stdout"
    if [[ -n "$diag_stderr" ]]; then
      smoke_fail "remote sidecar IP diagnostics wrote stderr: $diag_stderr"
    fi
  fi
fi

smoke_step "确认每次 /readyz 都是 official SDK adapter"
sample_count=$(printf '%s' "$stdout" | grep -c '^---cds-agent-alias-sample---$' || true)
host_count=$(printf '%s\n' "$stdout" | awk -v alias="$SMOKE_CDS_AGENT_SIDECAR_ALIAS" '$2 == alias {print $1}' | sort -u | wc -l | tr -d ' ')
ready_count=$(printf '%s' "$stdout" | grep -o '"ready":true,"anthropicKey"' | wc -l | tr -d ' ')
adapter_count=$(printf '%s' "$stdout" | grep -o '"agentAdapter":"claude-agent-sdk"' | wc -l | tr -d ' ')
loop_count=$(printf '%s' "$stdout" | grep -o '"loopOwner":"claude-agent-sdk"' | wc -l | tr -d ' ')
smoke_assert_eq "$sample_count" "$SMOKE_CDS_AGENT_ALIAS_ATTEMPTS" "readyz sample count"
smoke_assert_eq "$host_count" "1" "unique DNS host count"
smoke_assert_eq "$ready_count" "$SMOKE_CDS_AGENT_ALIAS_ATTEMPTS" "ready=true count"
smoke_assert_eq "$adapter_count" "$SMOKE_CDS_AGENT_ALIAS_ATTEMPTS" "agentAdapter=claude-agent-sdk count"
smoke_assert_eq "$loop_count" "$SMOKE_CDS_AGENT_ALIAS_ATTEMPTS" "loopOwner=claude-agent-sdk count"
smoke_ok "all ${SMOKE_CDS_AGENT_ALIAS_ATTEMPTS} attempts returned ready=true and loopOwner=claude-agent-sdk"

smoke_step "确认未知 runtimeAdapter 不会回退 legacy"
unsupported_cmd="curl -sS -N --max-time 20 -H 'Authorization: Bearer dev-skip' -H 'Content-Type: application/json' -d '{\"runId\":\"unsupported-adapter-smoke\",\"runtimeAdapter\":\"codex\",\"prompt\":\"should not run\"}' http://${SMOKE_CDS_AGENT_SIDECAR_ALIAS}:${SMOKE_CDS_AGENT_SIDECAR_PORT}/v1/agent/run | head -20"
unsupported_resp=$(CDS_HOST="$CDS_HOST" python3 .claude/skills/cds/cli/cdscli.py branch exec "$SMOKE_CDS_BRANCH_ID" --profile "$SMOKE_CDS_AGENT_API_PROFILE" "$unsupported_cmd")
smoke_verbose "$unsupported_resp"
smoke_assert_eq "$(printf '%s' "$unsupported_resp" | jq -r '.ok')" "true" "unsupportedAdapter.exec.ok"
smoke_assert_eq "$(printf '%s' "$unsupported_resp" | jq -r '.data.exitCode')" "0" "unsupportedAdapter.exec.exitCode"
unsupported_stdout=$(printf '%s' "$unsupported_resp" | jq -r '.data.stdout // ""')
unsupported_stderr=$(printf '%s' "$unsupported_resp" | jq -r '.data.stderr // ""')
smoke_assert_nonempty "$unsupported_stdout" "unsupportedAdapter.exec.stdout"
printf '%s\n' "$unsupported_stdout"
smoke_assert_contains "$unsupported_stdout" "unsupported_runtime_adapter" "unsupportedAdapter.errorCode"
if printf '%s' "$unsupported_stdout" | grep -Eq 'sidecar-legacy-loop|legacy sidecar loop started'; then
  smoke_fail "unsupported runtimeAdapter fell back to legacy loop"
fi
if [[ -n "$unsupported_stderr" ]]; then
  smoke_fail "unsupported adapter probe wrote stderr: $unsupported_stderr"
fi
smoke_ok "runtimeAdapter=codex returns unsupported_runtime_adapter instead of legacy fallback"

smoke_step "输出证据摘要"
jq -n \
  --arg branch "$SMOKE_CDS_BRANCH_ID" \
  --arg apiProfile "$SMOKE_CDS_AGENT_API_PROFILE" \
  --arg alias "$SMOKE_CDS_AGENT_SIDECAR_ALIAS" \
  --arg url "$remote_url" \
  --argjson attempts "$SMOKE_CDS_AGENT_ALIAS_ATTEMPTS" \
  '{
    branch: $branch,
    apiProfile: $apiProfile,
    sidecarAlias: $alias,
    readyzUrl: $url,
    attempts: $attempts,
    expected: {
      ready: true,
      agentAdapter: "claude-agent-sdk",
      loopOwner: "claude-agent-sdk"
    },
    unsupportedRuntimeAdapter: {
      adapter: "codex",
      expectedErrorCode: "unsupported_runtime_adapter",
      forbiddenLoopOwner: "sidecar-legacy-loop"
    }
  }'

smoke_done
