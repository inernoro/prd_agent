#!/usr/bin/env bash
# ============================================
# 诊断: CDS Agent runtime pool / official SDK readiness
# ============================================
#
# 与 smoke-cds-agent-runtime-status.sh 不同，doctor 不把 instanceCount=0
# 当成脚本自身失败。它用于把 runtime-status 的 blocker/nextActions
# 分层输出，方便定位是 MAP 配置、CDS discovery、sidecar readyz、
# provider key 还是 adapter loop ownership 问题。
#
# 环境变量同 smoke-lib.sh:
#   SMOKE_TEST_HOST  目标服务根 URL
#   AI_ACCESS_KEY    prd-api X-AI-Access-Key
#   SMOKE_USER       impersonate 用户，默认 admin
#   SMOKE_VERBOSE=1  额外输出完整 runtime-status JSON
#   CDS_HOST         可选；设置后会从远程 API 容器内检查 sidecar DNS alias
#   SMOKE_CDS_AGENT_DOCTOR_REPORT 可选；写出机器可读 JSON 诊断包
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_CDS_BRANCH_ID="${SMOKE_CDS_BRANCH_ID:-prd-agent-codex-cds-agent-workbench-ui}"
SMOKE_CDS_AGENT_API_PROFILE="${SMOKE_CDS_AGENT_API_PROFILE:-api-prd-agent}"
SMOKE_CDS_AGENT_SIDECAR_ALIAS="${SMOKE_CDS_AGENT_SIDECAR_ALIAS:-claude-agent-sdk-runtime-v2-prd-agent}"
SMOKE_CDS_AGENT_SIDECAR_PORT="${SMOKE_CDS_AGENT_SIDECAR_PORT:-7400}"
SMOKE_CDS_AGENT_ALIAS_ATTEMPTS="${SMOKE_CDS_AGENT_ALIAS_ATTEMPTS:-3}"
SMOKE_CDS_AGENT_DOCTOR_RETRIES="${SMOKE_CDS_AGENT_DOCTOR_RETRIES:-5}"
SMOKE_CDS_AGENT_DOCTOR_RETRY_SECONDS="${SMOKE_CDS_AGENT_DOCTOR_RETRY_SECONDS:-3}"
SMOKE_CDS_AGENT_DOCTOR_REPORT="${SMOKE_CDS_AGENT_DOCTOR_REPORT:-}"
alias_check_status="skipped"
alias_unique_hosts=0
alias_ready_count=0
alias_loop_count=0
alias_lazy_legacy_count=0
alias_warning=""
diagnosis=""
next_recommended=""
SMOKE_STEP_TOTAL=9
smoke_init "CDS Agent Runtime Doctor"

smoke_step "读取 runtime-status"
resp=""
last_error=""
for attempt in $(seq 1 "$SMOKE_CDS_AGENT_DOCTOR_RETRIES"); do
  if resp=$(smoke_get "/api/infra-agent-sessions/runtime-status?refreshDiscovery=true" 2>&1); then
    break
  fi
  last_error="$resp"
  if (( attempt < SMOKE_CDS_AGENT_DOCTOR_RETRIES )); then
    printf 'runtime-status unavailable (attempt %s/%s): %s; retrying in %ss...\n' \
      "$attempt" "$SMOKE_CDS_AGENT_DOCTOR_RETRIES" "$last_error" "$SMOKE_CDS_AGENT_DOCTOR_RETRY_SECONDS"
    sleep "$SMOKE_CDS_AGENT_DOCTOR_RETRY_SECONDS"
  fi
