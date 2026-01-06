#!/bin/bash

# PRD Agent 快速启动器
# 用法:
#   ./quick.sh          - 启动后端服务
#   ./quick.sh admin    - 启动Web管理后台
#   ./quick.sh desktop  - 启动桌面客户端
#   ./quick.sh all      - 同时启动后端 + Web管理后台 + 桌面端（统一输出到同一控制台）
#   ./quick.sh check    - 桌面端本地 CI 等价检查（对齐 .github/workflows/ci.yml 的 desktop-check；不包含 tag/release 打包与签名）
#   ./quick.sh ci       - 本地跑一遍 CI（server + admin + desktop），尽量在提交前暴露问题
#   ./quick.sh version  - 同步桌面端版本号（用于让 Tauri 打包资产文件名跟随 git tag / CI tag）

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

# all 模式运行时 PID（wrapper pid；停止时会递归停止其子进程）
ALL_API_PID=""
ALL_ADMIN_PID=""
ALL_DESKTOP_PID=""
ALL_STOPPING=0

prefix_lines() {
    local prefix="$1"
    awk -v p="$prefix" '{ print p $0; fflush(); }'
}

get_children_pids() {
    local ppid="$1"

    if command -v pgrep >/dev/null 2>&1; then
        pgrep -P "$ppid" 2>/dev/null || true
        return 0
    fi

    # fallback: 兼容无 pgrep 的环境
    ps -axo pid=,ppid= 2>/dev/null | awk -v p="$ppid" '$2==p {print $1}'
}

kill_tree() {
    local pid="$1"
    local sig="${2:-TERM}"

    if [ -z "$pid" ]; then
        return 0
    fi

    local child
    for child in $(get_children_pids "$pid"); do
        kill_tree "$child" "$sig"
    done

    kill "-$sig" "$pid" 2>/dev/null || true
}

wait_pids_exit() {
    local timeout_s="$1"
    shift

    local start now
    start=$(date +%s)

    while true; do
        local any_alive=0
        local pid

        for pid in "$@"; do
            if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
                any_alive=1
                break
            fi
        done

        if [ "$any_alive" -eq 0 ]; then
            return 0
        fi

        now=$(date +%s)
        if [ $((now - start)) -ge "$timeout_s" ]; then
            return 1
        fi

        sleep 0.2
    done
}

stop_all_services() {
    if [ "${ALL_STOPPING:-0}" = "1" ]; then
        return 0
    fi
    ALL_STOPPING=1

    set +e

    log_info "Stopping all services..."

    # 1) 尽量优雅：SIGINT（并行发送）
    local stop_jobs=""
    local pid
    for pid in "$ALL_API_PID" "$ALL_ADMIN_PID" "$ALL_DESKTOP_PID"; do
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            kill_tree "$pid" INT &
            stop_jobs="$stop_jobs $!"
        fi
    done
    for pid in $stop_jobs; do
        wait "$pid" 2>/dev/null
    done

    if ! wait_pids_exit 8 "$ALL_API_PID" "$ALL_ADMIN_PID" "$ALL_DESKTOP_PID"; then
        # 2) 超时升级：SIGTERM（并行发送）
        log_warn "Graceful stop timed out, sending SIGTERM..."
        stop_jobs=""
        for pid in "$ALL_API_PID" "$ALL_ADMIN_PID" "$ALL_DESKTOP_PID"; do
            if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
                kill_tree "$pid" TERM &
                stop_jobs="$stop_jobs $!"
            fi
        done
        for pid in $stop_jobs; do
            wait "$pid" 2>/dev/null
        done
    fi

    if ! wait_pids_exit 5 "$ALL_API_PID" "$ALL_ADMIN_PID" "$ALL_DESKTOP_PID"; then
        # 3) 继续超时：SIGKILL（并行发送）
        log_warn "Force stop timed out, sending SIGKILL..."
        stop_jobs=""
        for pid in "$ALL_API_PID" "$ALL_ADMIN_PID" "$ALL_DESKTOP_PID"; do
            if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
                kill_tree "$pid" KILL &
                stop_jobs="$stop_jobs $!"
            fi
        done
        for pid in $stop_jobs; do
            wait "$pid" 2>/dev/null
        done
    fi

    # 回收 wrapper
    for pid in "$ALL_API_PID" "$ALL_ADMIN_PID" "$ALL_DESKTOP_PID"; do
        if [ -n "$pid" ]; then
            wait "$pid" 2>/dev/null
        fi
    done

    log_success "All services stopped!"
    exit 0
}

# 启动后端服务
start_backend() {
    log_info "Starting backend server..."
    cd "$SCRIPT_DIR/prd-api/src/PrdAgent.Api"
    dotnet run
}

