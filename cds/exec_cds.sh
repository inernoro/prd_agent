#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# CDS — Cloud Development Suite 一站式入口
#
# 用法:
#   ./exec_cds.sh init          交互式初始化 (写 .cds.env + 生成 nginx 配置)
#   ./exec_cds.sh start         启动 CDS + Nginx (默认后台)
#   ./exec_cds.sh start --fg    前台启动 (调试用)
#   ./exec_cds.sh stop          停止 CDS + Nginx
#   ./exec_cds.sh restart       重启
#   ./exec_cds.sh status        查看运行状态
#   ./exec_cds.sh logs          跟随 CDS 日志 (Ctrl+C 退出)
#   ./exec_cds.sh cert          签发/续签 Let's Encrypt 证书
#
# 唯一用户配置入口: cds/.cds.env (所有变量 CDS_ 前缀)
#   CDS_USERNAME        Dashboard 登录用户名
#   CDS_PASSWORD        Dashboard 登录密码
#   CDS_JWT_SECRET      JWT 签名密钥 (>= 32 字节)
#   CDS_ROOT_DOMAINS    根域名列表 (逗号分隔)
#
# 多域名路由 (对 CDS_ROOT_DOMAINS 中每个根域名 D 生成):
#   D          → Dashboard
#   cds.D      → Dashboard (别名)
#   *.D        → Preview   (任意子域名 = 分支预览)
#
# 示例: CDS_ROOT_DOMAINS="miduo.org,mycds.net"
# ──────────────────────────────────────────────────────────────

# Users often run `sh ./exec_cds.sh ...`, which bypasses the shebang. This
# script intentionally uses bash features, so re-exec under bash before turning
# on strict mode.
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE="$SCRIPT_DIR/.cds.env"
CONFIG_FILE="${CDS_CONFIG:-cds.config.json}"
STATE_DIR="$SCRIPT_DIR/.cds"
PID_FILE="$STATE_DIR/cds.pid"
LOG_FILE="$SCRIPT_DIR/cds.log"

# P4 Part 18 (G1.4): multi-repo clone storage.
# Per-project git clones live under this directory as
# `<REPOS_BASE>/<projectId>`. The directory is created on start
# so the CDS clone endpoint can drop into it without having to
# mkdir first. Override with `export CDS_REPOS_BASE=/custom/path`
# in .cds.env if you need a different location (e.g. a dedicated
# data disk mount).
#
# On container restart / self-update this path survives because
# it's a host filesystem location, not inside the CDS process's
# working directory. The containerized deployment (Dockerfile.master)
# must bind-mount this path — see the run example in that file.
REPOS_BASE_DEFAULT="$SCRIPT_DIR/.cds-repos"

NGINX_DIR="$SCRIPT_DIR/nginx"
NGINX_CONF="$NGINX_DIR/nginx.conf"
NGINX_SITE_CONF="$NGINX_DIR/cds-site.conf"
NGINX_COMPOSE_FILE="$NGINX_DIR/nginx.compose.yml"
NGINX_CERTS_DIR="$NGINX_DIR/certs"
NGINX_WWW_DIR="$NGINX_DIR/www"
NGINX_CONTAINER="cds_nginx"

mkdir -p "$STATE_DIR"

# ── colors ──
if [ -t 1 ]; then
  R=$'\033[0;31m'; G=$'\033[0;32m'; Y=$'\033[1;33m'; C=$'\033[0;36m'; B=$'\033[1m'; N=$'\033[0m'
else
  R=''; G=''; Y=''; C=''; B=''; N=''
fi
info()  { printf "%s[INFO]%s %s\n" "$C" "$N" "$*"; }
ok()    { printf "%s[OK]%s   %s\n" "$G" "$N" "$*"; }
warn()  { printf "%s[WARN]%s %s\n" "$Y" "$N" "$*"; }
err()   { printf "%s[ERR]%s  %s\n" "$R" "$N" "$*" >&2; }

# Bootstrap token lifetime — short enough to limit leak impact, long enough
# for a human to copy-paste it to another machine. See
# doc/design.cds-cluster-bootstrap.md §6.3.
BOOTSTRAP_TOKEN_TTL_SECONDS=900  # 15 minutes

# Generate a cryptographically-random hex token (32 bytes → 64 hex chars).
random_token() {
  openssl rand -hex 32 2>/dev/null \
    || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# ISO timestamp offset from now (GNU date + BSD date compat).
iso_offset_seconds() {
  local offset="$1"
  date -u -d "+${offset} seconds" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
    || date -u -v "+${offset}S" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
    || python3 -c "import datetime;print((datetime.datetime.utcnow()+datetime.timedelta(seconds=${offset})).strftime('%Y-%m-%dT%H:%M:%SZ'))"
}

# Atomically upsert or remove a `export KEY="value"` line in .cds.env.
# Usage: env_upsert KEY VALUE   (VALUE="" removes the line)
env_upsert() {
  local key="$1" value="$2"
  local tmp="${ENV_FILE}.tmp.$$"
  [ -f "$ENV_FILE" ] || {
    touch "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  }
  awk -v k="$key" '$0 !~ "^export "k"=" { print }' "$ENV_FILE" > "$tmp"
  if [ -n "$value" ]; then
    printf 'export %s="%s"\n' "$key" "$value" >> "$tmp"
  fi
  mv -f "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

# Load the only env file the script recognises.
load_env() {
  [ -f "$ENV_FILE" ] || return 0
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

# ensure_cds_mongo_running: 启动 CDS 前确保 cds-state-mongo 容器 running。
#
# 修复循环依赖：CDS 启动要连 Mongo，但 Mongo 容器记在 CDS state 里——
# 如果 Mongo 挂了，CDS 读 state 失败就起不来。解法是在 CDS 启动前由
# exec_cds.sh 直接 docker start 容器（不需要 CDS API）。
#
# 依赖 .cds.env 里的：
#   - CDS_MONGO_CONTAINER  容器名（init 会写；老部署可能没有这个变量）
#   - CDS_STORAGE_MODE=mongo-split（或旧版 mongo）
#
# 缺变量 → 安静跳过（假定运维用 CDS API 管 Mongo，或根本没用 Mongo）
# 容器不存在 → 打印警告但不 fail（让 CDS 自己 throw 带明确错误）
ensure_cds_mongo_running() {
  case "${CDS_STORAGE_MODE:-}" in
    mongo|mongo-split) ;;
    *) return 0 ;;
  esac
  [ -n "${CDS_MONGO_CONTAINER:-}" ] || return 0

  local c="$CDS_MONGO_CONTAINER"
  # 已 running：什么都不做
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
    return 0
  fi
  # 存在但 stopped：start
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
    info "MongoDB 容器 $c 未运行，正在启动…"
    if docker start "$c" >/dev/null 2>&1; then
      ok "MongoDB 容器已启动"
      # 等 healthy（最多 15s）
      local i=0
      while [ "$i" -lt 15 ]; do
        if docker exec "$c" mongosh --quiet --eval 'db.runCommand({ping:1}).ok' 2>/dev/null | grep -q '^1$'; then
          return 0
        fi
        sleep 1
        i=$((i + 1))
      done
      warn "MongoDB 15s 内未就绪；CDS 启动可能会失败，它会打印清晰错误"
    else
      err "MongoDB 容器 $c 启动失败"
      return 1
    fi
  else
    warn "MongoDB 容器 $c 不存在；CDS 启动时会 throw。请先 ./exec_cds.sh init 重建，或手动创建容器"
    return 1
  fi
}

# Read an individual value from .cds.env without sourcing it.
read_env_value() {
  local key="$1"
  [ -f "$ENV_FILE" ] || { printf ''; return; }
  awk -F'=' -v k="$key" '
    $0 ~ "^export "k"=" {
      sub("^export "k"=","")
      gsub("^\"|\"$","")
      last=$0
    }
    END { printf "%s", last }
  ' "$ENV_FILE"
}

# ══ dependency check & auto-install ══════════════════════════════
#
# See .claude/rules/quickstart-zero-friction.md
# 原则: "快启动必须大包大揽，假设使用者是小白"
#
# check_deps() 不再是"缺失就退出"——它会:
#   1. 检测每个必需/可选工具，给出 ✅/❌ + 用途说明
#   2. 对能自动装的 (pnpm/python3/curl/openssl) → 交互询问 [Y/n] → 自动装
#   3. 对不能自动装的 (docker/node) → 给对应发行版的复制粘贴命令
#   4. 跑两次能继续 (幂等)
#   5. 成功的静默，失败的详细

# Ask a yes/no question on tty. Returns 0 for yes, 1 for no.
# Default is Y (enter = yes). Non-interactive (no tty) returns yes.
confirm() {
  local prompt="$1"
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    return 0  # non-interactive: assume yes so scripted runs work
  fi
  local answer
  printf "  %s%s%s [Y/n]: " "$B" "$prompt" "$N" >/dev/tty
  read -r answer </dev/tty
  case "${answer:-Y}" in
    [Yy]|[Yy][Ee][Ss]|'') return 0 ;;
    *) return 1 ;;
  esac
}

# Detect Linux distribution family for auto-install command selection.
# Returns one of: ubuntu, debian, centos, rhel, fedora, arch, alpine, macos, unknown
detect_os() {
  if [ "$(uname -s)" = "Darwin" ]; then
    printf 'macos'
    return
  fi
  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${ID:-}" in
      ubuntu) printf 'ubuntu' ;;
      debian) printf 'debian' ;;
      centos) printf 'centos' ;;
      rhel|redhat) printf 'rhel' ;;
      fedora) printf 'fedora' ;;
      amzn|amazon) printf 'rhel' ;;
      arch|manjaro) printf 'arch' ;;
      alpine) printf 'alpine' ;;
      *)
        # Fall back to ID_LIKE if primary ID is unknown
        case "${ID_LIKE:-}" in
          *debian*) printf 'debian' ;;
          *rhel*|*fedora*) printf 'rhel' ;;
          *) printf 'unknown' ;;
        esac
        ;;
    esac
  else
    printf 'unknown'
  fi
}

# Return the package-install command prefix for the detected OS.
# Usage: $(pkg_install_cmd) <package-name>
pkg_install_cmd() {
  case "$(detect_os)" in
    ubuntu|debian) printf 'sudo apt-get install -y' ;;
    centos|rhel)   printf 'sudo yum install -y' ;;
    fedora)        printf 'sudo dnf install -y' ;;
    arch)          printf 'sudo pacman -S --noconfirm' ;;
    alpine)        printf 'sudo apk add' ;;
    macos)         printf 'brew install' ;;
    *)             printf '' ;;
  esac
}

# Try to install a package via the detected package manager. Returns 0 on success.
try_pkg_install() {
  local pkg="$1" cmd
  cmd="$(pkg_install_cmd)"
  if [ -z "$cmd" ]; then
    warn "未知的发行版，无法自动安装 $pkg"
    return 1
  fi
  info "执行: $cmd $pkg"
  # shellcheck disable=SC2086
  $cmd "$pkg" 2>&1 | tail -5
  command -v "$pkg" >/dev/null 2>&1
}

# ── Dependency checks: each function returns 0 if OK, 1 if missing ──

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    printf "  ❌ [依赖] %sNode.js%s 未安装\n" "$B" "$N"
    echo  "     用途: 运行 CDS 核心进程 (Express + TypeScript)"
    echo  "     缺失后果: CDS 完全无法启动"
    echo  "     推荐安装 (Node.js 20 LTS):"
    case "$(detect_os)" in
      ubuntu|debian)
        echo  "       curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
        echo  "       sudo apt-get install -y nodejs"
        ;;
      centos|rhel|fedora)
        echo  "       curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -"
        echo  "       sudo yum install -y nodejs"
        ;;
      macos)
        echo  "       brew install node@20"
        ;;
      *)
        echo  "       访问 https://nodejs.org/ 下载 v20 LTS 安装包"
        ;;
    esac
    echo  "     (Node.js 需要发行版级别安装，不能由本脚本自动完成)"
    return 1
  fi
  local v; v="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if ! [ "$v" -ge 20 ] 2>/dev/null; then
    printf "  ❌ [依赖] Node.js 版本过低 (当前 v%s，需要 >= 20)\n" "$v"
    echo  "     请升级到 Node.js 20 LTS 或更高版本"
    return 1
  fi
  printf "  ✅ Node.js %s\n" "$(node -v)"
  return 0
}

check_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    printf "  ✅ pnpm %s\n" "$(pnpm -v 2>/dev/null || echo '(version unknown)')"
    return 0
  fi
  printf "  ❌ [依赖] %spnpm%s 未安装\n" "$B" "$N"
  echo  "     用途: 前端包管理器 (代替 npm, 本项目强制使用)"
  echo  "     缺失后果: CDS Dashboard 无法编译"
  if command -v npm >/dev/null 2>&1; then
    if confirm "是否用 'npm install -g pnpm' 自动安装?"; then
      info "执行: npm install -g pnpm"
      if npm install -g pnpm 2>&1 | tail -3; then
        command -v pnpm >/dev/null 2>&1 && {
          ok "pnpm 安装完成: $(pnpm -v)"
          return 0
        }
      fi
      err "pnpm 自动安装失败，请手动运行: npm install -g pnpm"
      return 1
    fi
    warn "跳过 pnpm 自动安装 — 请手动运行: npm install -g pnpm"
    return 1
  fi
  warn "未找到 npm，无法自动安装 pnpm。先装好 Node.js 再试"
  return 1
}

