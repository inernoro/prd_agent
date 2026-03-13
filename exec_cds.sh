#!/usr/bin/env sh
set -eu

# CDS 一键部署/开发脚本
#
# 用法：
#   ./exec_cds.sh              # 生产部署：pnpm install + tsc 编译 + 后台启动（默认）
#   ./exec_cds.sh dev          # 开发调试：pnpm install + tsx watch（热重载）
#   ./exec_cds.sh stop         # 停止后台进程
#   ./exec_cds.sh restart      # 重启（后台模式）
#   ./exec_cds.sh status       # 查看运行状态
#   ./exec_cds.sh logs         # 查看日志（后台模式）
#   ./exec_cds.sh fg           # 前台运行（调试用）
#
# 可选环境变量：
#   CDS_USERNAME=admin   登录用户名（设置后启用认证）
#   CDS_PASSWORD=xxx     登录密码

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CDS_DIR="$SCRIPT_DIR/cds"
PID_FILE="$CDS_DIR/.cds/cds.pid"
LOG_FILE="$CDS_DIR/cds.log"

info()  { printf "\033[34m[INFO]\033[0m %s\n" "$1"; }
ok()    { printf "\033[32m[OK]\033[0m %s\n" "$1"; }
warn()  { printf "\033[33m[WARN]\033[0m %s\n" "$1"; }
err()   { printf "\033[31m[ERROR]\033[0m %s\n" "$1" >&2; }

check_deps() {
  if ! command -v node >/dev/null 2>&1; then
    err "未找到 node，请安装 Node.js >= 20"
    exit 1
  fi

  NODE_VER="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$NODE_VER" -lt 20 ] 2>/dev/null; then
    warn "Node.js 版本 $(node -v)，建议 >= 20"
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    err "未找到 pnpm"
    exit 1
  fi

  if ! command -v docker >/dev/null 2>&1; then
    err "未找到 docker（CDS 需要 Docker 来管理分支容器）"
    exit 1
  fi
}

install_deps() {
  if [ ! -d "$CDS_DIR/node_modules" ]; then
    info "安装依赖..."
    (cd "$CDS_DIR" && pnpm install)
  fi
}

build() {
  info "编译 TypeScript..."
  (cd "$CDS_DIR" && npx tsc) || true

  if [ ! -f "$CDS_DIR/dist/index.js" ]; then
    err "编译失败：dist/index.js 不存在"
    exit 1
  fi
  ok "编译完成"
}

start_foreground() {
  check_deps
  install_deps
  build

  info "启动 CDS（生产模式）..."
  info "Dashboard: http://localhost:${CDS_PORT:-9900}"
  info "按 Ctrl+C 停止"
  echo ""

  cd "$CDS_DIR"
  exec node dist/index.js
}

start_dev() {
  check_deps
  install_deps

  info "启动 CDS（开发模式，热重载）..."
  info "Dashboard: http://localhost:${CDS_PORT:-9900}"
  info "按 Ctrl+C 停止"
  echo ""

  cd "$CDS_DIR"
  exec npx tsx watch src/index.ts
}

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

start_daemon() {
  check_deps
  install_deps
  build

  if is_running; then
    warn "CDS 已在运行 (PID: $(cat "$PID_FILE"))"
    return
  fi

  info "启动 CDS（后台模式）..."
  mkdir -p "$CDS_DIR/.cds"
  cd "$CDS_DIR"
  nohup node dist/index.js > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  cd "$SCRIPT_DIR"

  sleep 1
  if is_running; then
    ok "CDS 已启动 (PID: $(cat "$PID_FILE"))"
    info "Dashboard: http://localhost:${CDS_PORT:-9900}"
    info "日志: $LOG_FILE"
  else
    err "启动失败，查看日志:"
    tail -20 "$LOG_FILE"
    exit 1
  fi
}

stop_cds() {
  if ! is_running; then
    warn "CDS 未在运行"
    return
  fi

  PID="$(cat "$PID_FILE")"
  info "停止 CDS (PID: $PID)..."
  kill "$PID" 2>/dev/null || true

  i=0
  while kill -0 "$PID" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 10 ]; then
      warn "进程未响应，强制终止..."
      kill -9 "$PID" 2>/dev/null || true
      break
    fi
    sleep 1
  done

  rm -f "$PID_FILE"
  ok "已停止"
}

show_status() {
  if is_running; then
    PID="$(cat "$PID_FILE")"
    ok "CDS 运行中 (PID: $PID)"
    info "Dashboard: http://localhost:${CDS_PORT:-9900}"
  else
    warn "CDS 未运行"
    [ -f "$PID_FILE" ] && rm -f "$PID_FILE"
  fi
}

show_logs() {
  if [ ! -f "$LOG_FILE" ]; then
    warn "无日志文件: $LOG_FILE"
    return
  fi
  tail -100f "$LOG_FILE"
}

show_help() {
  echo "CDS 部署脚本"
  echo ""
  echo "用法: ./exec_cds.sh [命令]"
  echo ""
  echo "命令:"
  echo "  (默认)        pnpm install + 编译 + 后台启动（生产）"
  echo "  dev           pnpm install + tsx watch 热重载（开发）"
  echo "  fg            pnpm install + 编译 + 前台启动（调试用）"
  echo "  stop          停止后台进程"
  echo "  restart       重启（后台模式）"
  echo "  status        查看运行状态"
  echo "  logs          查看日志（Ctrl+C 退出）"
  echo "  help          显示帮助"
  echo ""
  echo "环境变量:"
  echo "  CDS_PORT=9900       Dashboard 端口"
  echo "  CDS_USERNAME=admin  登录用户名（启用认证）"
  echo "  CDS_PASSWORD=xxx    登录密码"
  echo ""
}

CMD="${1:-daemon}"

case "$CMD" in
  start|daemon) start_daemon ;;
  dev)     start_dev ;;
  fg)      start_foreground ;;
  stop)    stop_cds ;;
  restart) stop_cds; start_daemon ;;
  status)  show_status ;;
  logs)    show_logs ;;
  help|-h|--help) show_help ;;
  *)
    err "未知命令: $CMD"
    show_help
    exit 1
    ;;
esac
