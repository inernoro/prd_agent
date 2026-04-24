#!/usr/bin/env bash
# ============================================
# 冒烟测试共享库 (scripts/smoke-lib.sh)
# ============================================
#
# 目的: 为 smoke-*.sh 脚本提供统一的 HTTP/断言/日志辅助函数,
# 避免每个 Agent 的冒烟脚本重复造轮子。所有函数均 POSIX bash,
# 依赖 curl + jq (脚本启动时检查)。
#
# 环境变量:
#   SMOKE_TEST_HOST  目标服务根 URL (默认 http://localhost:5000)
#   AI_ACCESS_KEY    必填; prd-api AiAccessKeyAuthenticationHandler 校验
#   SMOKE_USER       被假冒的用户 login (默认 admin)
#   SMOKE_VERBOSE    非空时打印完整 curl 响应体 (默认只打印断言摘要)
#   SMOKE_TIMEOUT    单次 curl 超时秒数 (默认 20)
#
# 使用方式:
#   #!/usr/bin/env bash
#   set -euo pipefail
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   # shellcheck source=smoke-lib.sh
#   source "$SCRIPT_DIR/smoke-lib.sh"
#
#   smoke_init "PRD Agent"
#   resp=$(smoke_post /api/v1/groups '{"groupName":"smoke"}')
#   group_id=$(smoke_get_data "$resp" .id)
#   smoke_assert_nonempty "$group_id" "groupId"
#   smoke_done
# ============================================

# --- 依赖检查 ------------------------------------------------------

smoke_require_tools() {
  for bin in curl jq; do
    if ! command -v "$bin" >/dev/null 2>&1; then
      printf '[smoke-lib] 缺少依赖: %s\n' "$bin" >&2
      printf '[smoke-lib] Ubuntu: sudo apt-get install -y %s\n' "$bin" >&2
      printf '[smoke-lib] macOS:  brew install %s\n' "$bin" >&2
      exit 2
    fi
  done
}

# --- 配置 ----------------------------------------------------------

SMOKE_HOST="${SMOKE_TEST_HOST:-http://localhost:5000}"
SMOKE_USER="${SMOKE_USER:-admin}"
SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-20}"
SMOKE_VERBOSE="${SMOKE_VERBOSE:-}"

# smoke_init runs auth+tool checks and prints a banner. Pass the human
# name of the Agent being smoked so logs say "冒烟测试: PRD Agent".
smoke_init() {
  local agent_name="${1:-Smoke}"
  smoke_require_tools
  if [[ -z "${AI_ACCESS_KEY:-}" ]]; then
    printf '[smoke-lib] 必须设置环境变量 AI_ACCESS_KEY (prd-api X-AI-Access-Key header)\n' >&2
    exit 2
  fi
  SMOKE_AUTH=(
    -H "X-AI-Access-Key: $AI_ACCESS_KEY"
    -H "X-AI-Impersonate: $SMOKE_USER"
    -H "Content-Type: application/json"
    -H "Accept: application/json"
  )
  SMOKE_AGENT_NAME="$agent_name"
  SMOKE_STEP_COUNT=0
  SMOKE_STEP_TOTAL="${SMOKE_STEP_TOTAL:-?}"
  SMOKE_STARTED_AT=$(date +%s)
  printf '==========================================\n'
  printf '冒烟测试: %s\n' "$agent_name"
  printf '目标:     %s\n' "$SMOKE_HOST"
  printf '用户:     %s (impersonate)\n' "$SMOKE_USER"
  printf '==========================================\n'
}

# --- HTTP 辅助函数 -------------------------------------------------
#
# 所有返回 stdout 的都是 RAW HTTP body; 退出码非零时 set -e 会让
# 调用者自动崩。如果调用者需要对 4xx/5xx 做处理,记得 `|| true`
# 包起来再自己解析。

