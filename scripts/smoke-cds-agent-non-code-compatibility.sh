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
# ==========================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_PROJECT="$ROOT_DIR/prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj"
FILTER="FullyQualifiedName~CdsAgentRuntimeCompatibilityTests"

printf '==========================================\n'
printf '冒烟测试: CDS Agent Non-code Compatibility\n'
printf '项目:     %s\n' "$TEST_PROJECT"
printf '过滤器:   %s\n' "$FILTER"
printf '==========================================\n\n'

dotnet test "$TEST_PROJECT" --filter "$FILTER"

printf '\n✅ N6 ready: non-code Toolbox agents remain independent from CDS sidecar runtime pool and pass minimal adapter business paths\n'
