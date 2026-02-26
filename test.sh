#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════
# PRD Agent Branch-Tester 全量验收测试
#
# 用法：
#   ./test.sh                  # 运行全部测试
#   ./test.sh --phase 3        # 只跑第 3 阶段
#   ./test.sh --from 5         # 从第 5 阶段开始
#   ./test.sh --list           # 列出所有测试项
#   ./test.sh --dry            # 干跑, 只打印不执行
#
# 测试阶段:
#   Phase 0  环境前置检查
#   Phase 1  exec_bt.sh 首次启动
#   Phase 2  基础设施验证
#   Phase 3  Dashboard & API 可达
#   Phase 4  分支生命周期 (添加→部署→激活→切换→回滚→删除)
#   Phase 5  Nginx 网关验证
#   Phase 6  幂等性 (重复启动)
#   Phase 7  混沌测试 (故障注入 + 恢复)
#   Phase 8  端到端 (公网可达)
#   Phase 9  清理
#
# 架构文档：doc/arch.exec-bt.md
# ══════════════════════════════════════════════════════════════════════════

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
BT_DIR="${REPO_ROOT}/branch-tester"
BT_API="http://localhost:9900/api"
GATEWAY="http://localhost:5500"
PID_FILE="${BT_DIR}/.bt/bt.pid"
STATE_FILE="${REPO_ROOT}/.bt/state.json"
TEST_BRANCH="master"  # 用于测试的分支

# ── 参数解析 ──
PHASE_ONLY=""
PHASE_FROM=0
DRY_RUN=false
LIST_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --phase)  shift; PHASE_ONLY="${1:-}"; shift 2>/dev/null || true ;;
    --from)   shift; PHASE_FROM="${1:-0}"; shift 2>/dev/null || true ;;
    --dry)    DRY_RUN=true ;;
    --list)   LIST_ONLY=true ;;
  esac
done