_smoke_curl() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local extra_args=()
  if [[ -n "$body" ]]; then
    extra_args+=("-d" "$body")
  fi
  curl --max-time "$SMOKE_TIMEOUT" \
       --show-error \
       --silent \
       --fail-with-body \
       -X "$method" \
       "${SMOKE_AUTH[@]}" \
       "${extra_args[@]}" \
       "$SMOKE_HOST$path"
}

smoke_get()    { _smoke_curl GET    "$1"; }
smoke_post()   { _smoke_curl POST   "$1" "${2:-}"; }
smoke_put()    { _smoke_curl PUT    "$1" "${2:-}"; }
smoke_delete() { _smoke_curl DELETE "$1" "${2:-}"; }

# smoke_get_data <json> <jq_expr>
# prd-api 把所有响应包在 ApiResponse<T> = {success,data,error} 里。
# 这个辅助函数直接抽 .data.<expr> 省去每次写 `.data.xxx`。
smoke_get_data() {
  local json="$1"
  local expr="${2:-.}"
  printf '%s' "$json" | jq -r ".data | ${expr}"
}

# --- 断言 ----------------------------------------------------------

smoke_step() {
  SMOKE_STEP_COUNT=$((SMOKE_STEP_COUNT + 1))
  printf '\n>>> [%s/%s] %s\n' "$SMOKE_STEP_COUNT" "$SMOKE_STEP_TOTAL" "$*"
}

smoke_ok() {
  printf '✅ %s\n' "$*"
}

smoke_fail() {
  printf '❌ %s\n' "$*" >&2
  exit 1
}

# smoke_assert_nonempty <value> <name>
smoke_assert_nonempty() {
  local val="$1"
  local name="${2:-field}"
  if [[ -z "$val" || "$val" == "null" ]]; then
    smoke_fail "断言失败: $name 为空"
  fi
}

# smoke_assert_eq <actual> <expected> <name>
smoke_assert_eq() {
  local actual="$1"
  local expected="$2"
  local name="${3:-field}"
  if [[ "$actual" != "$expected" ]]; then
    smoke_fail "断言失败: $name 应为 '$expected' 但实际为 '$actual'"
  fi
}

# smoke_assert_contains <haystack> <needle> <name>
smoke_assert_contains() {
  local haystack="$1"
  local needle="$2"
  local name="${3:-field}"
  if [[ "$haystack" != *"$needle"* ]]; then
    smoke_fail "断言失败: $name 应包含 '$needle' 但实际为 '$haystack'"
  fi
}

# smoke_retry <n> <sleep_secs> <cmd...>
#
# 对 "部署后 pod 还没起来" 类网络抖动做指数退避重试。
# 例: smoke_retry 3 2 curl -sf "$HOST/api/prd-agent/health"
smoke_retry() {
  local max="$1"; shift
  local base="$1"; shift
  local attempt=0 delay="$base"
  while (( attempt < max )); do
    attempt=$((attempt + 1))
    if "$@"; then
      return 0
    fi
    if (( attempt < max )); then
      printf '[smoke-lib] 第 %s 次失败,%s 秒后重试…\n' "$attempt" "$delay" >&2
      sleep "$delay"
      delay=$((delay * 2))
    fi
  done
  smoke_fail "重试 ${max} 次后仍然失败: $*"
}

# smoke_verbose — 只在 SMOKE_VERBOSE 非空时打印完整 JSON (脱敏摘要)
smoke_verbose() {
  if [[ -n "$SMOKE_VERBOSE" ]]; then
    printf '  ↳ %s\n' "$*"
  fi
}

# --- 收尾 ----------------------------------------------------------

smoke_done() {
  local elapsed=$(( $(date +%s) - SMOKE_STARTED_AT ))
  printf '\n==========================================\n'
  printf '✅ %s 冒烟测试全部通过 (%s 步, 耗时 %ss)\n' "$SMOKE_AGENT_NAME" "$SMOKE_STEP_COUNT" "$elapsed"
  printf '==========================================\n'
}
