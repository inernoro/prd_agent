#!/usr/bin/env bash
# ==========================================
# 冒烟测试: CDS Agent Non-code Compatibility
# ==========================================
#
# 目的:
#   证明 CDS Agent official SDK adapter 迁移没有把 PRD/Defect/Literary/Visual
#   等非代码 Toolbox agent 绑到 CDS sidecar runtime pool。
#
# 该 smoke 是 N6 的最小本地门禁: 它不调用 provider,不需要 Anthropic key。
# 它覆盖三类证据:
#   1. 源码扫描: 非代码 adapter 不引用 IInfraAgentRuntimeAdapter /
#      IClaudeSidecarRouter / InfraAgentRuntimes / ClaudeSidecar。
#   2. 构造函数反射: 只有 CdsAgentAdapter 注入 CDS runtime adapter。
#   3. 最小业务路径: PRD/Defect/Literary 通过 fake gateway 产出 artifact,
#      Visual 走不调用 provider 的 compose MVP 路径。
#   4. Adapter 兼容矩阵: codex/openai-agents-sdk/google-adk 等候选官方
#      SDK 仍保持 planned-not-routable,不能误进入代码审查默认路径。
# ==========================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_PROJECT="$ROOT_DIR/prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj"
FILTER="FullyQualifiedName~CdsAgentRuntimeCompatibilityTests|FullyQualifiedName~InfraAgentRuntimeProfilesControllerTests"
DOTNET_BIN="${DOTNET_BIN:-}"
REPORT="${SMOKE_CDS_AGENT_N6_REPORT:-/tmp/cds-agent-n6-non-code-compatibility-current.json}"

dotnet_has_net8_runtime() {
  local candidate="$1"
  [[ -n "$candidate" ]] || return 1
  command -v "$candidate" >/dev/null 2>&1 || return 1
  "$candidate" --list-runtimes 2>/dev/null | grep -Eq '^Microsoft\.NETCore\.App 8\.'
}

resolve_dotnet_bin() {
  local candidates=()
  if [[ -n "${DOTNET_BIN:-}" ]]; then
    candidates+=("$DOTNET_BIN")
  fi
  candidates+=(
    dotnet
    /opt/homebrew/opt/dotnet@8/bin/dotnet
    /usr/local/share/dotnet/dotnet
    /opt/homebrew/bin/dotnet
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if dotnet_has_net8_runtime "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  printf '%s\n' "${DOTNET_BIN:-dotnet}"
  return 0
}

DOTNET_BIN="$(resolve_dotnet_bin)"

printf '==========================================\n'
printf '冒烟测试: CDS Agent Non-code Compatibility\n'
printf '项目:     %s\n' "$TEST_PROJECT"
printf '过滤器:   %s\n' "$FILTER"
printf 'dotnet:   %s\n' "$DOTNET_BIN"
printf '报告:     %s\n' "$REPORT"
printf '==========================================\n\n'

started_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
start_seconds="$(date +%s)"
mkdir -p "$(dirname "$REPORT")"

set +e
DOTNET_CLI_USE_MSBUILD_SERVER="${DOTNET_CLI_USE_MSBUILD_SERVER:-0}" \
MSBUILDDISABLENODEREUSE="${MSBUILDDISABLENODEREUSE:-1}" \
  "$DOTNET_BIN" test "$TEST_PROJECT" --filter "$FILTER" -m:1 /nodeReuse:false
exit_code=$?
set -e

finished_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
total_seconds="$(( $(date +%s) - start_seconds ))"

jq -n \
  --arg status "$(if [[ "$exit_code" -eq 0 ]]; then printf pass; else printf failed; fi)" \
  --arg gate "N6" \
  --arg startedAt "$started_at" \
  --arg finishedAt "$finished_at" \
  --arg testProject "$TEST_PROJECT" \
  --arg filter "$FILTER" \
  --arg dotnet "$DOTNET_BIN" \
  --arg evidence "non-code Toolbox agents independent from CDS sidecar runtime pool; codex/openai-agents-sdk/google-adk remain planned-not-routable until contracts and provider smokes pass" \
  --argjson exitCode "$exit_code" \
  --argjson totalSeconds "$total_seconds" \
  '{gate:$gate,status:$status,exitCode:$exitCode,totalSeconds:$totalSeconds,startedAt:$startedAt,finishedAt:$finishedAt,testProject:$testProject,filter:$filter,dotnet:$dotnet,evidence:$evidence}' \
  > "$REPORT"

if [[ "$exit_code" -ne 0 ]]; then
  printf '\n❌ N6 failed: report=%s\n' "$REPORT" >&2
  exit "$exit_code"
fi

printf '\n✅ N6 ready: non-code Toolbox agents remain independent from CDS sidecar runtime pool; candidate official SDK adapters remain planned-not-routable until contracts and provider smokes pass\n'
printf 'N6 report: %s\n' "$REPORT"
