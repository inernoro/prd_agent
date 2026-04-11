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

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE="$SCRIPT_DIR/.cds.env"
CONFIG_FILE="${CDS_CONFIG:-cds.config.json}"
STATE_DIR="$SCRIPT_DIR/.cds"
PID_FILE="$STATE_DIR/cds.pid"
LOG_FILE="$SCRIPT_DIR/cds.log"

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
  [ -d "$SCRIPT_DIR/node_modules" ] && return 0
  info "安装依赖 ..."
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
}

build_ts() {
  info "编译 TypeScript ..."
  npx tsc || true
  [ -f "$SCRIPT_DIR/dist/index.js" ] || { err "编译失败: dist/index.js 不存在"; exit 1; }
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
    if nginx_compose up -d >/dev/null 2>&1; then
      ok "nginx 已启动 (容器: $NGINX_CONTAINER)"
    else
      warn "nginx 启动失败，请运行: docker compose -f $NGINX_COMPOSE_FILE up -d 检查"
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
  ss -tlnp "( sport = :$port )" 2>/dev/null \
    | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u | head -1
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

  local mp; mp="$(read_port masterPort "${CDS_MASTER_PORT:-9900}")"
  local wp; wp="$(read_port workerPort "${CDS_WORKER_PORT:-5500}")"

  # Reuse listener if another shell already started CDS on master port
  local existing; existing="$(cds_find_pid_on_port "$mp" || true)"
  if [ -n "$existing" ]; then
    echo "$existing" > "$PID_FILE"
    ok "复用已运行的 CDS (PID: $existing, port: $mp)"
    return 0
  fi

  info "启动 CDS (后台模式) ..."
  nohup node dist/index.js "$CONFIG_FILE" > "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  # Wait for master port to bind (max 20s)
  local i=0
  while [ "$i" -lt 20 ]; do
    if ss -tln "( sport = :$mp )" 2>/dev/null | grep -q ":${mp}"; then
      ok "CDS 启动完成"
      echo
      echo "  PID:        $pid"
      echo "  Log:        $LOG_FILE"
      echo "  Dashboard:  http://localhost:${mp}"
      echo "  Gateway:    http://localhost:${wp}"
      echo
      echo "  Stop: ./exec_cds.sh stop"
      echo "  Logs: ./exec_cds.sh logs"
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

cert_cmd() {
  load_env
  local domains_csv="${CDS_ROOT_DOMAINS:-}"
  [ -n "$domains_csv" ] || { err "CDS_ROOT_DOMAINS 未配置"; exit 1; }

  render_nginx || true
  nginx_up

  if [ ! -f "$HOME/.acme.sh/acme.sh" ]; then
    local primary; primary="$(printf '%s' "$domains_csv" | cut -d',' -f1 | xargs)"
    info "首次运行，安装 acme.sh ..."
    curl -fsSL https://get.acme.sh | sh -s email="admin@${primary}"
  fi

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

# Connect THIS machine to a master as an executor.
# Usage: connect <master-url> <bootstrap-token>
connect_cmd() {
  local master_url="${1:-}" token="${2:-}"
  if [ -z "$master_url" ] || [ -z "$token" ]; then
    err "用法: ./exec_cds.sh connect <master-url> <bootstrap-token>"
    echo
    echo "  示例: ./exec_cds.sh connect https://cds.miduo.org abc123..."
    echo "  获取 token: 在主节点执行 ./exec_cds.sh issue-token"
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
    load_env
    cds_stop
    nginx_down
    sleep 1
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
  help|--help|-h|"")
    help_cmd
    ;;
  *)
    err "未知命令: $CMD"
    help_cmd
    exit 1
    ;;
esac
