#!/usr/bin/env bash
# ============================================
# CDS Deploy Pipeline — 全链路部署脚本
# 用法: ./scripts/cds-deploy-pipeline.sh [--skip-push] [--skip-smoke] [--module MODULE]
# ============================================

set -euo pipefail

# ── 颜色 ──
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

# ── 配置 ──
CDS_HOST="${CDS_DASHBOARD_URL:-http://localhost:9900}"
CDS_AUTH=""
if [ -n "${CDS_TOKEN:-}" ]; then
  CDS_AUTH="-H X-CDS-Token:${CDS_TOKEN}"
fi

TRACE_ID=$(openssl rand -hex 4 2>/dev/null || printf '%04x%04x' $RANDOM $RANDOM)
SKIP_PUSH=false
SKIP_SMOKE=false
TARGET_MODULE=""
TOTAL_START=$(date +%s%N 2>/dev/null || date +%s)

# ── 参数解析 ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-push)  SKIP_PUSH=true; shift ;;
    --skip-smoke) SKIP_SMOKE=true; shift ;;
    --module)     TARGET_MODULE="$2"; shift 2 ;;
    *)            shift ;;
  esac
done

# ── 工具函数 ──
elapsed_ms() {
  local start=$1
  local now=$(date +%s%N 2>/dev/null || date +%s)
  if [ ${#now} -gt 10 ]; then
    echo $(( (now - start) / 1000000 ))
  else
    echo $(( (now - start) * 1000 ))
  fi
}

trace_log() {
  local phase=$1; local status=$2; local msg=$3
  local icon="⏳"
  case "$status" in
    ok)   icon="✓" ;;
    fail) icon="✗" ;;
    skip) icon="⊘" ;;
    info) icon="─" ;;
  esac
  echo -e "${CYAN}[trace:${TRACE_ID}]${NC} ${phase}  ${icon} ${msg}"
}

fail_and_exit() {
  local phase=$1; local msg=$2
  trace_log "$phase" "fail" "${RED}${msg}${NC}"
  echo ""
  echo -e "${RED}Pipeline 失败于 ${phase}${NC}"
  echo -e "Trace ID: ${TRACE_ID}"
  exit 1
}

# ── Phase 0: 环境预检 ──
P0_START=$(date +%s%N 2>/dev/null || date +%s)
echo ""
echo -e "${CYAN}━━━ CDS Deploy Pipeline [trace:${TRACE_ID}] ━━━${NC}"
echo ""
trace_log "Phase 0" "info" "环境预检..."

# 分支检查
BRANCH=$(git branch --show-current 2>/dev/null || true)
if [ -z "$BRANCH" ]; then
  fail_and_exit "Phase 0" "不在任何分支上 (detached HEAD)"
fi
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  fail_and_exit "Phase 0" "禁止在 ${BRANCH} 分支上执行部署流水线"
fi
trace_log "Phase 0" "ok" "分支: ${BRANCH}"

# CDS 可用性
if ! curl -sf ${CDS_AUTH} "${CDS_HOST}/api/config" > /dev/null 2>&1; then
  fail_and_exit "Phase 0" "CDS 不可达: ${CDS_HOST} (运行 ./exec_cds.sh status 检查)"
fi
trace_log "Phase 0" "ok" "CDS: ${CDS_HOST}"

# 查找分支 ID
BRANCHES_JSON=$(curl -sf ${CDS_AUTH} "${CDS_HOST}/api/branches" 2>/dev/null || echo '{"branches":[]}')
BRANCH_ID=$(echo "$BRANCHES_JSON" | jq -r ".branches[] | select(.branch==\"${BRANCH}\") | .id" 2>/dev/null | head -1)

if [ -z "$BRANCH_ID" ] || [ "$BRANCH_ID" = "null" ]; then
  trace_log "Phase 0" "info" "分支未注册，自动注册..."
  REG_RESULT=$(curl -sf ${CDS_AUTH} "${CDS_HOST}/api/branches" \
    -X POST -H "Content-Type: application/json" \
    -d "{\"branch\": \"${BRANCH}\"}" 2>/dev/null || echo '{}')
  BRANCH_ID=$(echo "$REG_RESULT" | jq -r '.branch.id // .id // empty' 2>/dev/null | head -1)
  if [ -z "$BRANCH_ID" ]; then
    fail_and_exit "Phase 0" "分支注册失败"
  fi
  trace_log "Phase 0" "ok" "分支已注册: ${BRANCH_ID}"
else
  trace_log "Phase 0" "ok" "分支 ID: ${BRANCH_ID}"
fi

# jq 检查
if ! command -v jq &>/dev/null; then
  fail_and_exit "Phase 0" "缺少 jq (apt install jq)"
fi

P0_MS=$(elapsed_ms $P0_START)
trace_log "Phase 0" "ok" "预检完成 (${P0_MS}ms)"

# ── Phase 1: Git Push ──
P1_START=$(date +%s%N 2>/dev/null || date +%s)
echo ""
if [ "$SKIP_PUSH" = true ]; then
  trace_log "Phase 1" "skip" "Git Push (--skip-push)"