# 启动Web管理后台
start_admin() {
    log_info "Starting admin panel..."
    cd "$SCRIPT_DIR/prd-admin"
    pnpm dev
}

# 启动桌面客户端
start_desktop() {
    log_info "Starting desktop client..."
    cd "$SCRIPT_DIR/prd-desktop"
    pnpm tauri:dev
}

# 桌面端本地CI等价检查（避免 CI desktop 才爆）
check_desktop() {
    log_info "Running desktop check (CI-equivalent)..."

    # frontend checks (align with .github/workflows/ci.yml desktop-check)
    cd "$SCRIPT_DIR/prd-desktop"
    if [ ! -d "node_modules" ]; then
        log_warn "node_modules not found, running pnpm install..."
        pnpm install
    fi

    log_info "Type check frontend (tsc --noEmit)..."
    pnpm tsc --noEmit

    log_info "Build frontend..."
    pnpm build

    log_info "Generate Tauri icons..."
    pnpm tauri:icons

    # rust checks
    cd "$SCRIPT_DIR/prd-desktop/src-tauri"

    log_info "Cargo check..."
    cargo check

    log_info "Rust format check (cargo fmt --check)..."
    cargo fmt --check

    log_info "Clippy (deny warnings)..."
    cargo clippy -- -D warnings

    log_success "Desktop check passed!"
}

# 本地跑一遍 CI（server + admin + desktop）
check_ci() {
    log_info "Running local CI checks (server + admin + desktop)..."

    # server checks (align with .github/workflows/ci.yml server-build)
    log_info "Server: dotnet restore/build/test..."
    cd "$SCRIPT_DIR/prd-api"
    dotnet restore PrdAgent.sln
    dotnet build PrdAgent.sln -c Release --no-restore
    dotnet test PrdAgent.sln -c Release --no-build --verbosity normal

    # admin checks (align with .github/workflows/ci.yml admin-build)
    log_info "Admin: install/typecheck/build..."
    cd "$SCRIPT_DIR/prd-admin"
    if [ ! -d "node_modules" ]; then
        log_warn "node_modules not found, running pnpm install..."
        pnpm install
    fi
    pnpm tsc --noEmit
    pnpm build

    # desktop checks (reuse existing)
    check_desktop

    log_success "Local CI checks passed!"
}

# 同步桌面端版本号（让打包产物文件名跟随版本号）
# - 支持：./quick.sh version v1.2.4 或 ./quick.sh version 1.2.4
# - 不传参时：自动从 git tag（git describe --tags --abbrev=0）推断
sync_desktop_version() {
    log_info "Syncing desktop version..."
    cd "$SCRIPT_DIR"
    if [ ! -f "$SCRIPT_DIR/scripts/sync-desktop-version.sh" ]; then
        log_error "Missing script: $SCRIPT_DIR/scripts/sync-desktop-version.sh"
        exit 1
    fi
    bash "$SCRIPT_DIR/scripts/sync-desktop-version.sh" "${1:-}"
    log_success "Desktop version synced!"
}

# 发布新版本：同步版本号 -> commit -> tag -> push
# - 用法：./quick.sh release 1.4.32
# - 一气呵成：同步版本 -> git commit -> git tag -> git push
release_version() {
    local raw_version="${1:-}"
    
    if [ -z "$raw_version" ]; then
        log_error "Usage: ./quick.sh release <version>"
        log_error "Example: ./quick.sh release 1.4.32"
        exit 1
    fi
    
    cd "$SCRIPT_DIR"
    
    # 规范化版本号（去掉 v 前缀用于文件，保留用于 tag）
    local version="$raw_version"
    if [[ "$version" == v* ]]; then
        version="${version:1}"
    fi
    local tag_name="v$version"
    
    # 验证版本号格式
    if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([\-+][0-9A-Za-z\.\-]+)?$ ]]; then
        log_error "Invalid version: '$raw_version' (expected like v1.2.3 / 1.2.3)"
        exit 1
    fi
    
    # 检查是否有未提交的更改（除了即将修改的版本文件）
    if ! git diff --quiet HEAD 2>/dev/null; then
        log_warn "You have uncommitted changes. Please commit or stash them first."
        git status --short
        exit 1
    fi
    
    # 检查 tag 是否已存在
    if git rev-parse "$tag_name" >/dev/null 2>&1; then
        log_error "Tag '$tag_name' already exists!"
        log_info "To delete it: git tag -d $tag_name && git push origin :refs/tags/$tag_name"
        exit 1
    fi
    
    log_info "=== Release $tag_name ==="
    
    # Step 1: 同步版本号
    log_info "[1/4] Syncing version to $version..."
    bash "$SCRIPT_DIR/scripts/sync-desktop-version.sh" "$version"
    
    # Step 2: Git add & commit
    log_info "[2/4] Committing version changes..."
    git add prd-desktop/src-tauri/tauri.conf.json \
            prd-desktop/src-tauri/Cargo.toml \
            prd-desktop/package.json
    git commit -m "chore(release): bump version to $version"
    
    # Step 3: 创建 tag
    log_info "[3/4] Creating tag $tag_name..."
    git tag "$tag_name"
    
    # Step 4: 推送 commit 和 tag
    log_info "[4/4] Pushing to remote..."
    git push
    git push origin "$tag_name"
    
    log_success "=== Release $tag_name completed! ==="
    log_info "GitHub Actions will now build and publish the release."
    log_info "Check progress at: https://github.com/inernoro/prd_agent/actions"
}