check_docker() {
  if command -v docker >/dev/null 2>&1; then
    if docker ps >/dev/null 2>&1; then
      printf "  ✅ Docker %s\n" "$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',')"
      return 0
    fi
    printf "  ⚠️  Docker 已安装但无权限访问 daemon\n"
    echo  "     快速修复:"
    echo  "       sudo usermod -aG docker \$USER"
    echo  "       newgrp docker   # 或重新登录 shell"
    echo  "     临时测试: sudo docker ps"
    return 1
  fi
  printf "  ❌ [依赖] %sDocker%s 未安装\n" "$B" "$N"
  echo  "     用途: 运行分支预览容器 (CDS 核心能力)"
  echo  "     缺失后果: 无法创建任何分支预览"
  echo  "     推荐安装:"
  case "$(detect_os)" in
    ubuntu|debian)
      echo  "       curl -fsSL https://get.docker.com | sh"
      echo  "       sudo usermod -aG docker \$USER"
      echo  "       newgrp docker"
      ;;
    centos|rhel|fedora)
      echo  "       sudo yum install -y docker"
      echo  "       sudo systemctl enable --now docker"
      echo  "       sudo usermod -aG docker \$USER"
      echo  "       newgrp docker"
      ;;
    macos)
      echo  "       brew install --cask docker"
      echo  "       然后启动 Docker Desktop 应用"
      ;;
    alpine)
      echo  "       sudo apk add docker"
      echo  "       sudo rc-update add docker boot"
      echo  "       sudo service docker start"
      ;;
    *)
      echo  "       访问 https://docs.docker.com/engine/install/ 查找对应发行版"
      ;;
  esac
  echo  "     (Docker 涉及 systemd + 用户组, 不能由本脚本自动完成)"
  return 1
}

check_openssl() {
  if command -v openssl >/dev/null 2>&1; then
    return 0  # silent success — openssl 几乎所有系统都预装
  fi
  printf "  ❌ [依赖] openssl 未安装 (用于生成 JWT 密钥和 bootstrap token)\n"
  if confirm "是否自动安装 openssl?"; then
    try_pkg_install openssl && { ok "openssl 安装完成"; return 0; }
    warn "openssl 安装失败。备用方案: 脚本会使用 /dev/urandom 降级生成随机值"
    return 1
  fi
  warn "跳过 openssl — 会降级使用 /dev/urandom"
  return 0  # 不阻塞, 有降级路径
}

check_curl() {
  if command -v curl >/dev/null 2>&1; then
    return 0
  fi
  printf "  ❌ [依赖] %scurl%s 未安装\n" "$B" "$N"
  echo  "     用途: connect / cluster / cert 命令依赖 curl 调 HTTP"
  echo  "     缺失后果: 集群命令和证书签发完全不工作"
  if confirm "是否自动安装 curl?"; then
    try_pkg_install curl && { ok "curl 安装完成"; return 0; }
    err "curl 自动安装失败，请手动安装后重试"
    return 1
  fi
  err "curl 是必需依赖，跳过会导致 connect/cluster 失败"
  return 1
}

check_python3() {
  if command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  printf "  ⚠️  [可选] python3 未安装\n"
  echo  "     用途: ./exec_cds.sh cluster 命令的 JSON 美化输出"
  echo  "     缺失后果: cluster 命令仍能工作, 但输出是原始 JSON"
  if confirm "是否自动安装 python3?"; then
    try_pkg_install python3 && { ok "python3 安装完成"; return 0; }
    warn "python3 安装失败, 不影响核心功能"
    return 0
  fi
  info "跳过 python3 — 这是可选依赖, 不影响核心功能"
  return 0
}

# Main entry: checks all deps and auto-installs what it can.
# Returns 0 if all required deps are OK (optional deps don't block).
# Used by: init, start, connect, cert — anywhere CDS needs to be ready to run.
check_deps() {
  echo
  printf "  %s依赖检查%s\n" "$B" "$N"
  echo  "  ═══════════════════════════════"

  local required_failed=0

  # Required deps — scripts cannot run without these
  check_node    || required_failed=$((required_failed + 1))
  check_pnpm    || required_failed=$((required_failed + 1))
  check_docker  || required_failed=$((required_failed + 1))
  check_curl    || required_failed=$((required_failed + 1))

  # Optional deps — graceful degradation
  check_openssl
  check_python3

  echo

  if [ "$required_failed" -gt 0 ]; then
    err "$required_failed 个必需依赖未就绪 — 按上面的"推荐安装"命令操作后再跑一次 init"
    echo
    echo "  本脚本是幂等的：装好依赖后重新运行 ./exec_cds.sh init 会从断点继续"
    echo
    exit 1
  fi
  ok "所有必需依赖已就绪"
  echo
}

install_deps() {
  # Skip only when node_modules exists AND pnpm-lock.yaml hasn't
  # changed since the last install. The old "skip if node_modules
  # exists" was a P4 Part 18 footgun: after a self-update switched
  # branches, new deps in pnpm-lock.yaml (like the `mongodb` package
  # that Phase D.1 added) never got installed, which crashed the
  # new CDS process with a cryptic MODULE_NOT_FOUND at boot.
  #
  # The sentinel file records the mtime of pnpm-lock.yaml at the
  # time of the last successful install. If the lockfile is newer
  # than the sentinel, we re-install. Empty state dir → always run.
  local sentinel="$STATE_DIR/.pnpm-lock-installed"
  local lockfile="$SCRIPT_DIR/pnpm-lock.yaml"
  if [ -d "$SCRIPT_DIR/node_modules" ] && [ -f "$sentinel" ] && [ -f "$lockfile" ]; then
    if [ "$sentinel" -nt "$lockfile" ] || [ "$sentinel" -ef "$lockfile" ]; then
      return 0
    fi
    info "检测到 pnpm-lock.yaml 有变更，重新安装依赖 ..."
  else
    info "首次安装依赖 ..."
  fi
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
  # Record successful install — touch sentinel after the lock so
  # subsequent runs correctly compare mtimes.
  touch "$sentinel"
}

build_ts() {
  # Skip tsc if the compiled output is newer than every source file. On a
  # small VM like B (2 cores / 3.6 GB), an unconditional tsc run adds 8-12s
  # to every start. Users hate this — "./exec_cds.sh restart" used to feel
  # instant, now it drags because tsc has nothing to do yet still runs.
  #
  # Strategy: use git HEAD SHA as the cache key (not file mtimes).
  #
  # WHY SHA NOT MTIME: `git checkout` / `git pull` preserves the ORIGINAL
  # commit mtime on checked-out files (so rebasing doesn't "touch"
  # unchanged files). That breaks mtime-based sentinels — after a pull
  # to a newer commit, `find src -newer dist/` returns NOTHING even
  # though src actually changed. We saw this in the wild on 2026-04-18:
  # self-update switched branches successfully, dist/ stayed stale,
  # CDS ran old code for 30+ minutes before anyone noticed.
  #
  # New sentinel: write the compiled commit SHA to dist/.build-sha.
  # Skip only when current HEAD SHA matches what's in that file AND local
  # source/config files are clean. Codex/local development often runs CDS
  # from an uncommitted worktree; HEAD-only caching would otherwise serve
  # stale dist/ code until the next commit.
  local dist="$SCRIPT_DIR/dist/index.js"
  local shafile="$SCRIPT_DIR/dist/.build-sha"
  if [ -f "$dist" ] && [ -f "$shafile" ]; then
    local current_sha last_sha dirty_sources
    current_sha="$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
    last_sha="$(cat "$shafile" 2>/dev/null)"
    dirty_sources="$(git -C "$SCRIPT_DIR" status --porcelain -- src package.json pnpm-lock.yaml package-lock.json tsconfig.json 2>/dev/null || true)"
    if [ -n "$current_sha" ] && [ "$current_sha" = "$last_sha" ] && [ "$current_sha" != "unknown" ] && [ -z "$dirty_sources" ]; then
      info "编译 TypeScript ... (跳过，dist 已对准 HEAD=$current_sha)"
      return 0
    fi
  fi

  info "编译 TypeScript ..."
  npx tsc || true
  [ -f "$dist" ] || { err "编译失败: dist/index.js 不存在"; exit 1; }
  # Stamp the sentinel so the next start can skip correctly
  git -C "$SCRIPT_DIR" rev-parse HEAD > "$shafile" 2>/dev/null || true
}

# Build the React/Vite Dashboard (cds/web/) if present. Output goes to
# cds/web/dist/ which Express serves for the routes registered in
# MIGRATED_REACT_ROUTES (see server.ts installSpaFallback). Unmigrated
# paths fall through to the static pages under cds/web-legacy/.
#
# Idempotent: if dist/ is already current for HEAD and web sources are clean,
# this short-circuits.
# See doc/plan.cds-web-migration.md for the migration timeline.
build_web() {
  local webdir="$SCRIPT_DIR/web"
  local distdir="$webdir/dist"
  local shafile="$distdir/.build-sha"

  if [ ! -d "$webdir" ] || [ ! -f "$webdir/package.json" ]; then
    return 0
  fi

  if [ -f "$shafile" ] && [ -f "$distdir/index.html" ]; then
    local current_sha last_sha dirty_sources
    current_sha="$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
    last_sha="$(cat "$shafile" 2>/dev/null)"
    dirty_sources="$(git -C "$SCRIPT_DIR" status --porcelain -- web/src web/index.html web/package.json web/pnpm-lock.yaml web/tsconfig.json web/vite.config.ts 2>/dev/null || true)"
    if [ -n "$current_sha" ] && [ "$current_sha" = "$last_sha" ] && [ "$current_sha" != "unknown" ] && [ -z "$dirty_sources" ]; then
      info "构建 web (React + Vite) ... (跳过，已对准 HEAD=$current_sha)"
      return 0
    fi
  fi

  info "构建 web (React + Vite) ..."
  local build_log; build_log="$STATE_DIR/web-build.log"
  local build_error_marker; build_error_marker="$distdir/.build-error"
  # 失败标记之前的痕迹清掉 — 后面只在真失败时再写
  rm -f "$build_error_marker" 2>/dev/null || true
  (
    cd "$webdir" || exit 1
    if [ ! -d node_modules ]; then
      pnpm install --frozen-lockfile 2>/dev/null || pnpm install
    fi
    pnpm build
  ) > "$build_log" 2>&1
  local build_exit=$?

  if [ "$build_exit" -ne 0 ]; then
    # 2026-05-04 fix(用户反馈"已更新但 UI 没变" — 根因 build_web 静默 return 0):
    # 之前是 || { warn ...; return 0; } 一句话吞 error,操作员看不到根因。
    # 现在:写 .build-error 文件 + 把日志最后 30 行打到终端 + return 0(不阻断
    # 启动 — 否则 CDS 直接死,运维更难恢复)。
    # `/api/self-status` 看到 .build-error 存在就在响应里 surface,前端 GlobalUpdateBadge
    # 显示红色"前端 bundle 异常"提示 → 用户主动来排查。
    err "web 构建失败 (pnpm build exit=$build_exit) — 详细日志: $build_log"
    echo "──── pnpm build 输出最后 30 行 ────" >&2
    tail -30 "$build_log" >&2 2>/dev/null || true
    echo "──────────────────────────────────" >&2
    {
      echo "ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "head_sha=$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
      echo "exit=$build_exit"
      echo "log_path=$build_log"
      echo "tail_30:"
      tail -30 "$build_log" 2>/dev/null || true
    } > "$build_error_marker" 2>/dev/null || true
    warn "web/dist/ 仍是上次成功 build 的版本 — 老 UI 继续可用,但用户看不到这次的代码改动"
    warn "前端会显示「前端 bundle 比后端旧」红色徽章提示"
    return 0
  fi

  if [ -f "$distdir/index.html" ]; then
    git -C "$SCRIPT_DIR" rev-parse HEAD > "$shafile" 2>/dev/null || true
    ok "web 构建完成"
  else
    err "web 构建命令成功但产物缺失 (dist/index.html 不存在)"
    {
      echo "ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "head_sha=$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
      echo "exit=0_but_no_index_html"
      echo "log_path=$build_log"
    } > "$build_error_marker" 2>/dev/null || true
    return 0
  fi
}

# ══ nginx config rendering ═══════════════════════════════════════

# Render one block of shared proxy directives (reused in every location).
proxy_directives() {
  cat <<'EOP'
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_set_header X-Forwarded-Port  $server_port;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;
        proxy_buffering off;
        proxy_cache     off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        add_header Cache-Control    "no-cache" always;
        add_header X-Accel-Buffering "no"      always;
EOP
}

# Emit a server block for a single root domain D.
#   Dashboard: server_name D cds.D;
#   Preview  : server_name *.D;
# Per-domain TLS: if certs/D.{crt,key} exist we add :443 ssl directives.
emit_server_blocks() {
  local d="$1" has_tls=0
  if [ -f "$NGINX_CERTS_DIR/${d}.crt" ] && [ -f "$NGINX_CERTS_DIR/${d}.key" ]; then
    has_tls=1
  fi

  local ssl_block=""
  if [ "$has_tls" -eq 1 ]; then
    ssl_block=$'    listen 443 ssl;\n    listen [::]:443 ssl;\n    http2 on;\n    ssl_certificate     /etc/nginx/certs/'"${d}"$'.crt;\n    ssl_certificate_key /etc/nginx/certs/'"${d}"$'.key;\n    ssl_protocols       TLSv1.2 TLSv1.3;\n'
  fi

  echo "# ── ${d} (Dashboard) ──"
  echo "server {"
  echo "    listen 80;"
  echo "    listen [::]:80;"
  [ -n "$ssl_block" ] && printf '%s' "$ssl_block"
  echo "    server_name ${d} cds.${d};"
  echo ""
  echo "    location ^~ /.well-known/acme-challenge/ {"
  echo "        root /var/www/html;"
  echo "        allow all;"
  echo "    }"
  echo ""
  echo "    location / {"
  echo "        proxy_pass http://cds_master;"
  proxy_directives
  echo "    }"
  echo "}"
  echo ""

  echo "# ── *.${d} (Preview) ──"
  echo "server {"
  echo "    listen 80;"
  echo "    listen [::]:80;"
  [ -n "$ssl_block" ] && printf '%s' "$ssl_block"
  echo "    server_name *.${d};"
  echo ""
  echo "    # Friendly fallback when CDS master is unreachable or times out."
  echo "    # Fires only on nginx-generated 502/504 (upstream dead); upstream"
  echo "    # 503 HTML responses from CDS pass through untouched because"
  echo "    # proxy_intercept_errors defaults to off. See cds/src/services/proxy.ts"
  echo "    # serveStartingPage and .claude/rules/cds-auto-deploy.md."
  echo "    error_page 502 504 = @cds_waiting;"
  echo "    location @cds_waiting {"
  echo "        root /var/www/html;"
  echo "        try_files /cds-waiting.html =503;"
  echo "        add_header Retry-After 5 always;"
  echo "        add_header Cache-Control \"no-cache, no-store, must-revalidate\" always;"
  echo "        default_type text/html;"
  echo "        internal;"
  echo "    }"
  echo "    location = /cds-waiting.html {"
  echo "        root /var/www/html;"
  echo "        add_header Cache-Control \"no-cache, no-store, must-revalidate\" always;"
  echo "    }"
  echo ""
  echo "    location ^~ /.well-known/acme-challenge/ {"
  echo "        root /var/www/html;"
  echo "        allow all;"
  echo "    }"
  echo ""
  echo "    location / {"
  echo "        proxy_pass http://cds_worker;"
  proxy_directives
  echo "    }"
  echo "}"
  echo ""
}