else
  trace_log "Phase 1" "info" "Git Push..."
  COMMIT_SHORT=$(git log -1 --format='%h' 2>/dev/null)
  COMMIT_MSG=$(git log -1 --format='%s' 2>/dev/null)

  PUSH_OK=false
  for attempt in 1 2 3 4; do
    if git push -u origin "$BRANCH" 2>/dev/null; then
      PUSH_OK=true
      break
    fi
    WAIT=$((2 ** attempt))
    trace_log "Phase 1" "info" "推送失败，${WAIT}s 后重试 (${attempt}/4)..."
    sleep $WAIT
  done

  if [ "$PUSH_OK" = false ]; then
    fail_and_exit "Phase 1" "Git Push 失败 (重试 4 次后)"
  fi

  P1_MS=$(elapsed_ms $P1_START)
  trace_log "Phase 1" "ok" "已推送 ${COMMIT_SHORT} \"${COMMIT_MSG}\" (${P1_MS}ms)"
fi

# ── Phase 2: CDS Pull ──
P2_START=$(date +%s%N 2>/dev/null || date +%s)
echo ""
trace_log "Phase 2" "info" "CDS Pull..."

PULL_RESULT=$(curl -sf ${CDS_AUTH} "${CDS_HOST}/api/branches/${BRANCH_ID}/pull" -X POST 2>/dev/null || echo '{}')
PULL_HEAD=$(echo "$PULL_RESULT" | jq -r '.head // "unknown"' 2>/dev/null)

P2_MS=$(elapsed_ms $P2_START)
trace_log "Phase 2" "ok" "HEAD: ${PULL_HEAD} (${P2_MS}ms)"

# ── Phase 3: CDS Deploy ──
P3_START=$(date +%s%N 2>/dev/null || date +%s)
echo ""
trace_log "Phase 3" "info" "CDS Deploy..."

# 触发部署（SSE 流 — 后台消费，不阻塞）
curl -sf ${CDS_AUTH} "${CDS_HOST}/api/branches/${BRANCH_ID}/deploy" \
  -X POST -H "Accept: text/event-stream" \
  --no-buffer --max-time 300 > /tmp/cds-deploy-${TRACE_ID}.log 2>&1 &
DEPLOY_PID=$!

# 轮询分支状态
DEPLOY_TIMEOUT=300
DEPLOY_ELAPSED=0
BRANCH_STATUS="building"

while [ "$DEPLOY_ELAPSED" -lt "$DEPLOY_TIMEOUT" ]; do
  sleep 5
  DEPLOY_ELAPSED=$((DEPLOY_ELAPSED + 5))

  STATUS_JSON=$(curl -sf ${CDS_AUTH} "${CDS_HOST}/api/branches" 2>/dev/null || echo '{"branches":[]}')
  BRANCH_STATUS=$(echo "$STATUS_JSON" | jq -r ".branches[] | select(.id==\"${BRANCH_ID}\") | .status" 2>/dev/null | head -1)

  case "$BRANCH_STATUS" in
    "running")
      trace_log "Phase 3" "info" "服务已启动"
      break
      ;;
    "error")
      trace_log "Phase 3" "info" "部署出错"
      break
      ;;
    "building"|"starting")
      trace_log "Phase 3" "info" "状态: ${BRANCH_STATUS} (${DEPLOY_ELAPSED}s)..."
      ;;
    *)
      trace_log "Phase 3" "info" "状态: ${BRANCH_STATUS:-unknown} (${DEPLOY_ELAPSED}s)..."
      ;;
  esac
done

# 清理后台进程
kill $DEPLOY_PID 2>/dev/null || true
wait $DEPLOY_PID 2>/dev/null || true

if [ "$BRANCH_STATUS" != "running" ]; then
  # 获取容器日志用于诊断
  trace_log "Phase 3" "fail" "部署失败 (状态: ${BRANCH_STATUS})"
  echo ""
  echo -e "${YELLOW}容器日志:${NC}"
  SERVICES=$(echo "$STATUS_JSON" | jq -r ".branches[] | select(.id==\"${BRANCH_ID}\") | .services | keys[]" 2>/dev/null || true)
  for SVC in $SERVICES; do
    SVC_STATUS=$(echo "$STATUS_JSON" | jq -r ".branches[] | select(.id==\"${BRANCH_ID}\") | .services[\"${SVC}\"].status" 2>/dev/null)
    if [ "$SVC_STATUS" = "error" ]; then
      echo -e "  ${RED}${SVC}: error${NC}"
      curl -sf ${CDS_AUTH} "${CDS_HOST}/api/branches/${BRANCH_ID}/container-logs" \
        -X POST -H "Content-Type: application/json" \
        -d "{\"profileId\":\"${SVC}\",\"tail\":20}" 2>/dev/null | jq -r '.logs // "无日志"' || true
    fi
  done
  fail_and_exit "Phase 3" "部署未成功，请检查容器日志"
fi