# fix: handle --phase N format
if [ -z "$PHASE_ONLY" ]; then
  for i in $(seq 1 $#); do
    arg="${!i}"
    if [ "$arg" = "--phase" ]; then
      next=$((i + 1))
      PHASE_ONLY="${!next:-}"
    elif [ "$arg" = "--from" ]; then
      next=$((i + 1))
      PHASE_FROM="${!next:-0}"
    fi
  done
fi

# ── Colors ──
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
# Overwrite current line
CR='\r\033[K'

# ── Counters ──
PASS=0; FAIL=0; SKIP=0; TOTAL=0
FAIL_LIST=""
# Per-phase counters
PHASE_PASS=0; PHASE_FAIL=0; PHASE_SKIP=0; PHASE_TOTAL=0
RUN_INDEX=0  # sequential counter across all tests

# ── Test Framework ──
current_phase=0
current_phase_name=""

# Progress bar: ████░░░░ 12/30 (40%)
progress_bar() {
  local done=$1 total=$2 width=20
  if [ "$total" -eq 0 ]; then return; fi
  local pct=$((done * 100 / total))
  local filled=$((done * width / total))
  local empty=$((width - filled))
  local bar=""
  for ((i=0; i<filled; i++)); do bar+="█"; done
  for ((i=0; i<empty; i++)); do bar+="░"; done
  echo -n "${bar} ${done}/${total} (${pct}%)"
}

# Phase summary line
phase_summary() {
  if [ "$PHASE_TOTAL" -eq 0 ]; then return; fi
  local phase_run=$((PHASE_PASS + PHASE_FAIL))
  if [ "$PHASE_FAIL" -eq 0 ] && [ "$phase_run" -gt 0 ]; then
    echo -e "  ${GREEN}  └─ ${PHASE_PASS}/${PHASE_TOTAL} passed ✓${NC}"
  elif [ "$PHASE_FAIL" -gt 0 ]; then
    echo -e "  ${RED}  └─ ${PHASE_PASS} passed, ${PHASE_FAIL} FAILED ✗${NC}"
  fi
}

phase() {
  # Print summary of PREVIOUS phase before starting new one
  if [ "$LIST_ONLY" != true ] && [ "$current_phase" -gt 0 ] || [ "$PHASE_TOTAL" -gt 0 ]; then
    phase_summary
  fi
  # Reset per-phase counters
  PHASE_PASS=0; PHASE_FAIL=0; PHASE_SKIP=0; PHASE_TOTAL=0

  current_phase=$1
  current_phase_name="$2"
  if [ "$LIST_ONLY" = true ]; then
    echo -e "\n${BOLD}Phase $1: $2${NC}"
    return
  fi
  if [ -n "$PHASE_ONLY" ] && [ "$PHASE_ONLY" != "$current_phase" ]; then return; fi
  if [ "$current_phase" -lt "$PHASE_FROM" ]; then return; fi
  echo ""
  echo -e "  ${BOLD}${CYAN}┌── Phase $1: $2 ──${NC}"
  echo -e "  ${CYAN}│${NC}"
}

should_run() {
  if [ -n "$PHASE_ONLY" ] && [ "$PHASE_ONLY" != "$current_phase" ]; then return 1; fi
  if [ "$current_phase" -lt "$PHASE_FROM" ]; then return 1; fi
  return 0
}

# Status line at end of each test showing overall progress
_status_line() {
  local executed=$((PASS + FAIL))
  # Only show if terminal is interactive
  if [ -t 1 ] && [ "$LIST_ONLY" != true ]; then
    echo -ne "  ${DIM}$(progress_bar $executed $TOTAL)  ${GREEN}${PASS}✓${NC} ${RED}${FAIL}✗${NC}${CR}" >&2
  fi
}

# Core test runner
_run_test() {
  local result_pass=$1; local id="$2"; local desc="$3"
  TOTAL=$((TOTAL + 1)); PHASE_TOTAL=$((PHASE_TOTAL + 1))
  RUN_INDEX=$((RUN_INDEX + 1))
  if [ "$result_pass" = "1" ]; then
    PASS=$((PASS + 1)); PHASE_PASS=$((PHASE_PASS + 1))
    echo -e "  ${CYAN}│${NC} ${GREEN}✓${NC} ${DIM}[${id}]${NC} $desc"
  else
    FAIL=$((FAIL + 1)); PHASE_FAIL=$((PHASE_FAIL + 1))
    echo -e "  ${CYAN}│${NC} ${RED}✗${NC} ${DIM}[${id}]${NC} $desc"
    FAIL_LIST="${FAIL_LIST}\n    [${id}] $desc"
  fi
  _status_line
}

# T <id> <description> <command...>
# 执行命令, 0=PASS, 非0=FAIL
T() {
  TOTAL=$((TOTAL + 1)); PHASE_TOTAL=$((PHASE_TOTAL + 1))
  local id="$1"; local desc="$2"; shift 2
  if [ "$LIST_ONLY" = true ]; then
    echo "  [$id] $desc"
    TOTAL=$((TOTAL - 1)); PHASE_TOTAL=$((PHASE_TOTAL - 1))
    return
  fi
  should_run || { SKIP=$((SKIP + 1)); PHASE_SKIP=$((PHASE_SKIP + 1)); TOTAL=$((TOTAL - 1)); PHASE_TOTAL=$((PHASE_TOTAL - 1)); return; }
  if [ "$DRY_RUN" = true ]; then
    echo -e "  ${CYAN}│${NC} ${DIM}[DRY] [$id] $desc${NC}"
    SKIP=$((SKIP + 1)); PHASE_SKIP=$((PHASE_SKIP + 1)); TOTAL=$((TOTAL - 1)); PHASE_TOTAL=$((PHASE_TOTAL - 1))
    return
  fi
  # Show "running..." indicator
  echo -ne "  ${CYAN}│${NC} ${DIM}⋯ [${id}] $desc${CR}" >&2
  local output
  output=$("$@" 2>&1)
  local rc=$?
  RUN_INDEX=$((RUN_INDEX + 1))
  if [ $rc -eq 0 ]; then
    echo -e "  ${CYAN}│${NC} ${GREEN}✓${NC} ${DIM}[${id}]${NC} $desc"
    PASS=$((PASS + 1)); PHASE_PASS=$((PHASE_PASS + 1))
  else
    echo -e "  ${CYAN}│${NC} ${RED}✗ [${id}]${NC} $desc"
    [ -n "$output" ] && echo -e "  ${CYAN}│${NC}   ${DIM}${output:0:200}${NC}"
    FAIL=$((FAIL + 1)); PHASE_FAIL=$((PHASE_FAIL + 1))
    FAIL_LIST="${FAIL_LIST}\n    [$id] $desc"
  fi
  _status_line
}

# T_NOT <id> <description> <command...>
# 执行命令, 非0=PASS, 0=FAIL (反向断言)
T_NOT() {
  TOTAL=$((TOTAL + 1)); PHASE_TOTAL=$((PHASE_TOTAL + 1))
  local id="$1"; local desc="$2"; shift 2
  if [ "$LIST_ONLY" = true ]; then
    echo "  [$id] $desc"
    TOTAL=$((TOTAL - 1)); PHASE_TOTAL=$((PHASE_TOTAL - 1))
    return
  fi
  should_run || { SKIP=$((SKIP + 1)); PHASE_SKIP=$((PHASE_SKIP + 1)); TOTAL=$((TOTAL - 1)); PHASE_TOTAL=$((PHASE_TOTAL - 1)); return; }
  if [ "$DRY_RUN" = true ]; then
    echo -e "  ${CYAN}│${NC} ${DIM}[DRY] [$id] $desc${NC}"
    SKIP=$((SKIP + 1)); PHASE_SKIP=$((PHASE_SKIP + 1)); TOTAL=$((TOTAL - 1)); PHASE_TOTAL=$((PHASE_TOTAL - 1))
    return
  fi
  echo -ne "  ${CYAN}│${NC} ${DIM}⋯ [${id}] $desc${CR}" >&2
  local output
  output=$("$@" 2>&1)
  local rc=$?
  RUN_INDEX=$((RUN_INDEX + 1))
  if [ $rc -ne 0 ]; then
    echo -e "  ${CYAN}│${NC} ${GREEN}✓${NC} ${DIM}[${id}]${NC} $desc"
    PASS=$((PASS + 1)); PHASE_PASS=$((PHASE_PASS + 1))
  else
    echo -e "  ${CYAN}│${NC} ${RED}✗ [${id}]${NC} $desc ${DIM}(expected fail, got success)${NC}"
    FAIL=$((FAIL + 1)); PHASE_FAIL=$((PHASE_FAIL + 1))
    FAIL_LIST="${FAIL_LIST}\n    [$id] $desc"
  fi
  _status_line
}

# T_MATCH <id> <description> <expected_pattern> <command...>
# 执行命令, stdout 匹配 grep pattern 则 PASS
T_MATCH() {
  TOTAL=$((TOTAL + 1)); PHASE_TOTAL=$((PHASE_TOTAL + 1))
  local id="$1"; local desc="$2"; local pattern="$3"; shift 3
  if [ "$LIST_ONLY" = true ]; then
    echo "  [$id] $desc"
    TOTAL=$((TOTAL - 1)); PHASE_TOTAL=$((PHASE_TOTAL - 1))
    return
  fi
  should_run || { SKIP=$((SKIP + 1)); PHASE_SKIP=$((PHASE_SKIP + 1)); TOTAL=$((TOTAL - 1)); PHASE_TOTAL=$((PHASE_TOTAL - 1)); return; }
  if [ "$DRY_RUN" = true ]; then
    echo -e "  ${CYAN}│${NC} ${DIM}[DRY] [$id] $desc${NC}"
    SKIP=$((SKIP + 1)); PHASE_SKIP=$((PHASE_SKIP + 1)); TOTAL=$((TOTAL - 1)); PHASE_TOTAL=$((PHASE_TOTAL - 1))
    return
  fi
  echo -ne "  ${CYAN}│${NC} ${DIM}⋯ [${id}] $desc${CR}" >&2
  local output
  output=$("$@" 2>&1)
  local rc=$?
  RUN_INDEX=$((RUN_INDEX + 1))
  if echo "$output" | grep -qE "$pattern"; then
    echo -e "  ${CYAN}│${NC} ${GREEN}✓${NC} ${DIM}[${id}]${NC} $desc"
    PASS=$((PASS + 1)); PHASE_PASS=$((PHASE_PASS + 1))
  else
    echo -e "  ${CYAN}│${NC} ${RED}✗ [${id}]${NC} $desc"
    echo -e "  ${CYAN}│${NC}   ${DIM}expected: /$pattern/${NC}"
    echo -e "  ${CYAN}│${NC}   ${DIM}got: ${output:0:200}${NC}"
    FAIL=$((FAIL + 1)); PHASE_FAIL=$((PHASE_FAIL + 1))
    FAIL_LIST="${FAIL_LIST}\n    [$id] $desc"
  fi
  _status_line
}

# T_HTTP <id> <description> <expected_status> <url> [curl_args...]
# curl 请求, HTTP status code 匹配则 PASS
T_HTTP() {
  TOTAL=$((TOTAL + 1)); PHASE_TOTAL=$((PHASE_TOTAL + 1))
  local id="$1"; local desc="$2"; local expected="$3"; local url="$4"; shift 4
  if [ "$LIST_ONLY" = true ]; then
    echo "  [$id] $desc"
    TOTAL=$((TOTAL - 1)); PHASE_TOTAL=$((PHASE_TOTAL - 1))
    return
  fi
  should_run || { SKIP=$((SKIP + 1)); PHASE_SKIP=$((PHASE_SKIP + 1)); TOTAL=$((TOTAL - 1)); PHASE_TOTAL=$((PHASE_TOTAL - 1)); return; }
  if [ "$DRY_RUN" = true ]; then
    echo -e "  ${CYAN}│${NC} ${DIM}[DRY] [$id] $desc${NC}"
    SKIP=$((SKIP + 1)); PHASE_SKIP=$((PHASE_SKIP + 1)); TOTAL=$((TOTAL - 1)); PHASE_TOTAL=$((PHASE_TOTAL - 1))
    return
  fi
  echo -ne "  ${CYAN}│${NC} ${DIM}⋯ [${id}] $desc${CR}" >&2
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$@" "$url" 2>/dev/null)
  RUN_INDEX=$((RUN_INDEX + 1))
  if [ "$status" = "$expected" ]; then
    echo -e "  ${CYAN}│${NC} ${GREEN}✓${NC} ${DIM}[${id}]${NC} $desc ${DIM}(HTTP $status)${NC}"
    PASS=$((PASS + 1)); PHASE_PASS=$((PHASE_PASS + 1))
  else
    echo -e "  ${CYAN}│${NC} ${RED}✗ [${id}]${NC} $desc ${DIM}(expected HTTP $expected, got $status)${NC}"
    FAIL=$((FAIL + 1)); PHASE_FAIL=$((PHASE_FAIL + 1))
    FAIL_LIST="${FAIL_LIST}\n    [$id] $desc"
  fi
  _status_line
}

# T_WAIT <id> <description> <max_seconds> <command...>
# 反复执行直到成功, 最多 N 秒 (带动画)
T_WAIT() {
  TOTAL=$((TOTAL + 1)); PHASE_TOTAL=$((PHASE_TOTAL + 1))
  local id="$1"; local desc="$2"; local max="$3"; shift 3
  if [ "$LIST_ONLY" = true ]; then
    echo "  [$id] $desc (wait ≤${max}s)"
    TOTAL=$((TOTAL - 1)); PHASE_TOTAL=$((PHASE_TOTAL - 1))
    return
  fi
  should_run || { SKIP=$((SKIP + 1)); PHASE_SKIP=$((PHASE_SKIP + 1)); TOTAL=$((TOTAL - 1)); PHASE_TOTAL=$((PHASE_TOTAL - 1)); return; }
  if [ "$DRY_RUN" = true ]; then
    echo -e "  ${CYAN}│${NC} ${DIM}[DRY] [$id] $desc${NC}"
    SKIP=$((SKIP + 1)); PHASE_SKIP=$((PHASE_SKIP + 1)); TOTAL=$((TOTAL - 1)); PHASE_TOTAL=$((PHASE_TOTAL - 1))
    return
  fi
  local i=0
  local spinner=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  while [ "$i" -lt "$max" ]; do
    if "$@" >/dev/null 2>&1; then
      echo -ne "${CR}" >&2
      echo -e "  ${CYAN}│${NC} ${GREEN}✓${NC} ${DIM}[${id}]${NC} $desc ${DIM}(${i}s)${NC}"
      PASS=$((PASS + 1)); PHASE_PASS=$((PHASE_PASS + 1))
      RUN_INDEX=$((RUN_INDEX + 1))
      _status_line
      return
    fi
    local si=$((i % ${#spinner[@]}))
    echo -ne "  ${CYAN}│${NC} ${YELLOW}${spinner[$si]}${NC} ${DIM}[${id}] $desc (${i}/${max}s)${CR}" >&2
    sleep 1
    i=$((i + 1))
  done
  echo -ne "${CR}" >&2
  echo -e "  ${CYAN}│${NC} ${RED}✗ [${id}]${NC} $desc ${DIM}(timeout ${max}s)${NC}"
  FAIL=$((FAIL + 1)); PHASE_FAIL=$((PHASE_FAIL + 1))
  FAIL_LIST="${FAIL_LIST}\n    [$id] $desc"
  RUN_INDEX=$((RUN_INDEX + 1))
  _status_line
}

# ── Phase action message (indented under phase) ──
msg() {
  should_run || return
  [ "$LIST_ONLY" = true ] && return
  [ "$DRY_RUN" = true ] && return
  echo -e "  ${CYAN}│${NC} ${DIM}$1${NC}"
}

# Helper: get BT auth token (if auth is enabled)
BT_TOKEN=""
bt_auth_header() {
  if [ -n "$BT_TOKEN" ]; then
    echo "-H" "x-bt-token: $BT_TOKEN"
  fi
}

# Helper: curl BT API with auth
bt_curl() {
  local method="$1"; local path="$2"; shift 2
  if [ -n "$BT_TOKEN" ]; then
    curl -s -X "$method" -H "x-bt-token: $BT_TOKEN" -H "Content-Type: application/json" "$@" "${BT_API}${path}"
  else
    curl -s -X "$method" -H "Content-Type: application/json" "$@" "${BT_API}${path}"
  fi
}

# Helper: curl BT API with SSE (returns full output)
bt_curl_sse() {
  local method="$1"; local path="$2"; shift 2
  if [ -n "$BT_TOKEN" ]; then
    curl -s -X "$method" -H "x-bt-token: $BT_TOKEN" -H "Content-Type: application/json" -H "Accept: text/event-stream" --max-time 300 "$@" "${BT_API}${path}"
  else
    curl -s -X "$method" -H "Content-Type: application/json" -H "Accept: text/event-stream" --max-time 300 "$@" "${BT_API}${path}"
  fi
}

# ══════════════════════════════════════════════════════════════════════════
# HEADER
# ══════════════════════════════════════════════════════════════════════════
echo ""
echo -e "  ${BOLD}${CYAN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "  ${BOLD}${CYAN}║  PRD Agent Branch-Tester 全量验收测试             ║${NC}"
echo -e "  ${BOLD}${CYAN}║  $(date '+%Y-%m-%d %H:%M:%S')                            ║${NC}"
echo -e "  ${BOLD}${CYAN}╚══════════════════════════════════════════════════╝${NC}"

# ══════════════════════════════════════════════════════════════════════════
# Phase 0: 环境前置检查
# ══════════════════════════════════════════════════════════════════════════
phase 0 "环境前置检查"

T "E01" "docker daemon 可达"              docker info
T "E02" "docker compose 可用"             docker compose version
T "E03" "Node.js >= 20"                   node -e "process.exit(parseInt(process.version.slice(1))>=20?0:1)"
T "E04" "pnpm 可用"                       pnpm -v
T "E05" "git 可用"                        git --version
T "E06" "curl 可用"                       curl --version
T "E07" "ss 可用"                         ss --version
T "E08" "仓库根目录正确"                  test -f "$REPO_ROOT/docker-compose.yml"
T "E09" "exec_bt.sh 存在且可执行"         test -x "$REPO_ROOT/exec_bt.sh"
T "E10" "branch-tester 目录存在"          test -d "$BT_DIR"
T "E11" "_disconnected.conf 存在"         test -f "$REPO_ROOT/deploy/nginx/conf.d/branches/_disconnected.conf"
T "E12" "docker-compose.yml 包含 gateway" grep -q "gateway" "$REPO_ROOT/docker-compose.yml"
T "E13" "测试分支 ($TEST_BRANCH) 存在"    git rev-parse --verify "$TEST_BRANCH"

# ══════════════════════════════════════════════════════════════════════════
# Phase 1: exec_bt.sh 首次启动
# ══════════════════════════════════════════════════════════════════════════
phase 1 "exec_bt.sh 首次启动"

if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  msg "启动 exec_bt.sh -d (后台模式)..."
  cd "$REPO_ROOT"
  export ROOT_ACCESS_USERNAME="admin"
  export ROOT_ACCESS_PASSWORD="TestPass123!"

  EXEC_OUTPUT=$(./exec_bt.sh -d 2>&1) || true
  EXEC_RC=$?
  msg "exec_bt.sh 返回码: $EXEC_RC"
fi

T "S01" "exec_bt.sh 返回码 0"                     test "${EXEC_RC:-1}" -eq 0
T_MATCH "S02" "输出包含 Done"                      "Done" echo "${EXEC_OUTPUT:-}"
T_MATCH "S03" "输出包含 Dashboard 地址"            "9900" echo "${EXEC_OUTPUT:-}"
T_MATCH "S04" "输出包含 Login 凭据"                "admin" echo "${EXEC_OUTPUT:-}"
T "S05" "PID file 已创建"                          test -f "$PID_FILE"

msg "等待 Branch-Tester 启动..."

T_WAIT "S06" "BT :9900 可达"  30  curl -sf --max-time 3 http://localhost:9900
T_WAIT "S07" "BT API 可达"    10  curl -sf --max-time 3 "${BT_API}/branches"

# ══════════════════════════════════════════════════════════════════════════
# Phase 2: 基础设施验证
# ══════════════════════════════════════════════════════════════════════════
phase 2 "基础设施验证"

# 2.1 Docker 容器
T "I01" "prdagent-network 存在"                    docker network inspect prdagent-network
T_MATCH "I02" "prdagent-mongodb running"           "true" docker inspect --format='{{.State.Running}}' prdagent-mongodb
T_MATCH "I03" "prdagent-redis running"             "true" docker inspect --format='{{.State.Running}}' prdagent-redis
T_MATCH "I04" "prdagent-gateway running"           "true" docker inspect --format='{{.State.Running}}' prdagent-gateway

# 2.2 prdagent-api 不应在运行 (S1 场景)
T_NOT "I05" "prdagent-api 未运行 (BT 接管)"       sh -c "docker inspect --format='{{.State.Running}}' prdagent-api 2>/dev/null | grep -q true"

# 2.3 端口占用
T_MATCH "I06" ":5500 listening"                    ":5500" ss -tlnp
T_MATCH "I07" ":9900 listening"                    ":9900" ss -tlnp

# 2.4 Gateway 内部 nginx
T "I08" "gateway nginx -t 通过"                    docker exec prdagent-gateway nginx -t

# 2.5 Gateway default.conf 是 symlink (非静态文件)
T "I09" "gateway default.conf 是 symlink"          test -L "$REPO_ROOT/deploy/nginx/conf.d/default.conf"

# 2.6 MongoDB 连通性
T "I10" "MongoDB 可连接"                           docker exec prdagent-mongodb mongosh --quiet --eval "db.runCommand({ping:1})"

# 2.7 Redis 连通性
T "I11" "Redis 可连接"                             docker exec prdagent-redis redis-cli ping

# 2.8 Gateway :5500 HTTP 响应
T_HTTP "I12" "gateway :5500 返回 HTTP 响应"        "502" "http://localhost:5500/api/health"

# ══════════════════════════════════════════════════════════════════════════
# Phase 3: Dashboard & API 可达性
# ══════════════════════════════════════════════════════════════════════════
phase 3 "Dashboard & API 可达性"

# 3.1 Dashboard 静态页面
T_HTTP "D01" "Dashboard 首页 200"                  "200" "http://localhost:9900"

# 3.2 API 端点
T_HTTP "D02" "GET /api/branches 200"               "200" "${BT_API}/branches"
T_HTTP "D03" "GET /api/config 200"                 "200" "${BT_API}/config"
T_HTTP "D04" "GET /api/history 200"                "200" "${BT_API}/history"
T_HTTP "D05" "GET /api/remote-branches 200"        "200" "${BT_API}/remote-branches"
T_HTTP "D06" "GET /api/nginx-config 200"           "200" "${BT_API}/nginx-config"

# 3.3 API 响应格式
T_MATCH "D07" "/api/branches 返回 JSON"            '"branches"' bt_curl GET /branches
T_MATCH "D08" "/api/config 返回 gateway 配置"      '"gateway"' bt_curl GET /config
T_MATCH "D09" "/api/history 返回数组"              '"history"' bt_curl GET /history

# 3.4 无效端点
T_HTTP "D10" "GET /api/nonexistent 404"            "404" "${BT_API}/nonexistent"

# ══════════════════════════════════════════════════════════════════════════
# Phase 4: 分支生命周期
# 分支生命周期: 添加 → 部署(build+start+activate) → 验证 → 切换 → 回滚 → 删除
# ══════════════════════════════════════════════════════════════════════════
phase 4 "分支生命周期"

# ── 4.1 添加分支 ──
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  msg "── 4.1 添加分支 ──"
  ADD_RESULT=$(bt_curl POST /branches -d "{\"branch\":\"$TEST_BRANCH\"}" 2>&1)
  ADD_STATUS=$?
fi

T_MATCH "B01" "添加分支成功"                       "branch|already" echo "${ADD_RESULT:-error}"

# 获取分支 ID (slugified)
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  BRANCH_ID=$(echo "$ADD_RESULT" | node -e "
    const d=require('fs').readFileSync('/dev/stdin','utf8');
    try { const j=JSON.parse(d); console.log(j.branch?.id || '$TEST_BRANCH'); }
    catch(e) { console.log('$TEST_BRANCH'); }
  " 2>/dev/null || echo "$TEST_BRANCH")
  msg "分支 ID: $BRANCH_ID"
fi

# 验证分支出现在列表
T_MATCH "B02" "分支出现在 /api/branches"           "${BRANCH_ID:-$TEST_BRANCH}" bt_curl GET /branches

# 验证 state.json 更新
T "B03" "state.json 已更新"                        test -f "$STATE_FILE"
T_MATCH "B04" "state.json 包含分支"                "${BRANCH_ID:-$TEST_BRANCH}" cat "$STATE_FILE"

# ── 4.2 一键部署 (build + start + activate) ──
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  msg "── 4.2 一键部署 (build→start→activate, 可能需要数分钟) ──"
  DEPLOY_OUTPUT=$(bt_curl_sse POST "/branches/${BRANCH_ID:-$TEST_BRANCH}/deploy" 2>&1)
  DEPLOY_RC=$?
  msg "部署返回码: $DEPLOY_RC"
fi

T_MATCH "B05" "部署流包含 complete"                "complete" echo "${DEPLOY_OUTPUT:-}"

# 等待容器启动
T_WAIT "B06" "分支容器 running" 30 docker inspect --format='{{.State.Running}}' "prdagent-api-${BRANCH_ID:-$TEST_BRANCH}"

# 验证激活状态
T_MATCH "B07" "分支已激活"                         "\"activeBranchId\":\"${BRANCH_ID:-$TEST_BRANCH}\"" bt_curl GET /branches

# 验证 gateway 路由
T_WAIT "B08" "gateway /api/health 可达" 15 curl -sf --max-time 5 "http://localhost:5500/api/health"

# 验证 gateway nginx config 指向分支
T_MATCH "B09" "nginx config 包含分支上游"          "prdagent-api-${BRANCH_ID:-$TEST_BRANCH}" bt_curl GET /nginx-config

# ── 4.3 网关断开 ──
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  msg "── 4.3 网关断开 ──"
  bt_curl POST /gateway/disconnect >/dev/null 2>&1
  sleep 1
fi

T_HTTP "B10" "断开后 /api/ 返回 502"               "502" "http://localhost:5500/api/health"
T_MATCH "B11" "断开后 activeBranchId 为 null"      '"activeBranchId":null' bt_curl GET /branches

# ── 4.4 重新激活 ──
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  msg "── 4.4 重新激活 ──"
  bt_curl POST "/branches/${BRANCH_ID:-$TEST_BRANCH}/activate" >/dev/null 2>&1
  sleep 2
fi

T_WAIT "B12" "重新激活后 gateway 可达" 10 curl -sf --max-time 5 "http://localhost:5500/api/health"

# ── 4.5 拉取代码 ──
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  msg "── 4.5 拉取代码 ──"
  PULL_RESULT=$(bt_curl POST "/branches/${BRANCH_ID:-$TEST_BRANCH}/pull" 2>&1)
fi

T_MATCH "B13" "拉取代码成功"                       "success|updated|before" echo "${PULL_RESULT:-error}"

# ── 4.6 操作日志 ──
T_MATCH "B14" "操作日志可查"                       "logs" bt_curl GET "/branches/${BRANCH_ID:-$TEST_BRANCH}/logs"

# ── 4.7 停止分支 ──
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  msg "── 4.7 停止分支 ──"
  bt_curl POST "/branches/${BRANCH_ID:-$TEST_BRANCH}/stop" >/dev/null 2>&1
  sleep 2
fi

T_NOT "B15" "容器已停止"                           docker inspect --format='{{.State.Running}}' "prdagent-api-${BRANCH_ID:-$TEST_BRANCH}"

# ── 4.8 分支状态重置 ──
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  msg "── 4.8 重置分支状态 ──"
  bt_curl POST "/branches/${BRANCH_ID:-$TEST_BRANCH}/reset" >/dev/null 2>&1
fi

T_MATCH "B16" "分支状态已重置"                     "idle|success" bt_curl GET /branches

# ── 4.9 删除分支 ──
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  msg "── 4.9 删除分支 ──"
  DEL_OUTPUT=$(bt_curl_sse DELETE "/branches/${BRANCH_ID:-$TEST_BRANCH}" 2>&1)
  DEL_RC=$?
  sleep 2
fi

T_MATCH "B17" "删除流包含 complete"                "complete" echo "${DEL_OUTPUT:-}"
T_NOT "B18" "分支不再出现在列表"                   echo "${BRANCH_ID:-$TEST_BRANCH}" | grep -q "$(bt_curl GET /branches 2>/dev/null | node -e "
  const d=require('fs').readFileSync('/dev/stdin','utf8');
  try { const j=JSON.parse(d); console.log(Object.keys(j.branches||{}).join(',')); }
  catch(e) { console.log(''); }
" 2>/dev/null)"

# ══════════════════════════════════════════════════════════════════════════
# Phase 5: Nginx 网关验证
# ══════════════════════════════════════════════════════════════════════════
phase 5 "Nginx 网关验证"

# 5.1 Host Nginx 状态
if should_run && [ "$LIST_ONLY" != true ]; then
  HAS_HOST_NGINX=false
  command -v nginx >/dev/null 2>&1 && HAS_HOST_NGINX=true
fi

if [ "${HAS_HOST_NGINX:-false}" = true ]; then
  T "N01" "Host nginx running"                     sh -c "systemctl is-active --quiet nginx 2>/dev/null || pgrep -x nginx >/dev/null 2>&1"
  T "N02" "nginx -t 通过"                          nginx -t
  T "N03" "prdagent-app.conf 存在"                 test -f /etc/nginx/sites-available/prdagent-app.conf -o -f /etc/nginx/conf.d/prdagent-app.conf
  T_HTTP "N04" "Host :80 可达"                     "502" "http://localhost:80/api/health"
  T_MATCH "N05" "prdagent-app.conf 指向 :5500"     "5500" cat /etc/nginx/sites-available/prdagent-app.conf 2>/dev/null || cat /etc/nginx/conf.d/prdagent-app.conf 2>/dev/null
else
  # nginx 不存在时跳过这些测试
  for id in N01 N02 N03 N04 N05; do
    TOTAL=$((TOTAL + 1)); SKIP=$((SKIP + 1))
    if [ "$LIST_ONLY" != true ] && should_run; then
      echo -e "  ${CYAN}│${NC} ${YELLOW}⊘${NC} ${DIM}[$id]${NC} (nginx not installed, skipped)"
    elif [ "$LIST_ONLY" = true ]; then
      echo "  [$id] (requires host nginx)"
    fi
  done
fi

# 5.2 Gateway 内部 symlink 机制
T "N06" "branches/ 目录存在"                       test -d "$REPO_ROOT/deploy/nginx/conf.d/branches"
T "N07" "_disconnected.conf 存在"                  test -f "$REPO_ROOT/deploy/nginx/conf.d/branches/_disconnected.conf"
T_MATCH "N08" "_disconnected.conf 返回 502 JSON"   '502.*No active branch' cat "$REPO_ROOT/deploy/nginx/conf.d/branches/_disconnected.conf"

# 5.3 断开 gateway 后验证
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  bt_curl POST /gateway/disconnect >/dev/null 2>&1
  sleep 1
fi

T "N09" "断开后 default.conf → _disconnected"      readlink "$REPO_ROOT/deploy/nginx/conf.d/default.conf" 2>/dev/null | grep -q "_disconnected"
T_HTTP "N10" "断开后 /api/ 返回 502"               "502" "http://localhost:5500/api/anything"

# ══════════════════════════════════════════════════════════════════════════
# Phase 6: 幂等性测试
# ══════════════════════════════════════════════════════════════════════════
phase 6 "幂等性 (重复启动)"

if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  msg "记录当前状态..."
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || echo "none")
  OLD_MONGO_ID=$(docker inspect --format='{{.Id}}' prdagent-mongodb 2>/dev/null | head -c 12)
  OLD_REDIS_ID=$(docker inspect --format='{{.Id}}' prdagent-redis 2>/dev/null | head -c 12)
  OLD_GATEWAY_ID=$(docker inspect --format='{{.Id}}' prdagent-gateway 2>/dev/null | head -c 12)

  msg "重新运行 exec_bt.sh -d..."
  cd "$REPO_ROOT"
  IDEM_OUTPUT=$(./exec_bt.sh -d 2>&1) || true
  IDEM_RC=$?
fi

T "R01" "重复执行 exec_bt.sh 返回 0"              test "${IDEM_RC:-1}" -eq 0

# 等待新 BT 启动
T_WAIT "R02" "新 BT :9900 可达" 30 curl -sf --max-time 3 http://localhost:9900

# PID 应该变了 (旧的被替换)
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  NEW_PID=$(cat "$PID_FILE" 2>/dev/null || echo "none")
fi
T "R03" "PID 已更新 (旧实例被替换)"               test "${NEW_PID:-none}" != "${OLD_PID:-none}"

# 基础设施容器应该还是同一个 (幂等, 不重建)
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  NEW_MONGO_ID=$(docker inspect --format='{{.Id}}' prdagent-mongodb 2>/dev/null | head -c 12)
  NEW_REDIS_ID=$(docker inspect --format='{{.Id}}' prdagent-redis 2>/dev/null | head -c 12)
  NEW_GATEWAY_ID=$(docker inspect --format='{{.Id}}' prdagent-gateway 2>/dev/null | head -c 12)
fi

T "R04" "MongoDB 容器未重建 (幂等)"               test "${NEW_MONGO_ID:-x}" = "${OLD_MONGO_ID:-y}"
T "R05" "Redis 容器未重建 (幂等)"                  test "${NEW_REDIS_ID:-x}" = "${OLD_REDIS_ID:-y}"
T "R06" "Gateway 容器未重建 (幂等)"                test "${NEW_GATEWAY_ID:-x}" = "${OLD_GATEWAY_ID:-y}"

# API 仍然可用
T_WAIT "R07" "BT API 仍然可用" 10 curl -sf --max-time 3 "${BT_API}/branches"

# ══════════════════════════════════════════════════════════════════════════
# Phase 7: 混沌测试 (故障注入 + 恢复)
# ══════════════════════════════════════════════════════════════════════════
phase 7 "混沌测试 (故障注入)"

# ── 7.1 Kill BT 进程 → 重启恢复 ──
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  msg "── 7.1 Kill -9 BT 进程 ──"
  CHAOS_PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$CHAOS_PID" ]; then
    kill -9 "$CHAOS_PID" 2>/dev/null || true
    sleep 2
  fi
fi

T_NOT "C01" "BT 进程已死"                         curl -sf --max-time 2 http://localhost:9900

if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  msg "重新启动 exec_bt.sh -d..."
  cd "$REPO_ROOT"
  CHAOS_OUTPUT=$(./exec_bt.sh -d 2>&1) || true
fi

T_WAIT "C02" "Kill 后重启成功"  30  curl -sf --max-time 3 http://localhost:9900
T_WAIT "C03" "API 恢复"        10  curl -sf --max-time 3 "${BT_API}/branches"

# ── 7.2 损坏 state.json → 自动恢复 ──
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  msg "── 7.2 损坏 state.json ──"
  # 先停 BT
  ./exec_bt.sh --stop <<< "n" 2>/dev/null || true
  sleep 2

  # 写入损坏的 JSON
  if [ -f "$STATE_FILE" ]; then
    cp "$STATE_FILE" "${STATE_FILE}.test-backup"
    echo '{"broken": tru' > "$STATE_FILE"
  fi

  msg "损坏的 state.json 已写入"

  # 重启
  cd "$REPO_ROOT"
  CORRUPT_OUTPUT=$(./exec_bt.sh -d 2>&1) || true
fi

T_MATCH "C04" "检测到损坏并警告"                   "corrupt|backing" echo "${CORRUPT_OUTPUT:-}"
T_WAIT "C05" "损坏后仍能启动"   30  curl -sf --max-time 3 http://localhost:9900

# 恢复原始 state.json
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  if [ -f "${STATE_FILE}.test-backup" ]; then
    # BT 已经在跑了, state.json 已被 BT 重建, 不需要恢复
    rm -f "${STATE_FILE}.test-backup"
  fi
fi

# ── 7.3 PID Reuse 模拟 ──
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  msg "── 7.3 PID Reuse 模拟 ──"
  # 停掉 BT
  ./exec_bt.sh --stop <<< "n" 2>/dev/null || true
  sleep 2

  # 把 PID file 写成 init 进程的 PID (PID 1, 绝对不是 BT)
  mkdir -p "$(dirname "$PID_FILE")"
  echo "1" > "$PID_FILE"

  msg "PID file 已伪造为 PID 1"

  # 重启 - 应该不会 kill PID 1
  cd "$REPO_ROOT"
  PID_REUSE_OUTPUT=$(./exec_bt.sh -d 2>&1) || true
fi

T_MATCH "C06" "检测到 PID reuse, 跳过 kill"       "NOT branch-tester\|PID reuse\|Skipping" echo "${PID_REUSE_OUTPUT:-}"
T_WAIT "C07" "PID reuse 后仍能启动"  30  curl -sf --max-time 3 http://localhost:9900

# 验证 PID 1 仍然存活 (没被误杀)
T "C08" "PID 1 (init) 未被误杀"                   kill -0 1

# ── 7.4 Gateway default.conf 为静态文件 (独立部署残留模拟) ──
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  msg "── 7.4 Gateway default.conf 静态文件模拟 ──"
  GW_CONF="$REPO_ROOT/deploy/nginx/conf.d/default.conf"

  # 停 BT
  ./exec_bt.sh --stop <<< "n" 2>/dev/null || true
  sleep 2

  # 备份当前 symlink, 替换为静态文件
  if [ -L "$GW_CONF" ]; then
    GW_LINK_TARGET=$(readlink "$GW_CONF")
    rm -f "$GW_CONF"
    cat > "$GW_CONF" <<'STATIC_CONF'
server {
    listen 80;
    location /api/ {
        proxy_pass http://prdagent-api:8080;
    }
    location / {
        try_files $uri /index.html;
    }
}
STATIC_CONF
    msg "default.conf 已替换为静态文件 (模拟独立部署残留)"
  fi

  # 重启
  cd "$REPO_ROOT"
  STATIC_CONF_OUTPUT=$(./exec_bt.sh -d 2>&1) || true
fi

T_MATCH "C09" "检测到静态 default.conf"            "standalone.*disconnected\|prevents 502" echo "${STATIC_CONF_OUTPUT:-}"
T "C10" "修复后 default.conf 是 symlink"           test -L "$REPO_ROOT/deploy/nginx/conf.d/default.conf"
T_WAIT "C11" "修复后 BT 可用"     30  curl -sf --max-time 3 http://localhost:9900

# ── 7.5 端口 9900 被占用 ──
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  msg "── 7.5 端口 9900 占用测试 ──"
  # 停 BT
  ./exec_bt.sh --stop <<< "n" 2>/dev/null || true
  sleep 2

  # 用 python 占住 9900
  python3 -c "
import socket, time, threading
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('0.0.0.0', 9900)); s.listen(1)
time.sleep(15)
s.close()
" &
  PORT_BLOCKER_PID=$!
  sleep 1

  # 尝试启动 BT (应该检测到冲突)
  cd "$REPO_ROOT"
  PORT_BLOCK_OUTPUT=$(./exec_bt.sh -d 2>&1) || true
  PORT_BLOCK_RC=$?

  # 清理
  kill "$PORT_BLOCKER_PID" 2>/dev/null || true
  wait "$PORT_BLOCKER_PID" 2>/dev/null || true
  sleep 1
fi

T_MATCH "C12" ":9900 被占用时有警告"               "occupied\|9900" echo "${PORT_BLOCK_OUTPUT:-}"

# 清理后正常启动
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  cd "$REPO_ROOT"
  ./exec_bt.sh -d >/dev/null 2>&1 || true
fi

T_WAIT "C13" "端口释放后恢复"    30  curl -sf --max-time 3 http://localhost:9900

# ── 7.6 --test 自检命令 ──
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  msg "── 7.6 exec_bt.sh --test 自检 ──"
  cd "$REPO_ROOT"
  SELFTEST_OUTPUT=$(./exec_bt.sh --test 2>&1) || true
  SELFTEST_RC=$?
fi

T_MATCH "C14" "--test 输出包含测试结果"            "PASSED\|passed" echo "${SELFTEST_OUTPUT:-}"

# ── 7.7 --status 状态命令 ──
if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  msg "── 7.7 exec_bt.sh --status ──"
  cd "$REPO_ROOT"
  STATUS_OUTPUT=$(./exec_bt.sh --status 2>&1) || true
fi

T_MATCH "C15" "--status 显示 BT running"           "running" echo "${STATUS_OUTPUT:-}"
T_MATCH "C16" "--status 显示端口状态"              "listening\|:5500\|:9900" echo "${STATUS_OUTPUT:-}"

# ══════════════════════════════════════════════════════════════════════════
# Phase 8: 端到端 (公网可达)
# ══════════════════════════════════════════════════════════════════════════
phase 8 "端到端 (公网可达)"

if should_run && [ "$LIST_ONLY" != true ] && [ "$DRY_RUN" != true ]; then
  PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || curl -s --max-time 5 ipinfo.io/ip 2>/dev/null || echo "")
fi

if [ -n "${PUBLIC_IP:-}" ]; then
  T_HTTP "P01" "公网 :80 可达 ($PUBLIC_IP)"        "200" "http://${PUBLIC_IP}" -sf
  T_HTTP "P02" "公网 :9900 可达 ($PUBLIC_IP)"      "200" "http://${PUBLIC_IP}:9900" -sf
else
  for id in P01 P02; do
    TOTAL=$((TOTAL + 1)); SKIP=$((SKIP + 1))
    if [ "$LIST_ONLY" != true ] && should_run; then
      echo -e "  ${CYAN}│${NC} ${YELLOW}⊘${NC} ${DIM}[$id]${NC} (无法获取公网 IP, skipped)"
    elif [ "$LIST_ONLY" = true ]; then
      echo "  [$id] (requires public IP)"
    fi
  done
fi

# 本地端到端: 完整的请求链路
T_HTTP "P03" "localhost:5500 → gateway 可达"       "502" "http://localhost:5500/api/health"
T_HTTP "P04" "localhost:9900 → dashboard 可达"     "200" "http://localhost:9900"

# ══════════════════════════════════════════════════════════════════════════
# Phase 9: 清理
# ══════════════════════════════════════════════════════════════════════════
phase 9 "清理"

msg "保持 BT 运行 (不自动清理)"
msg "如需停止: ./exec_bt.sh --stop"

T "X01" "BT 仍在运行"                             curl -sf --max-time 3 http://localhost:9900
T "X02" "基础设施仍在运行"                         docker inspect --format='{{.State.Running}}' prdagent-mongodb

# Final phase summary
phase_summary

# ══════════════════════════════════════════════════════════════════════════
# REPORT
# ══════════════════════════════════════════════════════════════════════════
if [ "$LIST_ONLY" = true ]; then
  echo ""
  echo -e "  ${BOLD}共 $TOTAL 项测试${NC}"
  echo ""
  exit 0
fi

# Clear progress line
echo -ne "${CR}" >&2

echo ""
echo -e "  ${BOLD}${CYAN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "  ${BOLD}${CYAN}║  测试报告                                       ║${NC}"
echo -e "  ${BOLD}${CYAN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

EXECUTED=$((PASS + FAIL))
echo -e "  总计:   ${BOLD}$TOTAL${NC}"
echo -e "  执行:   ${BOLD}$EXECUTED${NC}"
echo -e "  通过:   ${GREEN}${BOLD}$PASS${NC}"
echo -e "  失败:   ${RED}${BOLD}$FAIL${NC}"
echo -e "  跳过:   ${YELLOW}${BOLD}$SKIP${NC}"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "  ${RED}${BOLD}失败项:${NC}"
  echo -e "$FAIL_LIST"
  echo ""
fi

if [ "$FAIL" -eq 0 ] && [ "$EXECUTED" -gt 0 ]; then
  echo -e "  ${GREEN}${BOLD}╔══════════════════════════════════════╗${NC}"
  echo -e "  ${GREEN}${BOLD}║  ALL $EXECUTED TESTS PASSED ✓          ║${NC}"
  echo -e "  ${GREEN}${BOLD}╚══════════════════════════════════════╝${NC}"
elif [ "$FAIL" -gt 0 ]; then
  echo -e "  ${RED}${BOLD}╔══════════════════════════════════════╗${NC}"
  echo -e "  ${RED}${BOLD}║  $FAIL TESTS FAILED ✗                 ║${NC}"
  echo -e "  ${RED}${BOLD}╚══════════════════════════════════════╝${NC}"
fi
echo ""

# 返回码: 有失败则 1
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
