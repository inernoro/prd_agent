#!/usr/bin/env bash
# CDS Agent remote host / shared-service pool preparation
#
# 默认 dry-run，只检查 remote host 现状和所需输入。
# 显式设置 CDS_AGENT_REMOTE_HOST_APPLY=1 才会创建 remote host。
# 显式设置 CDS_AGENT_REMOTE_HOST_DEPLOY_SIDECAR=1 才会触发 deploy-sidecar。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPLY="${CDS_AGENT_REMOTE_HOST_APPLY:-0}"
DEPLOY_SIDECAR="${CDS_AGENT_REMOTE_HOST_DEPLOY_SIDECAR:-0}"
REPORT="${CDS_AGENT_REMOTE_HOST_POOL_REPORT:-}"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_EPOCH="$(date +%s)"

fail() {
  printf '❌ %s\n' "$*" >&2
  exit 1
}

ok() {
  printf '✅ %s\n' "$*"
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少依赖: $1"
}

cds_base_url() {
  local base="${CDS_HOST%/}"
  [[ "$base" == http* ]] || base="https://$base"
  printf '%s' "$base"
}

auth_args=()
build_auth_args() {
  auth_args=(-H "Accept: application/json" -H "User-Agent: curl/8.5.0")
  if [[ -n "${CDS_PROJECT_KEY:-}" ]]; then
    auth_args+=(-H "X-AI-Access-Key: $CDS_PROJECT_KEY")
  elif [[ -n "${AI_ACCESS_KEY:-}" ]]; then
    auth_args+=(-H "X-AI-Access-Key: $AI_ACCESS_KEY")
  else
    fail "需要 AI_ACCESS_KEY 或 CDS_PROJECT_KEY"
  fi
}

read_private_key() {
  if [[ -n "${CDS_REMOTE_HOST_SSH_PRIVATE_KEY:-}" ]]; then
    printf '%s' "$CDS_REMOTE_HOST_SSH_PRIVATE_KEY"
    return 0
  fi
  if [[ -n "${CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE:-}" ]]; then
    [[ -f "$CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE" ]] || fail "私钥文件不存在: $CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE"
    cat "$CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE"
    return 0
  fi
  return 1
}

