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

# ══ dependency check & build ═════════════════════════════════════

check_deps() {
  command -v node >/dev/null 2>&1  || { err "未安装 node (需要 >= 20)"; exit 1; }
  local v; v="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if ! [ "$v" -ge 20 ] 2>/dev/null; then err "Node.js 需要 >= 20 (当前 v$v)"; exit 1; fi
  command -v pnpm   >/dev/null 2>&1 || { err "未安装 pnpm (npm i -g pnpm)"; exit 1; }
  command -v docker >/dev/null 2>&1 || { err "未安装 docker"; exit 1; }
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

  # Sanity-check master reachability before touching local config.
  info "验证主节点可达: ${master_url}/healthz"
  if ! curl -fsSL -m 10 "${master_url}/healthz" >/dev/null 2>&1; then
    err "无法连接主节点 ${master_url}，请检查网络 / URL / 防火墙"
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

  # Wait up to 20s for register to complete (executor logs "Registered as ...").
  local i=0 ok_flag=0
  while [ "$i" -lt 20 ]; do
    if grep -q "Registered as executor-" "$LOG_FILE" 2>/dev/null; then
      ok_flag=1
      break
    fi
    if grep -q "Registration failed" "$LOG_FILE" 2>/dev/null; then
      break
    fi
    sleep 1
    i=$((i + 1))
  done

  echo
  if [ "$ok_flag" -eq 1 ]; then
    ok "已加入集群: ${master_url}"
    echo
    echo "  本机已作为 executor 运行，心跳周期 15s"
    echo "  总容量会自动汇总到主节点的 /api/executors/capacity"
    echo "  查看集群状态: ./exec_cds.sh cluster"
    echo "  断开集群:    ./exec_cds.sh disconnect"
  else
    err "注册失败或超时 — 请查看日志: $LOG_FILE"
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
CDS — Cloud Development Suite

基础命令:
  ./exec_cds.sh init                交互式初始化 (写 .cds.env + 生成 nginx 配置)
  ./exec_cds.sh start [--fg]        启动 CDS + Nginx (默认后台；--fg 前台)
  ./exec_cds.sh stop                停止 CDS + Nginx
  ./exec_cds.sh restart [--fg]      重启
  ./exec_cds.sh status              查看运行状态
  ./exec_cds.sh logs                跟随 CDS 日志 (Ctrl+C 退出)
  ./exec_cds.sh cert                签发/续签 Let's Encrypt 证书

集群命令 (多机负载均衡):
  ./exec_cds.sh issue-token         在主节点生成一次性 bootstrap token (15 分钟过期)
  ./exec_cds.sh connect <url> <tk>  把本机加入集群 (作为 executor)
  ./exec_cds.sh disconnect          退出集群 (回到 standalone)
  ./exec_cds.sh cluster             显示集群拓扑和总容量

典型集群扩容流程:
  # 主节点 A 上执行
  ./exec_cds.sh issue-token
  # → 输出 token + 扩容命令模板，复制到新机器 B
  # 新机器 B 上执行
  ./exec_cds.sh connect https://A.miduo.org <token>
  # → 自动注册 + 心跳 + 容量扩充，无需改 DNS/Nginx

配置:
  cds/.cds.env 是唯一用户配置入口，所有变量 CDS_ 前缀:
    CDS_USERNAME / CDS_PASSWORD / CDS_JWT_SECRET / CDS_ROOT_DOMAINS
    集群扩展: CDS_MODE / CDS_MASTER_URL / CDS_EXECUTOR_TOKEN / CDS_BOOTSTRAP_TOKEN

多域名:
  CDS_ROOT_DOMAINS 支持逗号分隔，每个根域名 D 自动生成三条路由:
    D          → Dashboard
    cds.D      → Dashboard (别名)
    *.D        → Preview (任意子域名 → 分支预览)
  示例: CDS_ROOT_DOMAINS="miduo.org,mycds.net"
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