# 提取服务端口
SERVICES_JSON=$(echo "$STATUS_JSON" | jq ".branches[] | select(.id==\"${BRANCH_ID}\") | .services" 2>/dev/null)
API_PORT=$(echo "$SERVICES_JSON" | jq -r '.api.hostPort // empty' 2>/dev/null)

P3_MS=$(elapsed_ms $P3_START)

# 输出各服务状态
echo "$SERVICES_JSON" | jq -r 'to_entries[] | "  \(.key): \(.value.status) (:\(.value.hostPort))"' 2>/dev/null | while read -r line; do
  trace_log "Phase 3" "ok" "$line"
done
trace_log "Phase 3" "ok" "部署完成 (${P3_MS}ms)"

# ── Phase 4: Readiness Check ──
P4_START=$(date +%s%N 2>/dev/null || date +%s)
echo ""
trace_log "Phase 4" "info" "Readiness Check..."

if [ -n "$API_PORT" ]; then
  READY=false
  for i in $(seq 1 15); do
    if curl -sf "http://localhost:${API_PORT}/api/users/me" \
      -H "X-AI-Access-Key: ${AI_ACCESS_KEY:-test}" \
      -H "X-AI-Impersonate: admin" > /dev/null 2>&1; then
      READY=true
      trace_log "Phase 4" "ok" "API (:${API_PORT}) 就绪 (第 ${i} 次探测)"
      break
    fi
    sleep 3
  done
  if [ "$READY" = false ]; then
    trace_log "Phase 4" "fail" "API 就绪检查超时 (45s)"
    echo -e "${YELLOW}提示: 服务可能仍在启动中，可稍后手动验证${NC}"
  fi
else
  trace_log "Phase 4" "skip" "未找到 API 服务端口"
fi

P4_MS=$(elapsed_ms $P4_START)
trace_log "Phase 4" "ok" "就绪检查完成 (${P4_MS}ms)"

# ── Phase 5: Smoke Test ──
P5_START=$(date +%s%N 2>/dev/null || date +%s)
echo ""

if [ "$SKIP_SMOKE" = true ]; then
  trace_log "Phase 5" "skip" "Smoke Test (--skip-smoke)"
elif [ -z "${AI_ACCESS_KEY:-}" ]; then
  trace_log "Phase 5" "skip" "Smoke Test (AI_ACCESS_KEY 未设置)"
elif [ -z "$API_PORT" ]; then
  trace_log "Phase 5" "skip" "Smoke Test (无 API 端口)"
else
  trace_log "Phase 5" "info" "Smoke Test..."
  SMOKE_HOST="http://localhost:${API_PORT}"
  AUTH_HEADERS=(-H "X-AI-Access-Key: ${AI_ACCESS_KEY}" -H "X-AI-Impersonate: admin" -H "Content-Type: application/json")

  # 基础健康检查
  SMOKE_PASS=0
  SMOKE_FAIL=0

  if curl -sf "${SMOKE_HOST}/api/users/me" "${AUTH_HEADERS[@]}" | jq -e '.data.name' > /dev/null 2>&1; then
    SMOKE_PASS=$((SMOKE_PASS + 1))
    trace_log "Phase 5" "ok" "GET /api/users/me"
  else
    SMOKE_FAIL=$((SMOKE_FAIL + 1))
    trace_log "Phase 5" "fail" "GET /api/users/me"
  fi

  # 推断模块
  if [ -z "$TARGET_MODULE" ]; then
    CHANGED=$(git diff --name-only HEAD~1 HEAD 2>/dev/null || true)
    if echo "$CHANGED" | grep -q "AutomationRules\|automations"; then TARGET_MODULE="automations"; fi
    if echo "$CHANGED" | grep -q "DefectAgent\|defect"; then TARGET_MODULE="defect-agent"; fi
    if echo "$CHANGED" | grep -q "VisualAgent\|visual"; then TARGET_MODULE="visual-agent"; fi
    if echo "$CHANGED" | grep -q "OpenPlatform"; then TARGET_MODULE="open-platform"; fi
  fi

  if [ -n "$TARGET_MODULE" ]; then
    trace_log "Phase 5" "info" "推断模块: ${TARGET_MODULE} (详细测试请用 /smoke ${TARGET_MODULE})"
  fi

  P5_MS=$(elapsed_ms $P5_START)
  trace_log "Phase 5" "ok" "通过: ${SMOKE_PASS}, 失败: ${SMOKE_FAIL} (${P5_MS}ms)"
fi

# ── 汇总报告 ──
TOTAL_MS=$(elapsed_ms $TOTAL_START)
BRANCH_SLUG=$(echo "$BRANCH" | sed 's|/|-|g')
echo ""
echo -e "${CYAN}━━━ Pipeline 完成 ━━━${NC}"
echo -e "  Trace ID:   ${TRACE_ID}"
echo -e "  分支:       ${BRANCH}"
echo -e "  总耗时:     ${TOTAL_MS}ms"
echo -e "  预览地址:   ${GREEN}https://${BRANCH_SLUG}.miduo.org/${NC}"
echo ""