write_report() {
  local status="$1"
  local message="$2"
  local created_host_json="${3:-null}"
  local deploy_json="${4:-null}"
  [[ -n "$REPORT" ]] || return 0
  mkdir -p "$(dirname "$REPORT")"
  jq -n \
    --arg startedAt "$STARTED_AT" \
    --arg finishedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson elapsedSeconds "$(( $(date +%s) - STARTED_EPOCH ))" \
    --arg cdsHost "$(cds_base_url)" \
    --arg apply "$APPLY" \
    --arg deploySidecar "$DEPLOY_SIDECAR" \
    --arg status "$status" \
    --arg message "$message" \
    --argjson existingHosts "$hosts_json" \
    --argjson targetHost "$target_host_json" \
    --argjson missingConfig "$missing_config_json" \
    --argjson invalidConfig "$invalid_config_json" \
    --argjson createdHost "$created_host_json" \
    --argjson deploy "$deploy_json" \
    '{
      startedAt: $startedAt,
      finishedAt: $finishedAt,
      elapsedSeconds: $elapsedSeconds,
      cdsHost: $cdsHost,
      apply: ($apply == "1"),
      deploySidecar: ($deploySidecar == "1"),
      status: $status,
      message: $message,
      existingHostCount: ($existingHosts.hosts | length),
      enabledHostCount: ([ $existingHosts.hosts[]? | select(.isEnabled != false) ] | length),
      existingHosts: $existingHosts.hosts,
      targetHost: $targetHost,
      targetHostId: ($targetHost.id // null),
      willCreateHost: (($targetHost.id // "") == ""),
      missingConfig: $missingConfig,
      invalidConfig: $invalidConfig,
      preflightReady: (($missingConfig | length) == 0 and ($invalidConfig | length) == 0),
      recoveryManifest: {
        safety: "remote_host_create_then_shared_runtime_deploy",
        phases: [
          {
            code: "remote_host_create",
            method: "POST",
            endpoint: ($cdsHost + "/api/cds-system/remote-hosts"),
            applyFlag: "CDS_AGENT_REMOTE_HOST_APPLY=1",
            requiredEnv: [
              "CDS_HOST",
              "AI_ACCESS_KEY or CDS_PROJECT_KEY",
              "CDS_REMOTE_HOST_NAME",
              "CDS_REMOTE_HOST_HOST",
              "CDS_REMOTE_HOST_SSH_USER",
              "CDS_REMOTE_HOST_SSH_PRIVATE_KEY or CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE"
            ],
            missingEnv: [
              $missingConfig[]
              | select(. != "CDS_AGENT_SIDECAR_IMAGE")
            ]
          },
          {
            code: "shared_runtime_deploy",
            method: "POST",
            endpoint: ($cdsHost + "/api/cds-system/remote-hosts/<hostId>/deploy-sidecar"),
            applyFlag: "CDS_AGENT_REMOTE_HOST_DEPLOY_SIDECAR=1",
            requiredEnv: [
              "CDS_AGENT_SIDECAR_IMAGE",
              "CDS_AGENT_SIDECAR_PORT optional, default 7400",
              "CDS_AGENT_SIDECAR_RELEASE_TAG optional"
            ],
            missingEnv: (
              if $deploySidecar == "1" and ([$missingConfig[] | select(. == "CDS_AGENT_SIDECAR_IMAGE")] | length) > 0
              then ["CDS_AGENT_SIDECAR_IMAGE"]
              elif $deploySidecar != "1"
              then ["CDS_AGENT_REMOTE_HOST_DEPLOY_SIDECAR=1", "CDS_AGENT_SIDECAR_IMAGE"]
              else []
              end
            )
          }
        ],
        expectedPostCheck: "SMOKE_CDS_AGENT_SHARED_POOL_REMOTE=1 bash scripts/smoke-cds-agent-shared-service-pool.sh"
      },
      createdHost: $createdHost,
      deploy: $deploy
    }' > "$REPORT"
}

[[ -n "${CDS_HOST:-}" ]] || fail "需要 CDS_HOST"
require_tool jq
require_tool curl
build_auth_args

printf '==========================================\n'
printf 'CDS Agent Remote Host Pool Preparation\n'
printf 'CDS:    %s\n' "$(cds_base_url)"
printf 'Apply:  %s\n' "$APPLY"
printf 'Deploy: %s\n' "$DEPLOY_SIDECAR"
printf '==========================================\n'

hosts_json=$(curl --max-time 20 --show-error --silent --fail-with-body \
  "${auth_args[@]}" \
  "$(cds_base_url)/api/cds-system/remote-hosts")
host_count=$(printf '%s' "$hosts_json" | jq -r '.hosts | length')
enabled_host_count=$(printf '%s' "$hosts_json" | jq -r '[.hosts[]? | select(.isEnabled != false)] | length')
ok "remoteHosts hostCount=$host_count enabled=$enabled_host_count"

target_host_json='null'
if [[ -n "${CDS_REMOTE_HOST_ID:-}" ]]; then
  target_host_json=$(printf '%s' "$hosts_json" | jq -c --arg id "$CDS_REMOTE_HOST_ID" '.hosts[]? | select(.id == $id)' | head -n 1)
  [[ -n "$target_host_json" ]] || target_host_json='null'
else
  target_host_json=$(printf '%s' "$hosts_json" | jq -c '.hosts[]? | select(.isEnabled != false)' | head -n 1)
  [[ -n "$target_host_json" ]] || target_host_json='null'
fi
target_host_id=$(printf '%s' "$target_host_json" | jq -r '.id // ""')
if [[ -n "$target_host_id" ]]; then
  ok "target remote host id=$target_host_id"
fi

missing=()
invalid=()
if [[ -z "$target_host_id" ]]; then
  [[ -n "${CDS_REMOTE_HOST_NAME:-}" ]] || missing+=("CDS_REMOTE_HOST_NAME")
  [[ -n "${CDS_REMOTE_HOST_HOST:-}" ]] || missing+=("CDS_REMOTE_HOST_HOST")
  [[ -n "${CDS_REMOTE_HOST_SSH_USER:-}" ]] || missing+=("CDS_REMOTE_HOST_SSH_USER")
  if [[ -z "${CDS_REMOTE_HOST_SSH_PRIVATE_KEY:-}" && -z "${CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE:-}" ]]; then
    missing+=("CDS_REMOTE_HOST_SSH_PRIVATE_KEY or CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE")
  fi
  if [[ -n "${CDS_REMOTE_HOST_HOST:-}" && "$CDS_REMOTE_HOST_HOST" == *"://"* ]]; then
    invalid+=("CDS_REMOTE_HOST_HOST must be hostname/IP, not URL")
  fi
  if [[ -n "${CDS_REMOTE_HOST_SSH_PORT:-}" && ! "$CDS_REMOTE_HOST_SSH_PORT" =~ ^[0-9]+$ ]]; then
    invalid+=("CDS_REMOTE_HOST_SSH_PORT must be numeric")
  fi
  if [[ -n "${CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE:-}" ]]; then
    if [[ ! -f "$CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE" ]]; then
      invalid+=("CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE does not exist")
    elif ! grep -q -- 'BEGIN .*PRIVATE KEY' "$CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE"; then
      invalid+=("CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE does not look like a private key")
    fi
  elif [[ -n "${CDS_REMOTE_HOST_SSH_PRIVATE_KEY:-}" && "$CDS_REMOTE_HOST_SSH_PRIVATE_KEY" != *"BEGIN "*PRIVATE\ KEY* ]]; then
    invalid+=("CDS_REMOTE_HOST_SSH_PRIVATE_KEY does not look like a private key")
  fi
fi
if [[ "$DEPLOY_SIDECAR" == "1" && -z "${CDS_AGENT_SIDECAR_IMAGE:-}" ]]; then
  missing+=("CDS_AGENT_SIDECAR_IMAGE")
fi
if [[ -n "${CDS_AGENT_SIDECAR_IMAGE:-}" && "$CDS_AGENT_SIDECAR_IMAGE" =~ [[:space:]] ]]; then
  invalid+=("CDS_AGENT_SIDECAR_IMAGE must not contain whitespace")
fi
if (( ${#missing[@]} > 0 )); then
  missing_config_json=$(printf '%s\n' "${missing[@]}" | jq -R 'select(length > 0)' | jq -s .)
else
  missing_config_json='[]'
fi
if (( ${#invalid[@]} > 0 )); then
  invalid_config_json=$(printf '%s\n' "${invalid[@]}" | jq -R 'select(length > 0)' | jq -s .)
else
  invalid_config_json='[]'
fi

if (( ${#missing[@]} > 0 || ${#invalid[@]} > 0 )); then
  if (( ${#invalid[@]} > 0 )); then
    printf '\n无效配置:\n'
    printf '%s\n' "${invalid[@]}" | sed 's/^/  - /'
  fi
  printf '\n缺失配置:\n'
  if (( ${#missing[@]} > 0 )); then
    printf '%s\n' "${missing[@]}" | sed 's/^/  - /'
  else
    printf '  - none\n'
  fi
  if (( ${#invalid[@]} > 0 )); then
    write_report "invalid_config" "创建 remote host 或部署 sidecar 的配置格式不合法" "null" "null"
  else
    write_report "missing_config" "缺少创建 remote host 或部署 sidecar 所需配置" "null" "null"
  fi
  exit 0
fi

if [[ "$APPLY" != "1" ]]; then
  if [[ -n "$target_host_id" ]]; then
    printf '\nDRY-RUN: 已找到 enabled remote host。设置 CDS_AGENT_REMOTE_HOST_APPLY=1 后可复用该 host%s。\n' "$([[ "$DEPLOY_SIDECAR" == "1" ]] && printf ' 并部署 sidecar' || true)"
    write_report "dry_run_ready" "已找到 enabled remote host；未写远程" "$target_host_json" "null"
  else
    printf '\nDRY-RUN: 配置已足够创建 remote host，但未写远程。设置 CDS_AGENT_REMOTE_HOST_APPLY=1 后执行。\n'
    write_report "dry_run_ready" "配置已足够创建 remote host，但未写远程" "null" "null"
  fi
  exit 0
fi

if [[ -n "$target_host_id" ]]; then
  created_host_json="$target_host_json"
  host_id="$target_host_id"
  ok "using existing remote host id=$host_id"
else
  private_key=$(read_private_key)
  tags_json=$(printf '%s' "${CDS_REMOTE_HOST_TAGS:-cds-agent,shared-sidecar-pool}" | tr ',' '\n' | jq -R 'select(length > 0)' | jq -s .)
  body=$(jq -n \
    --arg name "$CDS_REMOTE_HOST_NAME" \
    --arg host "$CDS_REMOTE_HOST_HOST" \
    --arg sshUser "$CDS_REMOTE_HOST_SSH_USER" \
    --arg sshPrivateKey "$private_key" \
    --argjson sshPort "${CDS_REMOTE_HOST_SSH_PORT:-22}" \
    --argjson tags "$tags_json" \
    '{name:$name, host:$host, sshUser:$sshUser, sshPrivateKey:$sshPrivateKey, sshPort:$sshPort, tags:$tags}')

  created_host_resp=$(curl --max-time 30 --show-error --silent --fail-with-body \
    -X POST \
    "${auth_args[@]}" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "$(cds_base_url)/api/cds-system/remote-hosts")
  created_host_json=$(printf '%s' "$created_host_resp" | jq -c '.host')
  host_id=$(printf '%s' "$created_host_json" | jq -r '.id')
  ok "created remote host id=$host_id"
fi

deploy_json='null'
if [[ "$DEPLOY_SIDECAR" == "1" ]]; then
  deploy_body=$(jq -n \
    --arg image "$CDS_AGENT_SIDECAR_IMAGE" \
    --argjson port "${CDS_AGENT_SIDECAR_PORT:-7400}" \
    --arg releaseTag "${CDS_AGENT_SIDECAR_RELEASE_TAG:-}" \
    '{image:$image, port:$port, env:{}} + (if $releaseTag == "" then {} else {releaseTag:$releaseTag} end)')
  deploy_resp=$(curl --max-time 30 --show-error --silent --fail-with-body \
    -X POST \
    "${auth_args[@]}" \
    -H "Content-Type: application/json" \
    -d "$deploy_body" \
    "$(cds_base_url)/api/cds-system/remote-hosts/$host_id/deploy-sidecar")
  deploy_json=$(printf '%s' "$deploy_resp" | jq -c .)
  ok "sidecar deployment triggered id=$(printf '%s' "$deploy_json" | jq -r '.deploymentId // "unknown"')"
fi

write_report "applied" "remote host 已创建；sidecar 部署按配置执行" "$created_host_json" "$deploy_json"