# Static waiting page baked into nginx. Fires when cds_worker (CDS master)
# is unreachable — typically during self-update restart or process crash.
# For every other half-ready state CDS's own proxy renders a richer loading
# page with service-level progress; this file is the last-resort safety net.
# See .claude/rules/cds-auto-deploy.md.
write_waiting_html() {
  local target="$NGINX_WWW_DIR/cds-waiting.html"
  mkdir -p "$NGINX_WWW_DIR"
  local content
  content=$(cat <<'WAITING_HTML'
<!DOCTYPE html>
<html lang="zh"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>预览环境准备中</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{max-width:460px;width:100%;padding:32px;background:#161b22;border:1px solid #30363d;border-radius:12px;text-align:center}
.spinner{width:28px;height:28px;border:3px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}
h2{font-size:16px;font-weight:600;color:#f0f6fc;margin-bottom:8px}
.tag{display:inline-block;font-size:11px;padding:2px 8px;border-radius:99px;background:#1f6feb22;color:#58a6ff;border:1px solid #1f6feb55;margin-bottom:16px}
.desc{font-size:13px;color:#8b949e;line-height:1.6;margin-bottom:16px}
.kbd{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;color:#c9d1d9;background:#21262d;padding:2px 6px;border-radius:4px}
.hint{font-size:12px;color:#6e7681}
</style>
</head><body>
<div class="card">
  <div class="spinner"></div>
  <h2>预览环境准备中</h2>
  <div class="tag">CDS 控制面暂时不可达</div>
  <div class="desc">
    分支预览正在构建或 CDS 正在自升级，几秒钟后会自动恢复。<br>
    本页面每 <span class="kbd">3s</span> 自动刷新。
  </div>
  <div class="hint">如果持续看到此页面，请在 PR Checks 面板查看 CDS Deploy 状态。</div>
</div>
<script>setTimeout(function(){location.reload()},3000)</script>
</body></html>
WAITING_HTML
)
  write_if_changed "$target" "$content"
}

# Write content to a target file only if it differs from what's on disk.
# Appends the basename to NGINX_CHANGED_FILES when a write happens.
NGINX_CHANGED_FILES=""
write_if_changed() {
  local target="$1" content="$2"
  if [ -f "$target" ] && printf '%s' "$content" | cmp -s - "$target"; then
    return 0
  fi
  printf '%s' "$content" > "$target"
  NGINX_CHANGED_FILES="${NGINX_CHANGED_FILES}$(basename "$target") "
}

nginx_changed() {
  case " $NGINX_CHANGED_FILES " in
    *" $1 "*) return 0 ;;
    *)        return 1 ;;
  esac
}

render_nginx() {
  local domains_csv="${CDS_ROOT_DOMAINS:-}"
  if [ -z "$domains_csv" ]; then
    warn "CDS_ROOT_DOMAINS 未配置，跳过 nginx 渲染 (请先运行 ./exec_cds.sh init)"
    return 1
  fi

  local master="${CDS_MASTER_PORT:-9900}"
  local worker="${CDS_WORKER_PORT:-5500}"

  mkdir -p "$NGINX_CERTS_DIR" "$NGINX_WWW_DIR/.well-known/acme-challenge"
  NGINX_CHANGED_FILES=""

  # Static last-resort waiting page served by nginx itself when cds_worker
  # is unreachable. Generated alongside the per-domain configs so a fresh
  # install has it ready before any upstream 502 can happen.
  write_waiting_html

  # Top-level nginx.conf (static base, rarely changes)
  local base_content
  base_content=$(cat <<'NGINX_BASE'
# Generated by exec_cds.sh — do not edit by hand
worker_processes auto;

events {
    worker_connections 10240;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    client_max_body_size 200m;
    sendfile        on;
    tcp_nopush      on;
    tcp_nodelay     on;
    keepalive_timeout 65;

    access_log  /var/log/nginx/access.log;
    error_log   /var/log/nginx/error.log warn;

    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }

    include /etc/nginx/conf.d/*.conf;
}
NGINX_BASE
)
  write_if_changed "$NGINX_CONF" "$base_content"

  # cds-site.conf (the per-domain server blocks)
  local site_content
  site_content=$({
    echo "# Generated by exec_cds.sh — do not edit by hand"
    echo "# CDS_ROOT_DOMAINS=${domains_csv}"
    echo ""
    echo "upstream cds_master { server 127.0.0.1:${master}; keepalive 8;  }"
    echo "upstream cds_worker { server 127.0.0.1:${worker}; keepalive 16; }"
    echo ""

    local raw d
    IFS=',' read -r -a _dom_arr <<< "$domains_csv"
    for raw in "${_dom_arr[@]}"; do
      d="$(printf '%s' "$raw" | xargs)"
      [ -n "$d" ] || continue
      emit_server_blocks "$d"
    done
  })
  write_if_changed "$NGINX_SITE_CONF" "$site_content"

  # docker compose file for the host nginx container
  local compose_content
  compose_content=$(cat <<EOF
# Generated by exec_cds.sh — do not edit by hand
services:
  nginx:
    image: nginx:1.27-alpine
    container_name: ${NGINX_CONTAINER}
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./cds-site.conf:/etc/nginx/conf.d/cds.conf:ro
      - ./certs:/etc/nginx/certs:ro
      - ./www:/var/www/html:rw
EOF
)
  write_if_changed "$NGINX_COMPOSE_FILE" "$compose_content"

  if [ -n "$NGINX_CHANGED_FILES" ]; then
    local pretty; pretty="$(printf '%s' "$domains_csv" | tr ',' ' ')"
    ok "nginx 配置已更新 (domains:$pretty, changed:$NGINX_CHANGED_FILES)"
  fi
  return 0
}

# ══ nginx lifecycle ══════════════════════════════════════════════

nginx_compose() {
  (cd "$NGINX_DIR" && docker compose -f "$NGINX_COMPOSE_FILE" "$@")
}

nginx_running() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$NGINX_CONTAINER"
}

nginx_up() {
  render_nginx || return 0

  local running=false
  nginx_running && running=true

  # Case 1: container not running OR compose file changed → (re)create it
  if ! $running || nginx_changed "nginx.compose.yml"; then
    local up_log; up_log="$(mktemp 2>/dev/null || echo /tmp/cds-nginx-up.$$.log)"
    if nginx_compose up -d >"$up_log" 2>&1; then
      ok "nginx 已启动 (容器: $NGINX_CONTAINER)"
      rm -f "$up_log" 2>/dev/null || true
    else
      warn "nginx 启动失败 — 输出如下:"
      sed 's/^/    /' "$up_log" >&2
      echo "    手动复现: docker compose -f $NGINX_COMPOSE_FILE up -d" >&2
      rm -f "$up_log" 2>/dev/null || true
      return 1
    fi
    return 0
  fi

  # Case 2: container running, only site/base conf changed → hot reload
  if nginx_changed "cds-site.conf" || nginx_changed "nginx.conf"; then
    if docker exec "$NGINX_CONTAINER" nginx -t >/dev/null 2>&1; then
      docker exec "$NGINX_CONTAINER" nginx -s reload >/dev/null 2>&1 || true
      ok "nginx 热重载完成 (无停机)"
    else
      warn "nginx 新配置 -t 校验失败，跳过 reload 以保持现有配置可用"
    fi
    return 0
  fi

  # Case 3: nothing changed, container running → silent no-op
  return 0
}

nginx_down() {
  [ -f "$NGINX_COMPOSE_FILE" ] || return 0
  nginx_compose down >/dev/null 2>&1 || true
}

# ══ CDS process lifecycle ════════════════════════════════════════

read_port() {
  local field="$1" fallback="$2" v=""
  if [ -f "$CONFIG_FILE" ]; then
    v="$(grep -oE "\"${field}\"[[:space:]]*:[[:space:]]*[0-9]+" "$CONFIG_FILE" 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
  fi
  [ -n "$v" ] && printf '%s\n' "$v" || printf '%s\n' "$fallback"
}

cds_is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid; pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

cds_find_pid_on_port() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tlnp "( sport = :$port )" 2>/dev/null \
      | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u | head -1
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1
    return 0
  fi
}

cds_port_is_listening() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tln "( sport = :$port )" 2>/dev/null | grep -q ":${port}" && return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  fi
  return 1
}

# Post-start liveness probe — calls /healthz?probe=routes which performs:
#   1. state file readable
#   2. Docker socket reachable
#   3. SPA assets present (web/dist or web-legacy/)
#   4. critical SPA routes registered on Express router
#   5. internal HTTP probe of /project-list, /branch-list, /cds-settings
#
# Returns 0 if everything is green, non-zero with the failing checks
# printed to stderr otherwise. Retries for up to 8s after the port is
# bound — the first /healthz call may race the docker version timeout.
cds_post_start_probe() {
  local port="$1"
  local url="http://127.0.0.1:${port}/healthz?probe=routes"
  if ! command -v curl >/dev/null 2>&1; then
    warn "保活探针跳过: 未安装 curl"
    return 0
  fi

  local body http_code attempt=0
  while [ "$attempt" -lt 8 ]; do
    body=""
    http_code=""
    # -m 5: per-request timeout. -w writes the http code on a new line so
    # we can split body and code without temp files. -s: silent.
    local response; response="$(curl -sS -m 5 -w '\n__HTTP_CODE__:%{http_code}' "$url" 2>&1 || true)"
    http_code="$(printf '%s' "$response" | sed -n 's/^__HTTP_CODE__://p' | tail -1)"
    body="$(printf '%s' "$response" | sed '/^__HTTP_CODE__:/d')"
    if [ "$http_code" = "200" ]; then
      # Pretty-print summary if jq is available; otherwise show raw line.
      if command -v jq >/dev/null 2>&1; then
        local summary; summary="$(printf '%s' "$body" | jq -r '
          .checks
          | to_entries
          | map("\(.key)=\(.value.ok)")
          | join(", ")
        ' 2>/dev/null || echo "(jq parse failed)")"
        info "保活探针通过: ${summary}"
      else
        info "保活探针通过 (HTTP 200)"
      fi
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  err "保活探针失败 (HTTP ${http_code:-?})"
  if [ -n "$body" ]; then
    if command -v jq >/dev/null 2>&1; then
      printf '%s\n' "$body" | jq '.' 1>&2 || printf '%s\n' "$body" 1>&2
    else
      printf '%s\n' "$body" 1>&2
    fi
  fi
  return 1
}

cds_stop() {
  local stopped=0

  if [ -f "$PID_FILE" ]; then
    local pid; pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      info "停止 CDS (PID: $pid) ..."
      kill "$pid" 2>/dev/null || true
      local i=0
      while [ "$i" -lt 10 ] && kill -0 "$pid" 2>/dev/null; do
        sleep 1; i=$((i + 1))
      done
      kill -9 "$pid" 2>/dev/null || true
      stopped=1
    fi
    rm -f "$PID_FILE"
  fi

  # Clean up any stray node/tsx processes still holding master port
  local mp; mp="$(read_port masterPort "${CDS_MASTER_PORT:-9900}")"
  local orphan; orphan="$(cds_find_pid_on_port "$mp" || true)"
  if [ -n "$orphan" ]; then
    local cmd; cmd="$(ps -p "$orphan" -o comm= 2>/dev/null | tr -d ' ' || true)"
    case "$cmd" in
      node|tsx|ts-node|npx)
        info "清理占用 ${mp} 的残余进程 (${cmd}:${orphan})"
        kill "$orphan" 2>/dev/null || true
        sleep 1
        kill -9 "$orphan" 2>/dev/null || true
        stopped=1
        ;;
    esac
  fi

  if [ "$stopped" -eq 1 ]; then
    ok "CDS 已停止"
  else
    info "CDS 未在运行"
  fi
}

cds_start_background() {
  check_deps
  install_deps
  build_ts
  build_web

  if cds_is_running; then
    ok "CDS 已在运行 (PID: $(cat "$PID_FILE"))"
    return 0
  fi

  # Safety net: always re-source .cds.env right before spawning the Node
  # process so the child inherits the on-disk values, not whatever stale
  # copy the parent shell captured minutes ago. Without this, any caller
  # that modifies .cds.env (connect/disconnect/init) would need to
  # remember to re-export every variable by hand — too easy to miss.
  load_env

  # CDS 连 Mongo 前先确保容器 running。避免 CDS 启动 → 连 Mongo 失败 →
  # throw exit → systemd 循环重启的场景。失败不 fatal（让 CDS 给更明确
  # 的错误）。
  ensure_cds_mongo_running || true

  local mp; mp="$(read_port masterPort "${CDS_MASTER_PORT:-9900}")"
  local wp; wp="$(read_port workerPort "${CDS_WORKER_PORT:-5500}")"

  # Reuse listener if another shell already started CDS on master port
  local existing; existing="$(cds_find_pid_on_port "$mp" || true)"
  if [ -n "$existing" ]; then
    echo "$existing" > "$PID_FILE"
    ok "复用已运行的 CDS (PID: $existing, port: $mp)"
    return 0
  fi

  # P4 Part 18 (G1.4): ensure multi-repo clone dir exists + exported.
  export CDS_REPOS_BASE="${CDS_REPOS_BASE:-$REPOS_BASE_DEFAULT}"
  mkdir -p "$CDS_REPOS_BASE"

  info "启动 CDS (后台模式) ..."
  nohup node dist/index.js "$CONFIG_FILE" > "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  # Wait for master port to bind (max 20s)
  local i=0
  while [ "$i" -lt 20 ]; do
    if cds_port_is_listening "$mp"; then
      # Port is bound. Now verify the SPA + critical routes actually serve —
      # otherwise we end up in the "process is up but every page is 404"
      # state we've shipped to prod three times. The deep probe checks file
      # presence + Express route registration + actually exercises each
      # critical route via internal HTTP.
      if ! cds_post_start_probe "$mp"; then
        err "CDS 启动后保活探针失败 — 进程在 ${mp} 端口监听,但关键路由不可用"
        err "详细原因见上方 /healthz?probe=routes 输出。常见根因:"
        err "  - cds/web/dist/ 没编译 (重跑 ./exec_cds.sh restart 触发 build_web)"
        err "  - cds/web-legacy/ 被删 (检查 git status)"
        err "  - 安装路径漂移 (PID $pid 的 cwd 不是当前目录)"
        return 1
      fi
      ok "CDS 启动完成 (保活探针通过)"
      echo
      echo "  PID:        $pid"
      echo "  Log:        $LOG_FILE"
      echo "  Dashboard:  http://localhost:${mp}"
      echo "  Gateway:    http://localhost:${wp}"
      echo
      echo "  Stop:   ./exec_cds.sh stop"
      echo "  Logs:   ./exec_cds.sh logs"
      echo "  Health: curl http://localhost:${mp}/healthz?probe=routes"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done

  err "CDS 未能在 ${mp} 端口完成启动 — 查看日志: $LOG_FILE"
  tail -30 "$LOG_FILE" 2>/dev/null || true
  exit 1
}

cds_start_foreground() {
  check_deps
  install_deps
  build_ts
  build_web
  # P4 Part 18 (G1.4): same multi-repo clone dir setup as background mode.
  load_env
  ensure_cds_mongo_running || true
  export CDS_REPOS_BASE="${CDS_REPOS_BASE:-$REPOS_BASE_DEFAULT}"
  mkdir -p "$CDS_REPOS_BASE"
  info "启动 CDS (前台，Ctrl+C 退出)"
  exec node dist/index.js "$CONFIG_FILE"
}

# ══ init (interactive setup) ══════════════════════════════════════

read_default() {
  local var="$1" default="$2" input
  # Prompt goes to /dev/tty so it isn't captured by $() substitution;
  # read also reads from /dev/tty so piped stdin doesn't interfere.
  printf "  %s%s%s [%s]: " "$B" "$var" "$N" "$default" >/dev/tty
  read -r input </dev/tty
  printf '%s' "${input:-$default}"
}

read_secret() {
  local var="$1" hint="$2" input
  if [ -n "$hint" ]; then
    printf "  %s%s%s (%s): " "$B" "$var" "$N" "$hint" >/dev/tty
  else
    printf "  %s%s%s: " "$B" "$var" "$N" >/dev/tty
  fi
  read -rs input </dev/tty
  printf '\n' >/dev/tty
  printf '%s' "$input"
}

init_cmd() {
  echo
  printf '  %sCDS 初始化%s\n' "$B" "$N"
  echo  "  ═══════════════════════════════"
  echo

  # Phase 1 of init: dependency check + auto-install.
  # Per .claude/rules/quickstart-zero-friction.md — assume the user is a
  # beginner and bootstrap the environment ourselves instead of bailing
  # with "command not found".
  check_deps

  # Phase 2: collect config via interactive prompts.
  local cur_user cur_pass cur_jwt cur_doms
  cur_user="$(read_env_value CDS_USERNAME)"
  cur_pass="$(read_env_value CDS_PASSWORD)"
  cur_jwt="$(read_env_value CDS_JWT_SECRET)"
  cur_doms="$(read_env_value CDS_ROOT_DOMAINS)"

  local new_user new_pass new_jwt new_doms

  new_user="$(read_default CDS_USERNAME "${cur_user:-admin}")"

  new_pass="$(read_secret CDS_PASSWORD "${cur_pass:+回车保持原密码}")"
  new_pass="${new_pass:-$cur_pass}"
  if [ -z "$new_pass" ]; then
    err "密码不能为空"
    exit 1
  fi

  if [ -n "$cur_jwt" ]; then
    new_jwt="$cur_jwt"
    info "JWT Secret 保持不变"
  else
    new_jwt="$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)"
    info "已自动生成 JWT Secret"
  fi

  new_doms="$(read_default CDS_ROOT_DOMAINS "${cur_doms:-}")"
  if [ -z "$new_doms" ]; then
    err "CDS_ROOT_DOMAINS 不能为空 (示例: miduo.org,mycds.net)"
    exit 1
  fi

  echo
  echo "  ─── 将写入 $ENV_FILE ───"
  echo "    CDS_USERNAME     = ${new_user}"
  echo "    CDS_PASSWORD     = ****${new_pass: -4}"
  echo "    CDS_JWT_SECRET   = ****${new_jwt: -4}"
  echo "    CDS_ROOT_DOMAINS = ${new_doms}"
  echo

  printf "  确认写入? [Y/n]: "
  local confirm; read -r confirm
  if [[ "$confirm" =~ ^[Nn] ]]; then
    warn "已取消"
    exit 0
  fi

  cat > "$ENV_FILE" <<EOF
# CDS 本地环境 — 由 ./exec_cds.sh init 生成于 $(date +%F)
# 这是 CDS 唯一用户配置入口 — 所有变量使用 CDS_ 前缀
export CDS_USERNAME="${new_user}"
export CDS_PASSWORD="${new_pass}"
export CDS_JWT_SECRET="${new_jwt}"
export CDS_ROOT_DOMAINS="${new_doms}"
EOF
  chmod 600 "$ENV_FILE"
  ok "已写入 $ENV_FILE"

  # ── Phase 3: MongoDB (默认，持久化所有 CDS state) ──────────────────
  #
  # 启用后：
  #   - 所有项目/分支/Agent key/环境变量等状态住在 Mongo，不再用 state.json
  #   - 容器名 cds-state-mongo（独立于业务 mongo，避免污染）
  #   - 宿主机端口 27018（避开业务 mongo 的 27017）
  #   - 数据卷 cds-state-mongo-data（docker volume，不随容器删除）
  #   - 写入 .cds.env 四个变量，node 启动自己 parse 直接进 Mongo 模式
  #   - CDS_MONGO_CONTAINER 让 start 命令启动前能 docker start（自愈）
  echo
  echo "  ─── 数据持久化 ───"
  echo "  CDS 默认使用 MongoDB 多 collection 存储（projects / branches / global）。"
  echo "  不再把运行状态写进单个 state.json；端口 27018（独立于业务 mongo）。"
  echo
  local MONGO_CONTAINER="cds-state-mongo"
  local MONGO_PORT="${CDS_MONGO_PORT:-27018}"
  local MONGO_DB="${CDS_MONGO_DB:-cds_state_db}"
  local MONGO_URI="mongodb://127.0.0.1:${MONGO_PORT}/${MONGO_DB}"

  # 端口冲突检测
  if ss -tln "( sport = :${MONGO_PORT} )" 2>/dev/null | grep -q ":${MONGO_PORT}"; then
    warn "端口 ${MONGO_PORT} 已被占用"
    printf "  改用哪个端口? (回车默认 27019): "
    local alt_port; read -r alt_port
    MONGO_PORT="${alt_port:-27019}"
    MONGO_URI="mongodb://127.0.0.1:${MONGO_PORT}/${MONGO_DB}"
  fi

  # 容器存在检查 + 启动。Mongo 是新初始化的唯一默认存储；失败时中止，
  # 不再静默退回 state.json，避免 fresh install 又出现遗留 default / 单文件状态。
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$MONGO_CONTAINER"; then
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$MONGO_CONTAINER"; then
      ok "MongoDB 容器已在运行 (${MONGO_CONTAINER}:${MONGO_PORT})"
    else
      info "启动已有 MongoDB 容器…"
      docker start "$MONGO_CONTAINER" >/dev/null \
        && ok "MongoDB 容器已启动" \
        || { err "启动 MongoDB 容器失败，请检查 docker 状态"; exit 1; }
    fi
  else
    info "正在拉起 MongoDB 7 容器（首次可能需要拉取镜像，请稍候）…"
    docker run -d \
      --name "$MONGO_CONTAINER" \
      --restart unless-stopped \
      -p "127.0.0.1:${MONGO_PORT}:27017" \
      -v cds-state-mongo-data:/data/db \
      mongo:7 >/dev/null 2>&1 \
    && ok "MongoDB 容器已启动 (${MONGO_CONTAINER}:${MONGO_PORT}，数据卷: cds-state-mongo-data)" \
    || { err "启动 MongoDB 容器失败，请检查 Docker 是否正常运行"; exit 1; }
  fi

  # 等 Mongo 健康（最多 30s）
  info "等待 MongoDB 就绪（mongosh ping）…"
  local mongo_ready=0
  local i=0
  while [ "$i" -lt 30 ]; do
    if docker exec "$MONGO_CONTAINER" mongosh --quiet --eval 'db.runCommand({ping:1}).ok' 2>/dev/null | grep -q '^1$'; then
      mongo_ready=1
      break
    fi
    sleep 1
    i=$((i + 1))
  done
  if [ "$mongo_ready" -eq 1 ]; then
    ok "MongoDB 就绪 (${i}s)"
  else
    warn "MongoDB 30s 内未就绪，CDS 启动时会再次重试"
  fi

  env_upsert CDS_MONGO_URI "${MONGO_URI}"
  env_upsert CDS_MONGO_DB "${MONGO_DB}"
  env_upsert CDS_STORAGE_MODE "mongo-split"
  env_upsert CDS_AUTH_BACKEND "mongo"
  env_upsert CDS_MONGO_CONTAINER "$MONGO_CONTAINER"
  ok "已启用 MongoDB 多 collection 持久化存储 (CDS_STORAGE_MODE=mongo-split)"
  info "  URI:       ${MONGO_URI}"
  info "  Database:  ${MONGO_DB}"
  info "  Container: ${MONGO_CONTAINER}"

  load_env
  render_nginx || true

  local first; first="$(printf '%s' "$new_doms" | cut -d',' -f1 | xargs)"
  echo
  echo "  下一步："
  echo "    ./exec_cds.sh start       # 后台启动 CDS + Nginx"
  echo "    ./exec_cds.sh cert        # (可选) 签发 Let's Encrypt 证书"
  echo "    访问:  http://${first}   或   https://${first}"
  echo
}

# ══ other commands ═══════════════════════════════════════════════

status_cmd() {
  load_env
  echo
  printf '  %sCDS 运行状态%s\n' "$B" "$N"
  echo  "  ─────────────────────"

  if cds_is_running; then
    printf "  CDS:       %srunning%s (PID: %s)\n" "$G" "$N" "$(cat "$PID_FILE")"
  else
    printf "  CDS:       %sstopped%s\n" "$Y" "$N"
  fi

  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$NGINX_CONTAINER"; then
    printf "  Nginx:     %srunning%s (容器: %s)\n" "$G" "$N" "$NGINX_CONTAINER"
  else
    printf "  Nginx:     %sstopped%s\n" "$Y" "$N"
  fi

  [ -n "${CDS_ROOT_DOMAINS:-}" ] && echo  "  Domains:   ${CDS_ROOT_DOMAINS}"
  echo  "  Log:       $LOG_FILE"
  echo
}

logs_cmd() {
  if [ ! -f "$LOG_FILE" ]; then
    warn "日志文件不存在: $LOG_FILE"
    return 0
  fi
  tail -100f "$LOG_FILE"
}

# Manual on-demand health probe — same depth as the post-restart self-check.
# Run this after any deploy or anytime users report "all pages 404" to
# instantly see whether SPA routes are serving without SSH'ing into the box.
healthz_cmd() {
  load_env
  local mp; mp="$(read_port masterPort "${CDS_MASTER_PORT:-9900}")"
  if ! cds_port_is_listening "$mp"; then
    err "CDS 未在 ${mp} 端口监听 — 进程没起,先 ./exec_cds.sh start"
    return 1
  fi
  cds_post_start_probe "$mp"
}

# P4 Part 18 hardening: install systemd unit with auto-filled paths.
#
# The shipped cds/systemd/cds-master.service has hardcoded example
# paths (/opt/prd_agent). This helper reads the running install's
# actual paths, rewrites the unit file into /tmp, and prints the
# exact install commands. Users can pipe it through sudo or copy-
# paste. No writes to /etc happen automatically because this script
# has no sudo context.
#
# P4 Part 18 hardening v2 (user-reported): the first version of this
# command only substituted binary paths. It missed the fact that
# systemd services run with a minimal PATH that typically does NOT
# include nvm's node bin directory. So when pnpm/npx ran, their
# `#!/usr/bin/env node` shebang failed with
#   /usr/bin/env: 'node': No such file or directory
# even though pnpm's absolute path was correct.
#
# Fix: inject `Environment=PATH=...` with the node bin dir prepended
# so every child process sees node on PATH. Also inject NODE_PATH so
# pnpm can find its own modules in nvm's global dir.
install_systemd_cmd() {
  local repo_root
  repo_root="$(cd "$SCRIPT_DIR/.." && pwd)"
  local cds_dir="$SCRIPT_DIR"
  local pnpm_bin tsc_bin node_bin node_bin_dir
  node_bin="$(command -v node 2>/dev/null || true)"
  pnpm_bin="$(command -v pnpm 2>/dev/null || true)"
  tsc_bin="$(command -v npx 2>/dev/null || true)"
  if [ -z "$node_bin" ] || [ -z "$pnpm_bin" ] || [ -z "$tsc_bin" ]; then
    err "缺少 systemd 必需命令：node/pnpm/npx"
    echo
    echo "  当前检测："
    echo "    node: ${node_bin:-未找到}"
    echo "    pnpm: ${pnpm_bin:-未找到}"
    echo "    npx : ${tsc_bin:-未找到}"
    echo
    echo "  请先在当前用户下装好 Node.js 20+ 和 pnpm，再重新运行："
    echo "    cd $cds_dir && ./exec_cds.sh install-systemd"
    exit 1
  fi
  # Derive the directory that holds node/pnpm/npx. For nvm installs
  # this is e.g. /root/.nvm/versions/node/v22.22.2/bin — systemd needs
  # this prepended to PATH so the shebang `#!/usr/bin/env node` that
  # pnpm/npx use resolves to nvm's node and not "command not found".
  node_bin_dir="$(dirname "$node_bin")"

  local template="$cds_dir/systemd/cds-master.service"
  local out="/tmp/cds-master.service.$$"

  [ -f "$template" ] || { err "模板不存在: $template"; exit 1; }

  # Use a pipe so we can inject Environment=PATH on the fly. The
  # template ships with the dev-friendly defaults; we patch:
  #   - WorkingDirectory / CDS_REPO_ROOT to the actual install
  #   - Binary absolute paths for pnpm/node/npx
  #   - NEW: Environment=PATH=<node_bin_dir>:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  #     inserted right before the existing NODE_ENV line so the rest
  #     of the unit inherits it.
  sed \
    -e "s|/opt/prd_agent/cds|$cds_dir|g" \
    -e "s|/opt/prd_agent|$repo_root|g" \
    -e "s|/usr/bin/pnpm|$pnpm_bin|g" \
    -e "s|/usr/bin/node|$node_bin|g" \
    -e "s|/usr/bin/npx|$tsc_bin|g" \
    -e "s|^Environment=PATH=.*|Environment=PATH=$node_bin_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin|" \
    "$template" > "$out"

  echo
  ok "已生成 $out（路径已自动填入当前 CDS 安装位置）"
  echo
  echo "  下一步（请复制执行）："
  echo
  echo "    sudo cp $out /etc/systemd/system/cds-master.service"
  echo "    sudo systemctl daemon-reload"
  echo "    sudo systemctl enable --now cds-master"
  echo
  echo "  验证："
  echo "    systemctl status cds-master"
  echo "    journalctl -u cds-master -f"
  echo
  echo "  启用后，下次 CDS 崩溃会被 systemd 自动重启（最多 5 次/分钟）。"
  echo "  结合 POST /api/self-update 的 pre-check 预检，基本能杜绝"
  echo "  "\'"self-update 把自己搞死"\'" 这种 bootstrap trap。"
  echo
}

# Ensure crontab is available before running the acme.sh installer.
# acme.sh's online installer (get.acme.sh) refuses to install without a
# crontab unless --force is passed, because cert auto-renewal needs cron.
# Returns 0 if crontab is now available, 1 if not.
#
# Trigger case: Amazon Linux 2023 / 最小化的 RHEL 系统默认不带 cronie，
# 用户跑 `cert` 子命令会卡在 "Pre-check failed, cannot install."
ensure_crontab() {
  if command -v crontab >/dev/null 2>&1; then
    return 0
  fi
  warn "未检测到 crontab — acme.sh 安装时会拒绝继续"
  local pkg=""
  case "$(detect_os)" in
    ubuntu|debian) pkg="cron" ;;
    centos|rhel|fedora) pkg="cronie" ;;
    arch) pkg="cronie" ;;
    alpine) pkg="dcron" ;;
    macos) return 1 ;;  # macOS 自带 launchd，但 cron 通常已存在
  esac
  if [ -z "$pkg" ]; then
    warn "未识别的发行版，无法自动安装 cron — 后续会用 --force 跳过"
    return 1
  fi
  if ! confirm "是否自动安装 $pkg 以启用证书自动续签?"; then
    info "跳过自动安装 — 后续会用 --force 安装 acme.sh (证书无法自动续签)"
    return 1
  fi
  if try_pkg_install "$pkg"; then
    # Try to start the service — service name varies between cron/crond
    case "$(detect_os)" in
      centos|rhel|fedora|arch) sudo systemctl enable --now crond 2>/dev/null || true ;;
      ubuntu|debian)           sudo systemctl enable --now cron  2>/dev/null || true ;;
      alpine)                  sudo rc-update add dcron default 2>/dev/null || true
                               sudo rc-service dcron start      2>/dev/null || true ;;
    esac
    if command -v crontab >/dev/null 2>&1; then
      ok "crontab 已就绪"
      return 0
    fi
  fi
  warn "$pkg 自动安装失败 — 后续会用 --force 安装 acme.sh"
  return 1
}

# Install acme.sh if missing, handling missing crontab gracefully.
# $1: domains_csv — first domain becomes the registration email's local part.
# Returns 0 if acme.sh is ready to invoke, 1 if installation failed.
ensure_acme_installed() {
  local domains_csv="$1"
  if [ -f "$HOME/.acme.sh/acme.sh" ]; then
    return 0
  fi
  local primary; primary="$(printf '%s' "$domains_csv" | cut -d',' -f1 | xargs)"
  info "首次运行，安装 acme.sh ..."

  local force_flag=""
  if ! ensure_crontab; then
    force_flag="--force"
  fi

  if [ -n "$force_flag" ]; then
    curl -fsSL https://get.acme.sh | sh -s -- "$force_flag" "email=admin@${primary}" || true
  else
    curl -fsSL https://get.acme.sh | sh -s "email=admin@${primary}" || true
  fi

  if [ ! -f "$HOME/.acme.sh/acme.sh" ]; then
    err "acme.sh 安装失败 — \$HOME/.acme.sh/acme.sh 不存在 (HOME=$HOME)"
    echo  "  常见原因:"
    echo  "    • 缺少 crontab 且 --force 也失败 — 试试: $(pkg_install_cmd) cronie  (RHEL 系)"
    echo  "                                              或: $(pkg_install_cmd) cron    (Debian 系)"
    echo  "    • 网络无法访问 get.acme.sh — 试试设置代理或换镜像"
    echo  "    • \$HOME 不可写 — 当前 HOME=$HOME，试试以普通用户身份再运行 (不要 sudo sh)"
    return 1
  fi
  ok "acme.sh 安装完成: $HOME/.acme.sh/acme.sh"
  if [ -n "$force_flag" ]; then
    warn "已用 --force 安装，证书自动续签未配置 cron — 请手动添加 systemd timer 或 cron 任务"
  fi
  return 0
}

cert_cmd() {
  load_env
  local domains_csv="${CDS_ROOT_DOMAINS:-}"
  [ -n "$domains_csv" ] || { err "CDS_ROOT_DOMAINS 未配置"; exit 1; }

  render_nginx || true
  if ! nginx_up; then
    err "nginx 未能启动 — Let's Encrypt 的 HTTP-01 验证需要 nginx 监听 80 端口"
    echo  "  排查顺序:"
    echo  "    1) 看上面的 docker compose 输出，定位真正报错"
    echo  "    2) 80 端口是否被占用: sudo lsof -i:80"
    echo  "    3) docker daemon 是否可访问: docker ps"
    exit 1
  fi

  ensure_acme_installed "$domains_csv" || exit 1

  "$HOME/.acme.sh/acme.sh" --set-default-ca --server letsencrypt

  local raw d
  IFS=',' read -r -a _dom_arr <<< "$domains_csv"
  for raw in "${_dom_arr[@]}"; do
    d="$(printf '%s' "$raw" | xargs)"
    [ -n "$d" ] || continue
    info "签发 ${d} (含 cds.${d}) ..."
    "$HOME/.acme.sh/acme.sh" --issue \
      -w "$NGINX_WWW_DIR" \
      --keylength ec-256 \
      -d "$d" \
      -d "cds.$d" \
      || warn "${d} 签发失败或已是最新"
    "$HOME/.acme.sh/acme.sh" --install-cert -d "$d" --ecc \
      --key-file       "$NGINX_CERTS_DIR/${d}.key" \
      --fullchain-file "$NGINX_CERTS_DIR/${d}.crt" \
      --reloadcmd      "docker exec $NGINX_CONTAINER nginx -s reload 2>/dev/null || true" \
      || true
  done

  render_nginx
  nginx_compose down >/dev/null 2>&1 || true
  nginx_up
  ok "证书签发流程完成"
}

# ══ cluster bootstrap (connect / disconnect / issue-token / cluster) ═════════
#
# See doc/design.cds-cluster-bootstrap.md for the full design.
# Goal: two-command cluster formation.
#   Machine A (master):  ./exec_cds.sh issue-token         → outputs <token>
#   Machine B (worker):  ./exec_cds.sh connect https://A <token>
# After this, B's resources are added to A's cluster capacity automatically.

# Issue a fresh bootstrap token on the LOCAL machine (becomes/is the master).
# Overwrites any existing token. The token is written to .cds.env and
# consumed server-side on the next successful /api/executors/register.
issue_token_cmd() {
  load_env
  local token; token="$(random_token)"
  [ -n "$token" ] || { err "无法生成 bootstrap token (缺少 openssl 或 /dev/urandom)"; exit 1; }
  local expires_at; expires_at="$(iso_offset_seconds "$BOOTSTRAP_TOKEN_TTL_SECONDS")"
  [ -n "$expires_at" ] || { err "无法计算过期时间 (date 命令不支持)"; exit 1; }

  env_upsert CDS_BOOTSTRAP_TOKEN "$token"
  env_upsert CDS_BOOTSTRAP_TOKEN_EXPIRES_AT "$expires_at"
  ok "已生成 bootstrap token (有效期 15 分钟)"

  if cds_is_running; then
    warn "CDS 正在运行，请重启以加载新 token: ./exec_cds.sh restart"
    warn "或在启动时会自动读取新值 (未启动可忽略)"
  fi

  local master_url
  master_url="${CDS_MASTER_URL:-$(read_env_value CDS_MAIN_DOMAIN)}"
  if [ -z "$master_url" ]; then
    master_url="$(read_env_value CDS_ROOT_DOMAINS | cut -d',' -f1 | xargs)"
    [ -n "$master_url" ] && master_url="https://${master_url}"
  fi
  [ -z "$master_url" ] && master_url="https://<本机公网域名>"

  echo
  printf "  %s下一步%s — 在要加入集群的新机器上执行:\n" "$B" "$N"
  echo
  printf "    %s./exec_cds.sh connect %s %s%s\n" "$G" "$master_url" "$token" "$N"
  echo
  echo "  Token 过期时间: $expires_at"
  echo "  Token 消费后会自动清理并换成永久 token"
  echo
}

# Probe master reachability with curl. On failure, classifies the error and
# prints a hint that points the user at the right thing to fix. Returns 0
# on success, 1 on failure (and prints the hint).
#
# We use --fail-with-body so curl exits non-zero on HTTP 4xx/5xx, and we
# inspect the standard curl exit codes to distinguish DNS / connect / TLS /
# HTTP errors. See `man curl` "EXIT CODES" for the full list.
probe_master() {
  local url="$1"
  local exit_code=0
  curl -fsS -m 10 "${url}/healthz" >/dev/null 2>&1 || exit_code=$?
  if [ "$exit_code" -eq 0 ]; then
    return 0
  fi

  err "无法连接主节点 ${url} (curl exit ${exit_code})"
  case "$exit_code" in
    6)
      echo "  原因: DNS 解析失败"
      echo "  排查: 1) 在主节点上 'host \$DOMAIN' 验证 DNS"
      echo "        2) 在本机 'nslookup \$DOMAIN' 看是否能解析到主节点 IP"
      ;;
    7)
      echo "  原因: 无法建立 TCP 连接 (connection refused / unreachable)"
      echo "  排查: 1) 主节点防火墙是否放行 80/443"
      echo "        2) 主节点 nginx 是否在跑: ssh master 'docker ps | grep nginx'"
      echo "        3) 云厂商安全组规则"
      ;;
    28)
      echo "  原因: 连接超时 (10s)"
      echo "  排查: 1) 网络丢包: 'ping -c 5 \$DOMAIN'"
      echo "        2) 路由不通: 'traceroute \$DOMAIN'"
      ;;
    35|51|58|59|60|77|82|83)
      echo "  原因: TLS / 证书错误 (curl exit ${exit_code})"
      echo "  排查: 1) 主节点证书是否过期 / 自签 / 域名不匹配"
      echo "        2) 自签证书测试可加 --insecure 跳过校验:"
      echo "             curl -k ${url}/healthz"
      echo "        3) 主节点跑 './exec_cds.sh cert' 重新签发 Let's Encrypt"
      ;;
    22)
      echo "  原因: HTTP 错误响应 (4xx/5xx)"
      echo "  排查: 1) 主节点 CDS 是否在跑: ssh master './exec_cds.sh status'"
      echo "        2) 看主节点日志: ssh master './exec_cds.sh logs'"
      ;;
    *)
      echo "  排查: curl -v ${url}/healthz 看完整错误信息"
      ;;
  esac
  return 1
}

# Decode a base64(JSON) connection code into {master, token} via python3.
# Prints "master|token" on success, nothing on failure. The Dashboard's
# "生成连接码" button outputs this base64 form, and users frequently
# copy-paste it into the CLI. Accepting both formats avoids the "Invalid
# bootstrap token" confusion that bit the user when they pasted the UI's
# code into the CLI thinking it was a raw hex token.
decode_connection_code() {
  local code="$1"
  if ! command -v python3 >/dev/null 2>&1; then
    return 1
  fi
  python3 -c "
import sys, base64, json
try:
    raw = sys.argv[1]
    decoded = base64.b64decode(raw).decode('utf-8')
    obj = json.loads(decoded)
    if not isinstance(obj, dict): sys.exit(1)
    m = obj.get('master') or ''
    t = obj.get('token') or ''
    if m and t:
        print(f'{m}|{t}')
    else:
        sys.exit(1)
except Exception:
    sys.exit(1)
" "$code" 2>/dev/null
}

# Connect THIS machine to a master as an executor.
#
# Two calling forms for convenience:
#   1. Two-arg form (original):
#        ./exec_cds.sh connect <master-url> <bootstrap-token-hex>
#   2. Single-arg form (copy-paste from Dashboard "生成连接码"):
#        ./exec_cds.sh connect <base64-connection-code>
#
# We also auto-detect if the second arg is itself a base64 connection code
# (common copy-paste mistake: paste the whole code in the token slot).
connect_cmd() {
  local master_url="${1:-}" token="${2:-}"

  # Form 2: single arg that looks like base64. Quick heuristic: starts
  # with 'ey' (base64 of '{"') AND doesn't start with 'http'.
  if [ -n "$master_url" ] && [ -z "$token" ] && [[ "$master_url" =~ ^ey ]]; then
    local decoded; decoded="$(decode_connection_code "$master_url")"
    if [ -n "$decoded" ]; then
      master_url="${decoded%%|*}"
      token="${decoded##*|}"
      info "已从连接码解析出 master_url=${master_url}"
    else
      err "无法解析连接码。请确认是 Dashboard 生成的 base64 字符串"
      exit 1
    fi
  fi

  # Form-1 special case: user pasted the FULL base64 connection code as the
  # token argument alongside an explicit URL. Extract the real token.
  if [ -n "$token" ] && [[ "$token" =~ ^ey ]]; then
    local decoded; decoded="$(decode_connection_code "$token")"
    if [ -n "$decoded" ]; then
      local code_master="${decoded%%|*}"
      token="${decoded##*|}"
      info "检测到 token 参数是连接码，已提取 token (长度 ${#token})"
      # If the user gave BOTH an explicit URL and a code with a DIFFERENT
      # embedded master, trust the explicit URL and warn.
      if [ -n "$master_url" ] && [ "$master_url" != "$code_master" ]; then
        warn "连接码里的 master=${code_master}，你传入的 master=${master_url}，使用后者"
      fi
    fi
  fi

  if [ -z "$master_url" ] || [ -z "$token" ]; then
    err "用法: ./exec_cds.sh connect <master-url> <bootstrap-token>"
    echo "  或: ./exec_cds.sh connect <base64-连接码>   (从 Dashboard 复制)"
    echo
    echo "  示例:"
    echo "    ./exec_cds.sh connect https://cds.miduo.org abc123..."
    echo "    ./exec_cds.sh connect eyJtYXN0ZXIiOiJodHRwc..."
    echo
    echo "  获取 token: 在主节点执行 ./exec_cds.sh issue-token"
    echo "             或 在主节点 Dashboard → 集群设置 → 生成连接码"
    exit 1
  fi

  # Normalize URL: strip trailing slash
  master_url="${master_url%/}"

  # Refuse plain HTTP — bootstrap token is sensitive credentials and must
  # not travel over the wire in cleartext. We accept localhost for dev/test
  # because loopback traffic doesn't leave the machine.
  if [[ "$master_url" =~ ^http:// ]] && ! [[ "$master_url" =~ ^http://(localhost|127\.0\.0\.1|\[?::1\]?) ]]; then
    err "拒绝通过明文 HTTP 传输 bootstrap token!"
    echo
    echo "  你提供的 URL: ${master_url}"
    echo
    echo "  原因: bootstrap token 是密码级敏感凭证，明文 HTTP 会被中间人截获。"
    echo "  解决: 1) 把 URL 改成 https://...      (推荐，主节点先跑 ./exec_cds.sh cert)"
    echo "        2) 在主节点和本机之间建 VPN，然后用 https://内网域名"
    echo "        3) 内部测试可用 http://localhost / http://127.0.0.1 (回环不出网)"
    echo
    echo "  如果你确实需要 HTTP 跨机通信，请先理解风险后修改本脚本绕过此检查。"
    exit 1
  fi

  # Sanity-check master reachability before touching local config.
  info "验证主节点可达: ${master_url}/healthz"
  if ! probe_master "$master_url"; then
    exit 1
  fi
  ok "主节点可达"

  load_env

  # Persist connection info. CDS reads these on startup.
  env_upsert CDS_MODE "executor"
  env_upsert CDS_MASTER_URL "$master_url"
  env_upsert CDS_SCHEDULER_URL "$master_url"  # legacy compat with ExecutorAgent
  env_upsert CDS_BOOTSTRAP_TOKEN "$token"
  # No expiry on client side — master enforces; client just presents whatever it has.
  env_upsert CDS_BOOTSTRAP_TOKEN_EXPIRES_AT "$(iso_offset_seconds "$BOOTSTRAP_TOKEN_TTL_SECONDS")"
  # Clear any stale permanent token from previous connections.
  env_upsert CDS_EXECUTOR_TOKEN ""
  ok "已写入 executor 配置 -> $ENV_FILE"

  # CRITICAL: re-export the new values into the current shell so `nohup node`
  # below inherits them. `env_upsert` only writes to disk; without this
  # re-export the child process sees the OLD values that `load_env` read at
  # the top of this function, which manifests as CDS booting in standalone
  # mode (reading stale process.env.CDS_MODE) even though .cds.env on disk
  # says CDS_MODE=executor. Seen on B during the cluster bootstrap dry run.
  export CDS_MODE="executor"
  export CDS_MASTER_URL="$master_url"
  export CDS_SCHEDULER_URL="$master_url"
  export CDS_BOOTSTRAP_TOKEN="$token"
  export CDS_BOOTSTRAP_TOKEN_EXPIRES_AT="$(iso_offset_seconds "$BOOTSTRAP_TOKEN_TTL_SECONDS")"
  unset CDS_EXECUTOR_TOKEN

  # Restart CDS so the new mode takes effect. Existing containers on this
  # host keep running; only the Node process is recycled.
  if cds_is_running; then
    info "重启 CDS 以进入 executor 模式..."
    cds_stop
  fi

  check_deps
  install_deps
  build_ts
  build_web

  # Start in background (standard) — the executor has no Dashboard to serve.
  info "启动 CDS (executor 模式)..."
  nohup node dist/index.js "$CONFIG_FILE" > "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  # Wait up to 60s for register to complete. Cold-start machines (especially
  # containers with bind-mounted node_modules over slow disks) can take a
  # noticeable fraction of a minute before the executor agent reaches the
  # heartbeat loop, so a tight 20s window produced false-negative timeouts.
  # We poll every second and emit progress every 5s so the user knows we're
  # still alive — silence > 5s would otherwise look like a hang.
  local CONNECT_TIMEOUT=60
  info "等待 executor 注册到主节点 (最多 ${CONNECT_TIMEOUT}s)..."
  local i=0 ok_flag=0 fail_flag=0
  while [ "$i" -lt "$CONNECT_TIMEOUT" ]; do
    if grep -q "Registered as executor-" "$LOG_FILE" 2>/dev/null; then
      ok_flag=1
      break
    fi
    if grep -q "Registration failed" "$LOG_FILE" 2>/dev/null; then
      fail_flag=1
      break
    fi
    sleep 1
    i=$((i + 1))
    if [ $((i % 5)) -eq 0 ] && [ "$i" -lt "$CONNECT_TIMEOUT" ]; then
      info "  ...仍在等待 (${i}/${CONNECT_TIMEOUT}s)"
    fi
  done

  echo
  if [ "$ok_flag" -eq 1 ]; then
    ok "已加入集群: ${master_url}"
    echo
    echo "  本机已作为 executor 运行，心跳周期 15s"
    echo "  总容量会自动汇总到主节点的 /api/executors/capacity"
    echo "  查看集群状态: ./exec_cds.sh cluster"
    echo "  断开集群:    ./exec_cds.sh disconnect"
  elif [ "$fail_flag" -eq 1 ]; then
    err "注册被主节点拒绝 — 请查看日志: $LOG_FILE"
    echo
    echo "  常见原因:"
    echo "    1) Token 拼写错误 → 在主节点重新跑 issue-token，复制完整字符串"
    echo "    2) Token 已过期 (>15 分钟) → 在主节点重新 issue-token"
    echo "    3) Token 已被消费 → 上一次 connect 半成功 (网络断在响应回程)"
    echo "       症状: 主节点日志说 'Bootstrap token already consumed'"
    echo "       解决: 在主节点重新 issue-token 后再 connect"
    echo
    echo "  ── 最近 30 行日志 ──"
    tail -30 "$LOG_FILE" 2>/dev/null || true
    exit 1
  else
    err "注册超时 (${CONNECT_TIMEOUT}s 内未看到成功或失败标记)"
    echo
    echo "  排查建议:"
    echo "    1) 看日志找 'executor' 关键词: ./exec_cds.sh logs"
    echo "    2) 确认 node 进程还活着: ps -p $pid"
    echo "    3) 网络是否阻塞: curl -v ${master_url}/api/executors/capacity"
    echo
    echo "  ── 最近 30 行日志 ──"
    tail -30 "$LOG_FILE" 2>/dev/null || true
    exit 1
  fi
  echo
}

# Leave the cluster gracefully. Calls the master's DELETE /api/executors/:id
# endpoint, then resets local config back to standalone and restarts CDS.
disconnect_cmd() {
  load_env

  if [ "${CDS_MODE:-standalone}" != "executor" ]; then
    warn "本机不是 executor (CDS_MODE=${CDS_MODE:-standalone})，无需断开"
    exit 0
  fi

  local master_url="${CDS_MASTER_URL:-${CDS_SCHEDULER_URL:-}}"
  local exec_token="${CDS_EXECUTOR_TOKEN:-}"

  if [ -n "$master_url" ]; then
    # Executor id is derived from hostname + port, same as in agent.ts.
    local hostname; hostname="$(hostname)"
    local port="${CDS_EXECUTOR_PORT:-9901}"
    local exec_id="executor-${hostname}-${port}"
    info "从主节点解注册: ${master_url}/api/executors/${exec_id}"
    curl -fsSL -m 10 -X DELETE \
      -H "X-Executor-Token: ${exec_token}" \
      "${master_url}/api/executors/${exec_id}" >/dev/null 2>&1 \
      || warn "解注册调用失败 (可能主节点已不可达，继续本地重置)"
  fi

  # Reset local config back to standalone.
  env_upsert CDS_MODE "standalone"
  env_upsert CDS_MASTER_URL ""
  env_upsert CDS_SCHEDULER_URL ""
  env_upsert CDS_EXECUTOR_TOKEN ""
  env_upsert CDS_BOOTSTRAP_TOKEN ""
  env_upsert CDS_BOOTSTRAP_TOKEN_EXPIRES_AT ""
  ok "已重置本地配置为 standalone"

  # Re-export into the current shell so the subsequent cds_start_background
  # call inherits the standalone mode (see matching note in connect_cmd).
  # Without this, the child node process would read process.env.CDS_MODE
  # still = "executor" from when this shell was first loaded.
  export CDS_MODE="standalone"
  unset CDS_MASTER_URL
  unset CDS_SCHEDULER_URL
  unset CDS_EXECUTOR_TOKEN
  unset CDS_BOOTSTRAP_TOKEN
  unset CDS_BOOTSTRAP_TOKEN_EXPIRES_AT

  if cds_is_running; then
    info "重启 CDS..."
    cds_stop
    nginx_up || true
    cds_start_background
  fi

  ok "已退出集群"
}

# Display cluster topology and aggregated capacity.
# Works on both master (queries local /api/executors/capacity) and executor
# (queries the configured master).
cluster_cmd() {
  load_env

  local target="http://127.0.0.1:${CDS_MASTER_PORT:-9900}"
  if [ "${CDS_MODE:-standalone}" = "executor" ]; then
    target="${CDS_MASTER_URL:-${CDS_SCHEDULER_URL:-}}"
    if [ -z "$target" ]; then
      err "executor 模式但未配置 CDS_MASTER_URL，无法查询集群"
      exit 1
    fi
  fi

  info "查询集群容量: ${target}/api/executors/capacity"
  local body
  body="$(curl -fsSL -m 10 "${target}/api/executors/capacity" 2>&1)"
  if [ -z "$body" ]; then
    err "查询失败"
    exit 1
  fi

  echo
  printf '  %sCDS 集群状态%s\n' "$B" "$N"
  echo  "  ──────────────────"
  # Pretty-print via python3 if available, otherwise raw.
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$body" | python3 -c '
import json,sys
try:
    d=json.loads(sys.stdin.read())
except Exception as e:
    print("  解析失败:",e); sys.exit(1)
total=d.get("total",{})
used=d.get("used",{})
print(f"  在线节点:  {d.get(\"online\",0)}")
print(f"  离线节点:  {d.get(\"offline\",0)}")
print(f"  总分支槽:  {total.get(\"maxBranches\",0)} (已用 {used.get(\"branches\",0)})")
print(f"  总内存:    {total.get(\"memoryMB\",0)} MB (已用 {used.get(\"memoryMB\",0)} MB)")
print(f"  总 CPU:    {total.get(\"cpuCores\",0)} cores (负载 {used.get(\"cpuPercent\",0)}%)")
print(f"  空闲比例:  {d.get(\"freePercent\",0)}%")
print()
print("  节点列表:")
for n in d.get("nodes",[]):
    role=n.get("role","remote")
    status=n.get("status","?")
    print(f"    - [{role:8}] {n.get(\"id\",\"?\"):40} {n.get(\"host\",\"?\"):16} {status:8} branches={n.get(\"branchCount\",0)}")
'
  else
    printf '%s\n' "$body"
  fi
  echo
}

# ══ migrate-env: 把杂乱的环境变量分类整理 ══════════════════════════
#
# 解决用户 2026-04-27 反馈的「项目环境变量串到系统环境变量」问题：
#   - .cds.env 里塞了 GITHUB_PAT / R2_* / ROOT_ACCESS_* 等项目变量
#   - 还混着 JWT_SECRET / AI_ACCESS_KEY 等无前缀 CDS 旧名
#
# 这个命令扫描候选环境源（.cds.env、./.env、./../.env、~/.bashrc、~/.profile、
# 当前 shell 已 export 的环境），按规则分流：
#   1. CDS_*（合规 canonical）            → 写 .cds.env
#   2. CDS legacy 旧名（JWT_SECRET 等）    → 询问是否 rename → 写 .cds.env
#   3. 其他（GITHUB_PAT、R2_* 等项目级）   → 写 migration-project-env.txt
#                                            提示用户粘到 Dashboard
#
# 不动源文件（.bashrc/.env 都不改），只生成 .cds.env 和 migration-project-env.txt。
# 完全幂等：可以反复跑。
#
# ── 维护提示：CDS_LEGACY_MAP 必须与 cds/src/config/known-env-keys.ts 的
#    legacyAliases 同步。新增 CDS_* 变量时不要再加 legacy alias —— 旧名
#    清完一轮就该砍。
CDS_LEGACY_MAP=(
  "JWT_SECRET=CDS_JWT_SECRET"
  "AI_ACCESS_KEY=CDS_AI_ACCESS_KEY"
  "ROOT_DOMAINS=CDS_ROOT_DOMAINS"
  "MAIN_DOMAIN=CDS_MAIN_DOMAIN"
  "DASHBOARD_DOMAIN=CDS_DASHBOARD_DOMAIN"
  "PREVIEW_DOMAIN=CDS_PREVIEW_DOMAIN"
  "SWITCH_DOMAIN=CDS_SWITCH_DOMAIN"
)

# Look up a legacy key's canonical replacement; echoes the canonical name
# or empty string. Pure stdout, no side effects.
legacy_canonical_of() {
  local key="$1" entry old new
  for entry in "${CDS_LEGACY_MAP[@]}"; do
    old="${entry%%=*}"
    new="${entry##*=}"
    if [ "$old" = "$key" ]; then
      printf '%s' "$new"
      return
    fi
  done
}

# Mask a secret value for display: keep last 4 chars, hide rest.
mask_secret() {
  local v="$1"
  local n=${#v}
  if [ "$n" -le 4 ]; then
    printf '****'
  else
    printf '****%s' "${v: -4}"
  fi
}

# Heuristic: variable looks like a secret if name contains these tokens.
# Used only for masking display in migrate-env preview.
is_secret_name() {
  case "$1" in
    *_SECRET|*_PASSWORD|*_PASS|*_KEY|*_TOKEN|*_PAT|*PRIVATE_KEY*) return 0 ;;
    *) return 1 ;;
  esac
}

# Collect KEY=VALUE pairs from one source file. Lines like
# `export KEY="value"` or `KEY=value` are both supported. Comments / blank
# lines / non-matching lines are silently skipped.
# Output: each line is `<source-tag>\t<KEY>\t<VALUE>` (TAB separated).
scan_env_source() {
  local file="$1" tag="$2"
  [ -f "$file" ] || return 0
  awk -v tag="$tag" '
    /^[[:space:]]*#/   { next }
    /^[[:space:]]*$/   { next }
    {
      line=$0
      sub(/^[[:space:]]*export[[:space:]]+/, "", line)
      if (match(line, /^[A-Za-z_][A-Za-z0-9_]*=/)) {
        key = substr(line, 1, RLENGTH-1)
        val = substr(line, RLENGTH+1)
        # Strip surrounding quotes if any
        if (val ~ /^".*"$/) { val = substr(val, 2, length(val)-2); gsub(/\\"/, "\"", val); gsub(/\\\\/, "\\", val) }
        else if (val ~ /^'\''.*'\''$/) { val = substr(val, 2, length(val)-2) }
        # Strip trailing comments after unquoted values
        sub(/[[:space:]]+#.*$/, "", val)
        printf "%s\t%s\t%s\n", tag, key, val
      }
    }
  ' "$file"
}

# Snapshot current shell exported env (only KEYs that look like uppercase
# config vars, i.e. [A-Z_][A-Z0-9_]+). Filters out OS noise (PATH/HOME/
# locale/etc) so the output stays reviewable.
scan_shell_env() {
  env | awk -F= '
    /^[A-Z_][A-Z0-9_]+=/ {
      key=$1
      # Drop OS / shell noise
      if (key ~ /^(PATH|HOME|USER|SHELL|TERM|TZ|TMPDIR|PWD|LANG|LOGNAME|MAIL|HOSTNAME|HOSTTYPE|OSTYPE|MACHTYPE|SHLVL|OLDPWD|XDG_.*|SSH_.*|DBUS_.*|DISPLAY|WAYLAND_.*|DESKTOP_.*|XAUTHORITY|GTK_.*|QT_.*|GDM.*|GNOME_.*|KDE_.*|GIO_.*|GPG_.*|LESS.*|PS1|PS2|PROMPT_.*|HISTSIZE|HISTFILESIZE|HISTCONTROL|HISTFILE|HISTTIMEFORMAT|BASH.*|_)$/) next
      if (key ~ /^LC_/) next
      if (key ~ /^LD_/) next
      val=$0
      sub("^"key"=", "", val)
      printf "shell\t%s\t%s\n", key, val
    }
  '
}

migrate_env_cmd() {
  # ── 参数解析 ──
  # --verbose / -v   打印每个变量的明细（默认只打 summary）
  # --from FILE      指定额外扫描源（可重复）
  local verbose=false
  local custom_sources=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --verbose|-v) verbose=true ;;
      --from)
        shift
        custom_sources+=("${1:-}")
        ;;
      --from=*)
        custom_sources+=("${1#--from=}")
        ;;
      *)
        warn "未知参数: $1（支持 --from FILE / --verbose）"
        ;;
    esac
    shift || true
  done

  echo
  printf '  %sCDS 环境变量迁移%s\n' "$B" "$N"
  echo

  local scratch
  scratch="$(mktemp)"
  trap 'rm -f "$scratch"' RETURN

  # ── 扫描 ──
  # 默认只扫 .cds.env（用户报告问题的源头：项目变量全塞在这里要清理）。
  # ~/.bashrc / ~/.zshrc / 当前 shell exported env 含大量与 CDS 和项目
  # 都无关的开发工具变量（PNPM_HOME / NVM_DIR / GOPATH / EDITOR 等），
  # 默认不扫。如果用户想从额外源捞值，用 `--from FILE` 显式追加。
  local scanned_sources=()
  if [ ${#custom_sources[@]} -gt 0 ]; then
    # 显式 --from 时，仍扫 .cds.env（基础）+ 用户指定源
    if [ -f "$ENV_FILE" ]; then
      scan_env_source "$ENV_FILE" "$ENV_FILE" >> "$scratch"
      scanned_sources+=("$ENV_FILE")
    fi
    local src
    for src in "${custom_sources[@]}"; do
      if [ -f "$src" ]; then
        scan_env_source "$src" "$src" >> "$scratch"
        scanned_sources+=("$src")
      else
        warn "  --from $src 不存在，跳过"
      fi
    done
  else
    if [ -f "$ENV_FILE" ]; then
      scan_env_source "$ENV_FILE" "$ENV_FILE" >> "$scratch"
      scanned_sources+=("$ENV_FILE")
    fi
  fi

  if [ ! -s "$scratch" ]; then
    warn "$ENV_FILE 不存在或为空。"
    echo  "  如果你想从其他文件迁移，用："
    echo  "    ./exec_cds.sh migrate-env --from /path/to/your.env"
    return 0
  fi

  printf '  扫描源: %s\n' "$(IFS=, ; echo "${scanned_sources[*]}")"

  local deduped
  deduped="$(mktemp)"
  awk -F'\t' '!seen[$2]++' "$scratch" > "$deduped"

  local out_canonical out_legacy out_project
  out_canonical="$(mktemp)"
  out_legacy="$(mktemp)"
  out_project="$(mktemp)"

  while IFS=$'\t' read -r src_tag mig_key mig_val; do
    [ -z "$mig_key" ] && continue
    if [[ "$mig_key" == CDS_* ]]; then
      printf '%s\t%s\t%s\n' "$mig_key" "$mig_val" "$src_tag" >> "$out_canonical"
      continue
    fi
    local canonical
    canonical="$(legacy_canonical_of "$mig_key")"
    if [ -n "$canonical" ]; then
      printf '%s\t%s\t%s\t%s\n' "$mig_key" "$mig_val" "$src_tag" "$canonical" >> "$out_legacy"
    else
      printf '%s\t%s\t%s\n' "$mig_key" "$mig_val" "$src_tag" >> "$out_project"
    fi
  done < "$deduped"

  local n_canonical n_legacy n_project
  n_canonical=$(wc -l < "$out_canonical" | tr -d ' ')
  n_legacy=$(wc -l < "$out_legacy" | tr -d ' ')
  n_project=$(wc -l < "$out_project" | tr -d ' ')

  echo
  printf '  分类: %sCDS 自身%s %d  ·  %s旧名待判断%s %d  ·  %s项目级%s %d\n' \
    "$G" "$N" "$n_canonical" "$Y" "$N" "$n_legacy" "$C" "$N" "$n_project"

  # ── verbose 模式：列出所有 CDS / 项目变量名（不带值） ──
  if [ "$verbose" = true ]; then
    if [ "$n_canonical" -gt 0 ]; then
      echo
      printf '  %sCDS_* canonical%s:\n' "$G" "$N"
      awk -F'\t' '{print "    " $1}' "$out_canonical"
    fi
    if [ "$n_project" -gt 0 ]; then
      echo
      printf '  %s项目级变量%s:\n' "$C" "$N"
      awk -F'\t' '{print "    " $1}' "$out_project"
    fi
  fi

  # ── Legacy 段（必须互动） ──
  declare -a rename_keys=() rename_vals=() rename_canonical=()
  declare -a rejected_legacy_keys=() rejected_legacy_vals=() rejected_legacy_tags=()
  if [ "$n_legacy" -gt 0 ]; then
    echo
    printf '  %s需要你判断 %d 个旧名变量归属%s（CDS 历史上和 prd-api 等项目都用过）：\n' "$Y" "$n_legacy" "$N"
    while IFS=$'\t' read -r key val tag canonical; do
      [ -z "$key" ] && continue
      local masked
      if is_secret_name "$key"; then
        masked="$(mask_secret "$val")"
      else
        masked="$val"
      fi
      printf '    - %s%s%s = %s\n' "$B" "$key" "$N" "$masked"
      if confirm "      这是 CDS 自身用的?（Y=rename 为 $canonical / N=项目变量）"; then
        rename_keys+=("$key")
        rename_vals+=("$val")
        rename_canonical+=("$canonical")
      else
        rejected_legacy_keys+=("$key")
        rejected_legacy_vals+=("$val")
        rejected_legacy_tags+=("$tag")
      fi
    done < "$out_legacy"
  fi

  # 拒绝的 legacy 归项目段
  if [ ${#rejected_legacy_keys[@]} -gt 0 ]; then
    local i
    for ((i=0; i<${#rejected_legacy_keys[@]}; i++)); do
      printf '%s\t%s\t%s\n' "${rejected_legacy_keys[$i]}" "${rejected_legacy_vals[$i]}" "${rejected_legacy_tags[$i]}" >> "$out_project"
    done
    n_project=$(wc -l < "$out_project" | tr -d ' ')
  fi

  # ── 写 migration-project-env.txt ──
  local project_out_file="$SCRIPT_DIR/migration-project-env.txt"
  if [ "$n_project" -gt 0 ]; then
    {
      echo "# CDS 环境变量迁移 — 生成于 $(date +%F)"
      echo "# 项目级变量（不属于 CDS 自身）。粘贴到 Dashboard → 项目 → 设置 → 环境变量。"
      echo "# 使用后建议立刻删除（含密钥）。"
      echo "#"
      while IFS=$'\t' read -r key val tag; do
        [ -z "$key" ] && continue
        if [[ "$val" == *[[:space:]\"\$\`\\]* ]]; then
          local escaped
          escaped="${val//\\/\\\\}"
          escaped="${escaped//\"/\\\"}"
          escaped="${escaped//\$/\\\$}"
          escaped="${escaped//\`/\\\`}"
          printf '%s="%s"\n' "$key" "$escaped"
        else
          printf '%s=%s\n' "$key" "$val"
        fi
      done < "$out_project"
    } > "$project_out_file"
    chmod 600 "$project_out_file"
  fi

  # ── 写 .cds.env ──
  local backup=""
  if [ "$n_canonical" -gt 0 ] || [ ${#rename_keys[@]} -gt 0 ]; then
    if [ -f "$ENV_FILE" ]; then
      backup="${ENV_FILE}.bak.$(date +%Y%m%d_%H%M%S)"
      cp "$ENV_FILE" "$backup"
    fi
    local renamed_targets=" "
    local r
    for r in "${rename_canonical[@]:-}"; do
      [ -n "$r" ] && renamed_targets+="$r "
    done
    {
      echo "# CDS 本地环境 — 由 ./exec_cds.sh migrate-env 生成于 $(date +%F)"
      echo "# 唯一用户配置入口 — 所有变量必须 CDS_ 前缀"
      echo "#"
      while IFS=$'\t' read -r key val tag; do
        [ -z "$key" ] && continue
        if [[ "$renamed_targets" == *" $key "* ]]; then continue; fi
        printf 'export %s="%s"\n' "$key" "$(printf '%s' "$val" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\$/\\$/g; s/`/\\`/g')"
      done < "$out_canonical"
      local i
      for ((i=0; i<${#rename_keys[@]}; i++)); do
        printf 'export %s="%s"\n' "${rename_canonical[$i]}" "$(printf '%s' "${rename_vals[$i]}" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\$/\\$/g; s/`/\\`/g')"
      done
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi

  # ── 简洁的"完成 + 下一步" ──
  echo
  echo  "  ─── 完成 ───"
  if [ -n "$backup" ]; then
    echo  "  $ENV_FILE 已更新   (备份: $backup)"
  elif [ -f "$ENV_FILE" ]; then
    echo  "  $ENV_FILE 已写入"
  fi
  if [ "$n_project" -gt 0 ]; then
    echo  "  $project_out_file ($n_project 个项目变量)"
  fi

  echo
  printf '  %s下一步：%s\n' "$B" "$N"
  local step=1
  if [ "$n_project" -gt 0 ]; then
    printf '    %d. %s打开 Dashboard%s → 项目 → 设置 → 环境变量\n' "$step" "$B" "$N"
    printf '       把 %s 内容粘贴进去（粘完删此文件）\n' "$project_out_file"
    step=$((step+1))
  fi
  printf '    %d. %s./exec_cds.sh restart%s   （让新的 .cds.env 生效；CDS 不会自动重载）\n' "$step" "$B" "$N"
  echo

  rm -f "$deduped" "$out_canonical" "$out_legacy" "$out_project"

  # ── 直接询问是否立刻重启（如果 .cds.env 真的有变化） ──
  if [ -n "$backup" ] && [ -t 0 ] && [ -t 1 ]; then
    if confirm "现在就执行 ./exec_cds.sh restart 吗?"; then
      info "重启 CDS 中（约 10-15 秒）..."
      "$0" restart
    else
      info "稍后请记得手动跑 ./exec_cds.sh restart"
    fi
  fi
}

help_cmd() {
  cat <<'EOF'

  ╔═══════════════════════════════════════════════════════════════╗
  ║              CDS — Cloud Development Suite                    ║
  ║       一台或多台服务器的开发分支预览管理工具                   ║
  ╚═══════════════════════════════════════════════════════════════╝

  这个脚本是 CDS 的唯一入口。所有操作（启动、停止、组集群、签证书）
  都通过它完成。配置文件唯一来源是 cds/.cds.env。

──────────────────────────────────────────────────────────────────
  📦 基础生命周期 (单机使用就够了)
──────────────────────────────────────────────────────────────────

  ./exec_cds.sh init                第一次使用必跑！它会自动帮你:
                                      1) 检查依赖 (Node/pnpm/Docker/curl/...)
                                         缺什么就问你是否自动安装 [Y/n]
                                      2) 交互式问 4 个配置:
                                         - Dashboard 用户名 (默认 admin)
                                         - Dashboard 密码
                                         - JWT 密钥 (自动生成)
                                         - 根域名 (例: miduo.org)
                                      3) 写入 .cds.env + 生成 nginx 配置
                                    是幂等的: 跑两次、跑到一半 Ctrl+C 再跑都 OK

  ./exec_cds.sh start               启动 CDS + Nginx (后台运行)
                                      → 访问 http://localhost:9900 进 Dashboard
                                      → Ctrl+C 不会停止 (后台模式)

  ./exec_cds.sh start --fg          启动 CDS + Nginx (前台调试模式)
                                      → 日志直接输出到屏幕
                                      → Ctrl+C 立即停止

  ./exec_cds.sh stop                停止 CDS + Nginx (优雅停机)

  ./exec_cds.sh restart             stop + start 的组合命令

  ./exec_cds.sh status              查看 CDS 和 Nginx 是不是在跑
                                      → 显示 PID、域名、状态颜色

  ./exec_cds.sh logs                跟随 CDS 日志 (类似 tail -f)
                                      → Ctrl+C 退出但不停止 CDS

  ./exec_cds.sh migrate-env         整理 .cds.env 内的杂乱变量。按规则分流：
                                        1) CDS_* canonical → 留在 .cds.env
                                        2) CDS 旧名（JWT_SECRET 等）→
                                           互动判断 → rename 或归项目段
                                        3) 项目级（GITHUB_PAT/R2_*/
                                           ROOT_ACCESS_*/GitHubOAuth__*）→
                                           输出到 migration-project-env.txt
                                           粘贴到 Dashboard 项目环境变量
                                      默认只扫 .cds.env（不串 .bashrc/shell）。
                                      要从其他文件迁移用 --from 追加：
                                        ./exec_cds.sh migrate-env --from ../.env
                                      末尾会自动备份 .cds.env，问你要不要立刻 restart。
                                      加 --verbose 看每个变量名的明细。

  ./exec_cds.sh cert                自动签发/续签 Let's Encrypt 证书
                                      → 需要你的域名已经解析到这台机器
                                      → 第一次会自动安装 acme.sh

──────────────────────────────────────────────────────────────────
  🌐 集群命令 (一台机器装不下时再用)
──────────────────────────────────────────────────────────────────

  CDS 支持把多台 Linux 机器组成集群，总容量 (CPU/内存/分支槽) 自动汇总。
  典型场景: 老机器满了，加一台新机器扩容。

  扩容流程 = 两条命令:

  ┌─ 第 1 步: 在【老机器】生成 token ──────────────────────────────┐
  │                                                                 │
  │   ./exec_cds.sh issue-token                                     │
  │                                                                 │
  │   → 输出一段 random hex token (15 分钟过期)                      │
  │   → 自动打印第 2 步的命令模板，复制下来                           │
  └────────────────────────────────────────────────────────────────┘

  ┌─ 第 2 步: 在【新机器】粘贴运行 ────────────────────────────────┐
  │                                                                 │
  │   ./exec_cds.sh connect <主节点 URL> <token>                    │
  │                                                                 │
  │   例: ./exec_cds.sh connect https://cds.miduo.org abc123...     │
  │                                                                 │
  │   → 自动: 验证主可达 → 写 .cds.env → 重启进 executor 模式 →     │
  │           注册到主 → 启动心跳                                    │
  │   → 大概 10 秒内完成                                            │
  └────────────────────────────────────────────────────────────────┘

  其他集群命令:

  ./exec_cds.sh cluster             显示集群拓扑和总容量
                                      → 任意节点都能跑
                                      → 显示在线节点数、总 CPU、总内存、空闲比例

  ./exec_cds.sh disconnect          把【本机】从集群退出 (回到 standalone)
                                      → 只在 executor 节点上跑
                                      → 主节点不应该 disconnect (它没"主"可断)

──────────────────────────────────────────────────────────────────
  🛡 防护命令 (P4 Part 18 hardening)
──────────────────────────────────────────────────────────────────

  ./exec_cds.sh install-systemd     一键把 CDS 装成 systemd 服务
                                      → 自动把当前安装路径填进 unit 文件
                                      → 输出你需要复制执行的 sudo 命令
                                      → 启用后 CDS 崩溃会被 systemd 自动重启
                                      → 配合 /api/self-update 的预检，杜绝
                                        "自更新把自己搞死"的 bootstrap trap

  ⚠️ 集群扩容前的检查清单:
     □ 两台机器都已经 init + start 通过
     □ 新机器能 curl 通老机器的 https://xxx/healthz
     □ 两台机器时间差 < 1 分钟 (token 校验有 60 秒容忍)
     □ 你能 SSH 到两台机器
     □ 主节点 URL 必须是 https:// (拒绝明文 HTTP 防 token 泄露)

  🔒 安全提示:
     • bootstrap token 通过命令行参数传递，会出现在 ps aux 输出里。
       同机器上的其他用户可以看到。如果你的服务器是多用户共享的，
       请在 connect 完成后立即在主节点重新 issue-token (会让旧 token 失效)。
     • 永久 token 存在 .cds.env (mode 0600)，仅 root 和 CDS 运行用户可读。
     • 推荐定期轮换永久 token: 主节点 issue-token → 从节点 disconnect && connect

  详细操作手册见 doc/guide.cds-cluster-setup.md (含 5 种常见错误排查)

──────────────────────────────────────────────────────────────────
  📂 配置文件 (cds/.cds.env)
──────────────────────────────────────────────────────────────────

  这是 CDS 唯一的用户配置文件。所有变量必须 CDS_ 开头。
  推荐通过 ./exec_cds.sh init 生成，不要手工编辑。

  基础变量 (init 会问你):
    CDS_USERNAME             Dashboard 登录用户名
    CDS_PASSWORD             Dashboard 登录密码
    CDS_JWT_SECRET           JWT 签名密钥 (init 自动生成 32 字节)
    CDS_ROOT_DOMAINS         根域名列表，逗号分隔

  集群变量 (issue-token / connect 会自动写):
    CDS_MODE                 standalone / scheduler / executor
    CDS_MASTER_URL           (executor 模式) 主节点 URL
    CDS_BOOTSTRAP_TOKEN      (主节点) 一次性 bootstrap token
    CDS_EXECUTOR_TOKEN       永久 executor 认证 token

──────────────────────────────────────────────────────────────────
  🌍 多域名路由
──────────────────────────────────────────────────────────────────

  CDS_ROOT_DOMAINS 支持逗号分隔多个根域名。每个根域名 D 自动生成:

    D                        → CDS Dashboard
    cds.D                    → CDS Dashboard (别名)
    *.D                      → 任意子域名 = 一个分支预览页面

  例: CDS_ROOT_DOMAINS="miduo.org,mycds.net"
  → 同时支持: miduo.org, cds.miduo.org, *.miduo.org,
              mycds.net, cds.mycds.net, *.mycds.net

──────────────────────────────────────────────────────────────────
  📚 学习路径 (新手强烈推荐看)
──────────────────────────────────────────────────────────────────

  1. 第一次安装             → doc/guide.quickstart.md
  2. 环境变量参考           → doc/guide.cds-env.md
  3. 集群扩容操作手册       → doc/guide.cds-cluster-setup.md
  4. CDS 整体架构理解       → doc/design.cds.md
  5. 容量预算与故障隔离     → doc/design.cds-resilience.md
  6. 集群引导握手协议设计   → doc/design.cds-cluster-bootstrap.md

──────────────────────────────────────────────────────────────────
  💡 常见问题
──────────────────────────────────────────────────────────────────

  Q: 我直接跑 start 报错，什么都没动过
  A: 先跑 init 生成 .cds.env，再 start

  Q: Dashboard 打不开
  A: 跑 status 看 CDS 是不是 running；跑 logs 看错误信息

  Q: 端口 9900 被占用
  A: 跑 stop 清理，或者修改 cds.config.json 里的 masterPort

  Q: 加入集群后想撤销
  A: 在那台机器上跑 disconnect

  Q: 我有 3 台机器，一台主两台从，两台从能不能用同一个 token?
  A: 不能。bootstrap token 一次性消费。每台从节点单独 issue-token + connect

  Q: 主节点崩了从节点会怎样
  A: 从节点保留本地容器继续服务，心跳失败但不停机。主节点恢复后自动重连

  Q: 我想让从节点直接接收外网流量，不经过主节点代理
  A: 这是高级场景，需要改 Cloudflare DNS 和 nginx 模板。当前默认方案是
     "主代理"，对 DNS 零改动。详见 doc/design.cds-cluster-bootstrap.md §4

EOF
}

# ══ entry ════════════════════════════════════════════════════════

CMD="${1:-help}"
shift || true

# Parse any trailing flags (mostly --fg)
FG=false
for arg in "$@"; do
  case "$arg" in
    --fg|fg) FG=true ;;
  esac
done

case "$CMD" in
  init|setup|config)
    load_env
    init_cmd
    ;;
  start|daemon|--background|-d)
    load_env
    nginx_up || true
    if [ "$FG" = true ]; then
      cds_start_foreground
    else
      cds_start_background
    fi
    ;;
  fg)
    load_env
    nginx_up || true
    cds_start_foreground
    ;;
  stop)
    load_env
    cds_stop
    nginx_down
    ;;
  restart)
    # ── Hot-swap restart: build BEFORE stop ──
    #
    # Historical flow was `stop → nginx restart → sleep → build → start`,
    # which meant the 8-12s TypeScript compile ran WHILE the old node was
    # already dead, leaving nginx with no upstream. End-users saw a
    # Cloudflare 502 "Bad gateway" banner for the full compile window.
    #
    # Fix: pre-build on the still-running process's sidelines. `build_ts`
    # only writes to `dist/` — the live node is serving from a previously
    # loaded dist and doesn't re-read it at runtime, so overwriting dist
    # while it runs is safe. After the build completes we stop + start
    # in one tight window (~1-2s, not 10+s).
    #
    # Also: nginx stays UP the whole time. Nuking + rebinding nginx on
    # every restart was unnecessary (its upstream pointer is just
    # localhost:9900, which reappears as soon as node rebinds) and
    # widened the downtime window. If the operator genuinely needs
    # nginx re-rendered (e.g. new root domains), they should call
    # `nginx-render` separately.
    load_env
    install_deps
    build_ts
    build_web
    cds_stop
    # Make sure nginx is still present (no-op if already running) —
    # nginx_up is idempotent and cheap, keeps the first-time restart
    # after a cold start working.
    nginx_up || true
    if [ "$FG" = true ]; then
      cds_start_foreground
    else
      cds_start_background
    fi
    ;;
  status)
    status_cmd
    ;;
  logs)
    logs_cmd
    ;;
  healthz|health|probe)
    healthz_cmd
    ;;
  cert|tls)
    cert_cmd
    ;;
  issue-token|token)
    issue_token_cmd
    ;;
  connect|join)
    connect_cmd "$@"
    ;;
  disconnect|leave)
    disconnect_cmd
    ;;
  cluster|cluster-status|nodes)
    cluster_cmd
    ;;
  install-systemd)
    # P4 Part 18 hardening: auto-install the systemd unit with the
    # current install location interpolated into the paths. Users no
    # longer have to hand-edit /etc/systemd/system/cds-master.service.
    install_systemd_cmd
    ;;
  master-run)
    # 用户反馈 2026-05-06:每次改 pnpm install / node 启动参数都要 sudo cp
    # 重装 systemd unit 太蠢。把"master 进程怎么启动"这件事从 systemd unit
    # 搬到这里,unit 文件只负责"在哪个目录跑哪个命令、Restart=always、
    # MemoryMax",真正的启动细节随 self-update 自动更新,sudo 一次即可。
    #
    # systemd ExecStart 调用本子命令:
    #   ExecStart=/opt/prd_agent/cds/exec_cds.sh master-run
    # 之后改 pnpm 标志、node flag 都改这里,不动 unit。
    load_env
    cd "$SCRIPT_DIR" || { err "无法 cd 到 $SCRIPT_DIR"; exit 1; }
    info "[master-run] pnpm install --frozen-lockfile --prefer-offline"
    # ⚠ Bugbot 982b38ca (Medium):必须显式 fail-fast。pnpm install 失败可能由
    # lockfile 与 package.json 漂移、pnpm store 损坏、磁盘满 等原因触发,
    # 静默继续会让 node 启动时遭遇 stale / 不完整 node_modules,运行时崩溃。
    # systemd Restart=always 会无限重启,污染日志且永远起不来。
    # 显式 exit 78(EX_CONFIG)告诉 systemd 这是配置/依赖问题,operator 看 status
    # 一眼区分"代码 bug 崩"vs"依赖装不上",对应不同 runbook。
    if ! pnpm install --frozen-lockfile --prefer-offline; then
      err "[master-run] pnpm install 失败 — 中止启动,避免 node 用陈旧 node_modules"
      err "[master-run] 排查: (a) pnpm-lock.yaml 是否与 package.json 同步 (b) ~/.pnpm-store 是否健康 (c) 磁盘空间"
      exit 78  # EX_CONFIG — operator 友好的 systemd 退出码
    fi
    info "[master-run] exec node dist/index.js"
    exec node dist/index.js
    ;;
  migrate-env|migrate)
    # 2026-04-27: 把杂乱的环境源（.cds.env、./.env、~/.bashrc、当前 shell）
    # 按"CDS canonical / CDS legacy / 项目级"三类分流。详细行为见
    # migrate_env_cmd 函数顶部注释。
    migrate_env_cmd "$@"
    ;;
  help|--help|-h|"")
    help_cmd
    ;;
  *)
    err "未知命令: $CMD"
    help_cmd
    exit 1
    ;;
esac
