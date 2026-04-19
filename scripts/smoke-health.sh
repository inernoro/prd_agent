#!/usr/bin/env bash
# ============================================
# 冒烟测试: 系统连通性 + 鉴权
# ============================================
#
# 这是最轻量的冒烟测试,只验证:
#   1. prd-api 可达
#   2. AI_ACCESS_KEY + X-AI-Impersonate 组合能成功通过鉴权
#   3. 若干核心 Agent 的 /health 端点响应正常
#
# 用作 CDS 部署后的第一道闸门 —— 这个脚本绿了才跑各 Agent 的深度
# 冒烟。脚本本身不创建任何数据,不可能污染生产。
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_STEP_TOTAL=4
smoke_init "Health & Auth"

# --- 1. TCP/HTTP 连通 -----------------------------------------------
smoke_step "验证 prd-api 可达 (带 3 次指数退避重试)"
smoke_retry 3 2 curl --max-time "$SMOKE_TIMEOUT" --silent --fail --output /dev/null \
  "$SMOKE_HOST/api/prd-agent/health" \
  -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  -H "X-AI-Impersonate: $SMOKE_USER"
smoke_ok "HTTP 可达"

# --- 2. PRD Agent /health -------------------------------------------
smoke_step "GET /api/prd-agent/health"
resp=$(smoke_get /api/prd-agent/health)
status=$(smoke_get_data "$resp" .status)
smoke_assert_eq "$status" "ok" "PRD Agent health.status"
smoke_ok "PRD Agent 功能可用"

# --- 3. 鉴权负面测试: 错误 key 必须 401 -----------------------------
smoke_step "负向测试: 无效 X-AI-Access-Key 必须返回 401"
bad_status=$(curl --max-time "$SMOKE_TIMEOUT" --silent --output /dev/null -w '%{http_code}' \
  -H "X-AI-Access-Key: invalid-$(date +%s)" \
  -H "X-AI-Impersonate: $SMOKE_USER" \
  "$SMOKE_HOST/api/prd-agent/health" || true)
if [[ "$bad_status" != "401" && "$bad_status" != "403" ]]; then
  smoke_fail "鉴权未生效: 无效 key 返回 $bad_status (期望 401/403)"
fi
smoke_ok "无效 key 被正确拒绝 (HTTP $bad_status)"

# --- 4. 鉴权负面测试: 缺少 impersonate 应被拒绝 ---------------------
smoke_step "负向测试: 缺失 X-AI-Impersonate 必须返回 401"
missing_impersonate=$(curl --max-time "$SMOKE_TIMEOUT" --silent --output /dev/null -w '%{http_code}' \
  -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  "$SMOKE_HOST/api/prd-agent/health" || true)
if [[ "$missing_impersonate" != "401" && "$missing_impersonate" != "403" ]]; then
  smoke_fail "鉴权中间件漏洞: 缺 impersonate 返回 $missing_impersonate (期望 401/403)"
fi
smoke_ok "缺 impersonate 被正确拒绝 (HTTP $missing_impersonate)"

smoke_done
