#!/bin/bash

# PRD Agent 快速启动器
# 用法:
#   ./quick.sh          - 启动后端服务
#   ./quick.sh admin    - 启动Web管理后台
#   ./quick.sh desktop  - 启动桌面客户端
#   ./quick.sh all      - 同时启动前后端

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 启动后端服务
start_backend() {
    log_info "Starting backend server..."
    cd "$SCRIPT_DIR/PrdAgent.Server/src/PrdAgent.Api"
    dotnet run
}

# 启动Web管理后台
start_admin() {
    log_info "Starting admin panel..."
    cd "$SCRIPT_DIR/prd-agent-admin"
    pnpm dev
}

# 启动桌面客户端
start_desktop() {
    log_info "Starting desktop client..."
    cd "$SCRIPT_DIR/prd-agent-desktop"
    pnpm tauri:dev
}

# 同时启动前后端
start_all() {
    log_info "Starting all services..."
    
    # 后台启动后端
    log_info "Starting backend server in background..."
    cd "$SCRIPT_DIR/PrdAgent.Server/src/PrdAgent.Api"
    dotnet run &
    BACKEND_PID=$!
    
    # 等待后端启动
    sleep 3
    
    # 前台启动管理后台
    log_info "Starting admin panel..."
    cd "$SCRIPT_DIR/prd-agent-admin"
    pnpm dev &
    ADMIN_PID=$!
    
    log_success "All services started!"
    log_info "Backend PID: $BACKEND_PID"
    log_info "Admin Panel PID: $ADMIN_PID"
    log_info "Press Ctrl+C to stop all services"
    
    # 捕获退出信号，清理进程
    trap "kill $BACKEND_PID $ADMIN_PID 2>/dev/null; exit" SIGINT SIGTERM
    
    # 等待任意子进程退出
    wait
}

# 显示帮助信息
show_help() {
    echo "PRD Agent Quick Launcher"
    echo ""
    echo "Usage: ./quick.sh [command]"
    echo ""
    echo "Commands:"
    echo "  (default)  Start backend server"
    echo "  admin      Start admin panel (prd-agent-admin)"
    echo "  desktop    Start desktop client (prd-agent-desktop)"
    echo "  all        Start backend and web admin together"
    echo "  help       Show this help message"
    echo ""
}

# 主逻辑
case "${1:-}" in
    "")
        start_backend
        ;;
    "admin")
        start_admin
        ;;
    "desktop")
        start_desktop
        ;;
    "all")
        start_all
        ;;
    "help"|"-h"|"--help")
        show_help
        ;;
    *)
        log_error "Unknown command: $1"
        show_help
        exit 1
        ;;
esac