# 同时启动后端 + Web管理后台 + 桌面端
start_all() {
    log_info "Starting all services..."

    ALL_STOPPING=0
    ALL_API_PID=""
    ALL_ADMIN_PID=""
    ALL_DESKTOP_PID=""

    # 捕获退出信号：同时停止三个进程（并递归清理子进程）
    trap stop_all_services INT TERM

    # 1) 并行启动后端（不等待启动完成）
    log_info "Starting backend server in background..."
    ( (
        cd "$SCRIPT_DIR/prd-api/src/PrdAgent.Api" || { echo "cd failed: $SCRIPT_DIR/prd-api/src/PrdAgent.Api"; exit 1; }
        dotnet run
    ) 2>&1 | prefix_lines "[api] " ) &
    ALL_API_PID=$!

    # 2) 并行启动管理后台（不等待启动完成）
    log_info "Starting admin panel in background..."
    ( (
        cd "$SCRIPT_DIR/prd-admin" || { echo "cd failed: $SCRIPT_DIR/prd-admin"; exit 1; }
        if [ ! -d "node_modules" ]; then
            echo "node_modules not found, running: pnpm install --frozen-lockfile"
            pnpm install --frozen-lockfile
        fi
        pnpm dev
    ) 2>&1 | prefix_lines "[admin] " ) &
    ALL_ADMIN_PID=$!

    # 3) 并行启动桌面端（不等待启动完成）
    log_info "Starting desktop client in background..."
    ( (
        cd "$SCRIPT_DIR/prd-desktop" || { echo "cd failed: $SCRIPT_DIR/prd-desktop"; exit 1; }
        NEED_INSTALL=0
        if [ ! -d "node_modules" ]; then
            NEED_INSTALL=1
        fi
        if [ ! -f "node_modules/@tauri-apps/plugin-shell/package.json" ]; then
            NEED_INSTALL=1
        fi
        if [ "$NEED_INSTALL" -eq 1 ]; then
            echo "node_modules incomplete, running: pnpm install --frozen-lockfile"
            pnpm install --frozen-lockfile
        fi
        pnpm tauri:dev
    ) 2>&1 | prefix_lines "[desktop] " ) &
    ALL_DESKTOP_PID=$!

    log_success "All services started!"
    log_info "API PID: $ALL_API_PID"
    log_info "Admin PID: $ALL_ADMIN_PID"
    log_info "Desktop PID: $ALL_DESKTOP_PID"
    log_info "Press Ctrl+C to stop all services"

    # 等待三个 wrapper 退出（任一退出不影响其它继续运行）
    wait "$ALL_API_PID" 2>/dev/null || true
    wait "$ALL_ADMIN_PID" 2>/dev/null || true
    wait "$ALL_DESKTOP_PID" 2>/dev/null || true
}

# 显示帮助信息
show_help() {
    echo "PRD Agent Quick Launcher"
    echo ""
    echo "Usage: ./quick.sh [command]"
    echo ""
    echo "Commands:"
    echo "  (default)  Start backend server"
    echo "  admin      Start admin panel (prd-admin)"
    echo "  desktop    Start desktop client (prd-desktop)"
    echo "  all        Start backend + admin + desktop together (single console output)"
    echo "  check      Run desktop CI-equivalent checks (same as ci.yml desktop-check; excludes desktop-release packaging/signing)"
    echo "  ci         Run local CI checks (server + admin + desktop)"
    echo "  version    Sync desktop version (tauri.conf.json/Cargo.toml/package.json) from arg/env/git tag"
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
    "check")
        check_desktop
        ;;
    "ci")
        check_ci
        ;;
    "version")
        sync_desktop_version "${2:-}"
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
