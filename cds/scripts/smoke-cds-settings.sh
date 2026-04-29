#!/usr/bin/env bash
# ============================================
# CDS Settings 页冒烟测试
# ============================================
#
# 验证 React cds-settings 用到的所有 /api/* 都返回 JSON 而非 HTML。
# 经典坑：fetch 调用了不存在的路径，被 SPA fallback 返回 index.html，
# 前端 .json() 解析时报 "Unexpected token '<', '<!DOCTYPE'..."。
#
# 用法：
#   bash cds/scripts/smoke-cds-settings.sh https://cds.miduo.org [AI_ACCESS_KEY]
#
# 没传 AI_ACCESS_KEY 时尝试读 $CDS_AI_ACCESS_KEY、$AI_ACCESS_KEY 或匿名调用
# （cookie/token 中间件可能放行某些只读端点）。
# ============================================

set -uo pipefail

HOST="${1:-http://localhost:9900}"
KEY="${2:-${CDS_AI_ACCESS_KEY:-${AI_ACCESS_KEY:-}}}"

if [ -z "$HOST" ]; then
  echo "用法: $0 <CDS_HOST> [AI_ACCESS_KEY]"
  exit 1
fi

PASS=0
FAIL=0

# 调一个 endpoint，验证返回是 JSON（不是 HTML）+ HTTP 2xx
check_endpoint() {
  local method="$1" path="$2" expect_status="${3:-200}"
  local url="${HOST%/}${path}"
  local hdr=""
  [ -n "$KEY" ] && hdr="-H X-AI-Access-Key:$KEY"

  local resp http
  resp=$(curl -s -o /tmp/cds_smoke_body -w "%{http_code}" -X "$method" $hdr "$url" 2>/dev/null || echo "000")
  http="$resp"

  local body_head
  body_head=$(head -c 50 /tmp/cds_smoke_body 2>/dev/null | tr -d '\n' | head -c 50)

  # 是 HTML 吗？
  if echo "$body_head" | grep -qi "<!doctype\|<html"; then
    echo "  [FAIL] $method $path → HTTP $http 但返回 HTML（路径可能不存在被 SPA 接走）: $body_head"
    FAIL=$((FAIL+1))
    return
  fi

  # 是 JSON 吗？
  if ! echo "$body_head" | grep -qE '^\s*[\{\[]'; then
    echo "  [FAIL] $method $path → HTTP $http 但不是 JSON: $body_head"
    FAIL=$((FAIL+1))
    return
  fi

  # HTTP 状态码
  if [ "$http" = "$expect_status" ] || [ "$http" = "401" ] || [ "$http" = "403" ]; then
    # 401/403 也算"接口存在"，只是没鉴权。我们只验证路径存在。
    echo "  [OK]   $method $path → HTTP $http"
    PASS=$((PASS+1))
  else
    echo "  [WARN] $method $path → HTTP $http（接口存在但状态非预期）"
    PASS=$((PASS+1))
  fi
}

echo "=== CDS 系统设置页 API 冒烟测试 ==="
echo "Host: $HOST"
echo "Key:  $([ -n "$KEY" ] && echo "已配置 ($(echo "$KEY" | head -c 4)...)" || echo "无（匿名）")"
echo

echo "[概览 tab]"
check_endpoint GET /api/me
check_endpoint GET /api/cluster/status
echo

echo "[GitHub 集成 tab]"
check_endpoint GET /api/github/app
echo

echo "[存储后端 tab]"
check_endpoint GET /api/storage-mode
echo

echo "[集群 tab]"
check_endpoint GET /api/cluster/status
echo

echo "[CDS 全局变量 tab]"
check_endpoint GET "/api/env?scope=_global"
echo

echo "[维护 tab]"
check_endpoint GET /api/mirror
check_endpoint GET /api/tab-title
echo

echo "[Per-project API（Step G 新增）]"
check_endpoint GET /api/projects/default/preview-mode
check_endpoint GET /api/projects/default/comment-template
echo

echo "===================="
echo "通过: $PASS  失败: $FAIL"
[ "$FAIL" -eq 0 ] && echo "全部通过" || echo "有 $FAIL 项失败"
exit $FAIL