done
if [[ -z "$resp" || "$resp" != \{* ]]; then
  smoke_fail "runtime-status 不可用: ${last_error:-empty response}"
fi
smoke_verbose "$resp"
success=$(printf '%s' "$resp" | jq -r '.success')
smoke_assert_eq "$success" "true" "ApiResponse.success"
smoke_ok "runtime-status API 可访问"

smoke_step "汇总运行时边界"
summary=$(printf '%s' "$resp" | jq -r '
  .data.diagnostics as $d |
  [
    "desiredRuntimeAdapter=\($d.desiredRuntimeAdapter // "unknown")",
    "runtimeTransport=\($d.runtimeTransport // "unknown")",
    "instanceCount=\($d.instanceCount // 0)",
    "healthyCount=\($d.healthyCount // 0)"
  ] | join(" ")
')
printf '%s\n' "$summary"
desired_adapter=$(smoke_get_data "$resp" '.diagnostics.desiredRuntimeAdapter // ""')
runtime_instance_count=$(smoke_get_data "$resp" '.diagnostics.instanceCount // 0')
runtime_healthy_count=$(smoke_get_data "$resp" '.diagnostics.healthyCount // 0')

smoke_step "输出 blocker 和 runtime-status 下一步"
blocker_count=$(smoke_get_data "$resp" '.diagnostics.blockers // [] | length')
next_count=$(smoke_get_data "$resp" '.diagnostics.nextActions // [] | length')
if (( blocker_count <= 0 )); then
  smoke_ok "未发现 runtime blocker"
else
  printf 'Blockers:\n'
  printf '%s' "$resp" | jq -r '.data.diagnostics.blockers[]? | "  - " + .'
fi

if (( next_count > 0 )); then
  printf 'Next actions:\n'
  printf '%s' "$resp" | jq -r '.data.diagnostics.nextActions[]? | "  - " + .'
fi

smoke_step "输出实例 readyz 摘要"
instance_count=$(smoke_get_data "$resp" '.diagnostics.instanceCount // 0')
if (( instance_count <= 0 )); then
  printf 'Instances: none\n'
else
  printf '%s' "$resp" | jq -r '
    .data.diagnostics.instances[]? |
    [
      "  - name=\(.name // "unknown")",
      "source=\(.source // "unknown")",
      "ready=\(.ready // false)",
      "http=\(.httpStatus // "n/a")",
      "agentAdapter=\(.agentAdapter // "unknown")",
      "loopOwner=\(.loopOwner // "unknown")",
      "sdkLoopEnabled=\(.sdkLoopEnabled // false)"
    ] | join(" ")
  '
  printf '%s' "$resp" | jq -r '
    .data.diagnostics.instances[]? |
    select((.readyzBlockers // []) | length > 0) |
    "    readyzBlockers(" + (.name // "unknown") + "): " + ((.readyzBlockers // []) | join(" | "))
  '
  printf '%s' "$resp" | jq -r '
    .data.diagnostics.instances[]? |
    select((.readyzNextActions // []) | length > 0) |
    "    readyzNextActions(" + (.name // "unknown") + "): " + ((.readyzNextActions // []) | join(" | "))
  '
fi

smoke_step "检查 API 容器内 sidecar DNS alias"
if [[ -z "${CDS_HOST:-}" ]]; then
  printf 'Skipped: set CDS_HOST to exec inside the remote CDS API container\n'
  alias_check_status="skipped"
  alias_warning="set CDS_HOST to exec inside the remote CDS API container"
else
  remote_url="http://${SMOKE_CDS_AGENT_SIDECAR_ALIAS}:${SMOKE_CDS_AGENT_SIDECAR_PORT}/readyz"
  remote_cmd="echo hosts; getent hosts ${SMOKE_CDS_AGENT_SIDECAR_ALIAS} || true; "
  for attempt in $(seq 1 "$SMOKE_CDS_AGENT_ALIAS_ATTEMPTS"); do
    remote_cmd="${remote_cmd}echo sample=${attempt}; curl -sS --max-time 10 ${remote_url} || true; printf '\\n---cds-agent-doctor-alias-sample---\\n'; sleep 1; "
  done
  exec_resp=$(CDS_HOST="$CDS_HOST" python3 .claude/skills/cds/cli/cdscli.py branch exec "$SMOKE_CDS_BRANCH_ID" --profile "$SMOKE_CDS_AGENT_API_PROFILE" "$remote_cmd")
  smoke_verbose "$exec_resp"
  if [[ "$(printf '%s' "$exec_resp" | jq -r '.ok')" != "true" ]]; then
    printf 'Alias check failed: cdscli branch exec did not return ok=true\n'
    alias_check_status="failed"
    alias_warning="cdscli branch exec did not return ok=true"
  else
    alias_check_status="checked"
    alias_stdout=$(printf '%s' "$exec_resp" | jq -r '.data.stdout // ""')
    alias_stderr=$(printf '%s' "$exec_resp" | jq -r '.data.stderr // ""')
    printf '%s\n' "$alias_stdout"
    if [[ -n "$alias_stderr" ]]; then
      printf 'Alias check stderr: %s\n' "$alias_stderr"
    fi
    host_count=$(printf '%s\n' "$alias_stdout" | awk -v alias="$SMOKE_CDS_AGENT_SIDECAR_ALIAS" '$2 == alias {print $1}' | sort -u | wc -l | tr -d ' ')
    ready_count=$(printf '%s' "$alias_stdout" | grep -o '"ready":true,"anthropicKey"' | wc -l | tr -d ' ')
    loop_count=$(printf '%s' "$alias_stdout" | grep -o '"loopOwner":"claude-agent-sdk"' | wc -l | tr -d ' ')
    lazy_legacy_count=$(printf '%s' "$alias_stdout" | grep -o '"legacyLoopImport":"lazy-explicit-fallback"' | wc -l | tr -d ' ')
    alias_unique_hosts="$host_count"
    alias_ready_count="$ready_count"
    alias_loop_count="$loop_count"
    alias_lazy_legacy_count="$lazy_legacy_count"
    printf 'Alias summary: alias=%s uniqueHosts=%s readySamples=%s/%s officialLoopSamples=%s/%s lazyLegacyFallbackSamples=%s/%s\n' \
      "$SMOKE_CDS_AGENT_SIDECAR_ALIAS" \
      "$host_count" \
      "$ready_count" \
      "$SMOKE_CDS_AGENT_ALIAS_ATTEMPTS" \
      "$loop_count" \
      "$SMOKE_CDS_AGENT_ALIAS_ATTEMPTS" \
      "$lazy_legacy_count" \
      "$SMOKE_CDS_AGENT_ALIAS_ATTEMPTS"
    if (( host_count > 1 )); then
      printf 'Alias warning: DNS alias resolves to multiple IPs; stale Docker endpoint may still be attached.\n'
      alias_warning="DNS alias resolves to multiple IPs; stale Docker endpoint may still be attached."
    fi
    if (( ready_count < SMOKE_CDS_AGENT_ALIAS_ATTEMPTS || loop_count < SMOKE_CDS_AGENT_ALIAS_ATTEMPTS || lazy_legacy_count < SMOKE_CDS_AGENT_ALIAS_ATTEMPTS )); then
      printf 'Alias warning: not every /readyz sample proved ready=true, loopOwner=claude-agent-sdk, and legacyLoopImport=lazy-explicit-fallback.\n'
      if [[ -n "$alias_warning" ]]; then
        alias_warning="$alias_warning Not every /readyz sample proved ready=true, loopOwner=claude-agent-sdk, and legacyLoopImport=lazy-explicit-fallback."
      else
        alias_warning="Not every /readyz sample proved ready=true, loopOwner=claude-agent-sdk, and legacyLoopImport=lazy-explicit-fallback."
      fi
    elif (( host_count <= 1 )); then
      alias_check_status="stable"
      smoke_ok "sidecar alias stable from API container"
    fi
  fi
fi

smoke_step "检查默认 runtime profile 兼容性"
default_profile=$(printf '%s' "$resp" | jq -c '.data.diagnostics.defaultRuntimeProfile // empty')
if [[ -z "$default_profile" || "$default_profile" == "null" ]]; then
  profiles_resp=$(smoke_get "/api/infra-agent-runtime-profiles")
  smoke_verbose "$profiles_resp"
  profiles_success=$(printf '%s' "$profiles_resp" | jq -r '.success')
  smoke_assert_eq "$profiles_success" "true" "RuntimeProfiles.success"
  default_profile=$(printf '%s' "$profiles_resp" | jq -c '.data.items[]? | select(.isDefault == true) | . ' | head -n 1)
fi
if [[ -z "$default_profile" || "$default_profile" == "null" ]]; then
  printf 'Runtime profile: no default profile configured\n'
  profile_compatible="false"
  profile_has_key="false"
else
  profile_name=$(printf '%s' "$default_profile" | jq -r '.name // "unknown"')
  profile_runtime=$(printf '%s' "$default_profile" | jq -r '.runtime // "unknown"')
  profile_protocol=$(printf '%s' "$default_profile" | jq -r '.protocol // "unknown"')
  profile_model=$(printf '%s' "$default_profile" | jq -r '.model // "unknown"')
  profile_has_key=$(printf '%s' "$default_profile" | jq -r '.hasApiKey // false')
  profile_compatible=$(printf '%s' "$default_profile" | jq -r 'if has("compatibleWithDesiredRuntimeAdapter") then .compatibleWithDesiredRuntimeAdapter else true end')
  profile_reason_code=$(printf '%s' "$default_profile" | jq -r '.compatibilityReasonCode // ""')
  profile_reason=$(printf '%s' "$default_profile" | jq -r '.compatibilityReason // ""')
  profile_warning=$(printf '%s' "$default_profile" | jq -r '.warning // ""')
  printf 'Default profile: name=%s runtime=%s protocol=%s model=%s hasApiKey=%s compatibleWithDesiredRuntimeAdapter=%s\n' \
    "$profile_name" "$profile_runtime" "$profile_protocol" "$profile_model" "$profile_has_key" "$profile_compatible"
  if [[ -n "$profile_reason_code" ]]; then
    printf 'Profile compatibility reason: code=%s message=%s\n' "$profile_reason_code" "$profile_reason"
  fi
  if [[ -n "$profile_warning" ]]; then
    printf 'Profile warning: %s\n' "$profile_warning"
  elif [[ "$desired_adapter" == "claude-agent-sdk" && "$profile_model" != *claude* && "$profile_model" != anthropic/* ]]; then
    printf 'Profile warning: claude-agent-sdk 通常需要 Claude/Anthropic 兼容模型；当前默认模型可能只适合普通 OpenAI-compatible gateway。\n'
  fi
fi

smoke_step "读取官方 profile 模板"
templates_resp=$(smoke_get /api/infra-agent-runtime-profiles/templates)
smoke_verbose "$templates_resp"
smoke_assert_eq "$(printf '%s' "$templates_resp" | jq -r '.success')" "true" "RuntimeProfileTemplates.success"
anthropic_template=$(printf '%s' "$templates_resp" | jq -c '.data.items[]? | select(.id == "anthropic-official-claude-sonnet-4")')
if [[ -z "$anthropic_template" || "$anthropic_template" == "null" ]]; then
  printf 'Anthropic official template: missing\n'
else
  template_id=$(printf '%s' "$anthropic_template" | jq -r '.id')
  template_name=$(printf '%s' "$anthropic_template" | jq -r '.name')
  template_model=$(printf '%s' "$anthropic_template" | jq -r '.model')
  template_base_url=$(printf '%s' "$anthropic_template" | jq -r '.baseUrl')
  template_protocol=$(printf '%s' "$anthropic_template" | jq -r '.protocol')
  template_adapters=$(printf '%s' "$anthropic_template" | jq -r '.compatibleRuntimeAdapters // [] | join(",")')
  printf 'Anthropic official template: id=%s name=%s protocol=%s model=%s baseUrl=%s compatibleAdapters=%s\n' \
    "$template_id" "$template_name" "$template_protocol" "$template_model" "$template_base_url" "$template_adapters"
fi

smoke_step "读取 adapter 兼容矩阵"
compat_resp=$(smoke_get /api/infra-agent-runtime-profiles/adapter-compatibility)
smoke_verbose "$compat_resp"
smoke_assert_eq "$(printf '%s' "$compat_resp" | jq -r '.success')" "true" "AdapterCompatibility.success"
official_adapter=$(printf '%s' "$compat_resp" | jq -c '.data.items[]? | select(.id == "claude-agent-sdk")')
legacy_adapter=$(printf '%s' "$compat_resp" | jq -c '.data.items[]? | select(.id == "legacy-sidecar")')
codex_adapter=$(printf '%s' "$compat_resp" | jq -c '.data.items[]? | select(.id == "codex")')
if [[ -n "$official_adapter" && "$official_adapter" != "null" ]]; then
  printf 'Adapter claude-agent-sdk: status=%s loopOwner=%s mapRole=%s supportedProtocols=%s incompatiblePatterns=%s\n' \
    "$(printf '%s' "$official_adapter" | jq -r '.status // "unknown"')" \
    "$(printf '%s' "$official_adapter" | jq -r '.loopOwner // "unknown"')" \
    "$(printf '%s' "$official_adapter" | jq -r '.mapRole // "unknown"')" \
    "$(printf '%s' "$official_adapter" | jq -r '.supportedProtocols // [] | join(",")')" \
    "$(printf '%s' "$official_adapter" | jq -r '.knownIncompatibleProfilePatterns // [] | join(",")')"
fi
if [[ -n "$legacy_adapter" && "$legacy_adapter" != "null" ]]; then
  printf 'Adapter legacy-sidecar: status=%s loopOwner=%s mapRole=%s\n' \
    "$(printf '%s' "$legacy_adapter" | jq -r '.status // "unknown"')" \
    "$(printf '%s' "$legacy_adapter" | jq -r '.loopOwner // "unknown"')" \
    "$(printf '%s' "$legacy_adapter" | jq -r '.mapRole // "unknown"')"
fi
if [[ -n "$codex_adapter" && "$codex_adapter" != "null" ]]; then
  printf 'Adapter codex: status=%s loopOwner=%s mapRole=%s\n' \
    "$(printf '%s' "$codex_adapter" | jq -r '.status // "unknown"')" \
    "$(printf '%s' "$codex_adapter" | jq -r '.loopOwner // "unknown"')" \
    "$(printf '%s' "$codex_adapter" | jq -r '.mapRole // "unknown"')"
fi

smoke_step "生成最小验收命令"
printf 'Recommended gates:\n'
printf '  - bash scripts/smoke-cds-agent-runtime-status.sh\n'
printf '  - bash scripts/smoke-cds-agent-profile-templates.sh\n'
printf '  - bash scripts/smoke-cds-agent-profile-preflight.sh\n'
printf '  - bash scripts/smoke-all.sh\n'

if [[ "$desired_adapter" != "claude-agent-sdk" ]]; then
  printf 'Next: 先把 MAP 期望 adapter 切到 claude-agent-sdk，再重跑 runtime-status。\n'
  next_recommended="先把 MAP 期望 adapter 切到 claude-agent-sdk，再重跑 runtime-status。"
elif (( runtime_instance_count <= 0 || runtime_healthy_count <= 0 )); then
  printf 'Next: 先修 CDS sidecar discovery / static sidecar / readyz，再重跑 runtime-status。\n'
  next_recommended="先修 CDS sidecar discovery / static sidecar / readyz，再重跑 runtime-status。"
elif [[ "$profile_compatible" != "true" || "$profile_has_key" != "true" ]]; then
  printf 'Next: 在 /cds-agent 用 Anthropic official template 创建默认 profile，并填入真实 API key。\n'
  next_recommended="在 /cds-agent 用 Anthropic official template 创建默认 profile，并填入真实 API key。"
  if [[ -n "${template_id:-}" ]]; then
    printf '      Template API: POST /api/infra-agent-runtime-profiles/templates/%s/profiles\n' "$template_id"
  fi
  printf '      配好后运行: SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE=1 bash scripts/smoke-cds-agent-official-sdk-run.sh\n'
else
  printf 'Next: 默认 profile 已兼容；先跑 readiness，再显式打开 provider 调用做 S1/S2/S3。\n'
  next_recommended="默认 profile 已兼容；先跑 readiness，再显式打开 provider 调用做 S1/S2/S3。"
  printf '      SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE=1 bash scripts/smoke-cds-agent-official-sdk-run.sh\n'
  printf '      SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE=1 bash scripts/smoke-cds-agent-official-sdk-run.sh\n'
  printf '      SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE=1 bash scripts/smoke-cds-agent-official-sdk-controls.sh\n'
fi

printf '\nDiagnosis: '
healthy_count=$(smoke_get_data "$resp" '.diagnostics.healthyCount // 0')
if [[ "$desired_adapter" != "claude-agent-sdk" ]]; then
  printf 'MAP 未期望官方 Claude Agent SDK adapter。\n'
  diagnosis="MAP 未期望官方 Claude Agent SDK adapter。"
elif (( instance_count <= 0 )); then
  printf 'MAP/CDS 控制面未发现可路由 sidecar 实例。\n'
  diagnosis="MAP/CDS 控制面未发现可路由 sidecar 实例。"
elif (( healthy_count <= 0 )); then
  printf '已发现 sidecar，但 /readyz 未达到 healthy。\n'
  diagnosis="已发现 sidecar，但 /readyz 未达到 healthy。"
else
  official_instances=$(smoke_get_data "$resp" '[.diagnostics.instances[]? | select((.agentAdapter // "") == "claude-agent-sdk" or (.loopOwner // "") == "claude-agent-sdk")] | length')
  if (( official_instances <= 0 )); then
    printf 'sidecar healthy，但 loopOwner 未证明为官方 SDK。\n'
    diagnosis="sidecar healthy，但 loopOwner 未证明为官方 SDK。"
  else
    printf 'runtime pool 已具备 official SDK adapter 最小运行前置条件。\n'
    diagnosis="runtime pool 已具备 official SDK adapter 最小运行前置条件。"
  fi
fi

if [[ -n "$SMOKE_CDS_AGENT_DOCTOR_REPORT" ]]; then
  mkdir -p "$(dirname "$SMOKE_CDS_AGENT_DOCTOR_REPORT")"
  jq -n \
    --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg host "$SMOKE_HOST" \
    --arg desiredAdapter "$desired_adapter" \
    --arg runtimeTransport "$(smoke_get_data "$resp" '.diagnostics.runtimeTransport // ""')" \
    --arg diagnosis "$diagnosis" \
    --arg nextRecommended "$next_recommended" \
    --arg aliasStatus "$alias_check_status" \
    --arg alias "$SMOKE_CDS_AGENT_SIDECAR_ALIAS" \
    --arg aliasWarning "$alias_warning" \
    --argjson instanceCount "$runtime_instance_count" \
    --argjson healthyCount "$runtime_healthy_count" \
    --argjson aliasAttempts "$SMOKE_CDS_AGENT_ALIAS_ATTEMPTS" \
    --argjson aliasUniqueHosts "$alias_unique_hosts" \
    --argjson aliasReadyCount "$alias_ready_count" \
    --argjson aliasLoopCount "$alias_loop_count" \
    --argjson aliasLazyLegacyCount "$alias_lazy_legacy_count" \
    --argjson runtimeStatus "$(printf '%s' "$resp" | jq -c '.data.diagnostics')" \
    --argjson defaultProfile "$(printf '%s' "${default_profile:-null}" | jq -c '.')" \
    --argjson officialTemplate "$(printf '%s' "${anthropic_template:-null}" | jq -c '.')" \
    --argjson adapterCompatibility "$(printf '%s' "$compat_resp" | jq -c '.data.items // []')" \
    '{
      generatedAt: $generatedAt,
      host: $host,
      diagnosis: $diagnosis,
      nextRecommended: $nextRecommended,
      runtime: {
        desiredAdapter: $desiredAdapter,
        runtimeTransport: $runtimeTransport,
        instanceCount: $instanceCount,
        healthyCount: $healthyCount,
        diagnostics: $runtimeStatus
      },
      aliasCheck: {
        status: $aliasStatus,
        alias: $alias,
        attempts: $aliasAttempts,
        uniqueHosts: $aliasUniqueHosts,
        readySamples: $aliasReadyCount,
        officialLoopSamples: $aliasLoopCount,
        lazyLegacyFallbackSamples: $aliasLazyLegacyCount,
        warning: (if $aliasWarning == "" then null else $aliasWarning end)
      },
      defaultProfile: $defaultProfile,
      officialTemplate: $officialTemplate,
      adapterCompatibility: $adapterCompatibility
    }' > "$SMOKE_CDS_AGENT_DOCTOR_REPORT"
  printf '\nDoctor report: %s\n' "$SMOKE_CDS_AGENT_DOCTOR_REPORT"
fi

smoke_done
