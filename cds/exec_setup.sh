#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# CDS 一键部署配置脚本
#
# 功能：
#   1. 交互式收集配置（账号密码、域名等）
#   2. 写入 cds/.cds.env（唯一用户配置入口）
#   3. 自动生成 CDS 自带 Nginx 配置、Compose 与证书脚本
#
# 用法：
#   ./exec_setup.sh              # 交互式配置
#   ./exec_setup.sh --show       # 仅显示当前配置
#   ./exec_setup.sh --nginx-only # 仅重新生成 nginx 配置
# ──────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/nginx"
LOCAL_ENV_FILE="$SCRIPT_DIR/.cds.env"
NGINX_DIR="$SCRIPT_DIR/nginx"
NGINX_DOMAIN_ENV="$NGINX_DIR/domain.env"

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

# ── Helper: read current value from local env / legacy env ──
get_config_var() {
    local var_name="$1"
    local val=""
    if [ -f "$LOCAL_ENV_FILE" ]; then
        val=$(grep "^export ${var_name}=" "$LOCAL_ENV_FILE" 2>/dev/null | tail -1 | sed "s/^export ${var_name}=\"\(.*\)\"/\1/" || true)
    fi
    if [ -n "$val" ]; then
        printf '%s\n' "$val"
        return 0
    fi
    printf '%s\n' "${!var_name:-}"
}

# ── Helper: prompt with default ──
prompt() {
    local var_name="$1"
    local description="$2"
    local default="$3"
    local is_secret="${4:-false}"

    if [ -n "$default" ]; then
        if [ "$is_secret" = "true" ]; then
            local display="****${default: -4}"
            echo -en "  ${BOLD}${description}${NC} [${display}]: "
        else
            echo -en "  ${BOLD}${description}${NC} [${default}]: "
        fi
    else
        echo -en "  ${BOLD}${description}${NC}: "
    fi

    local input
    if [ "$is_secret" = "true" ]; then
        read -rs input
        echo ""
    else
        read -r input
    fi

    if [ -n "$input" ]; then
        eval "$var_name=\"$input\""
    else
        eval "$var_name=\"$default\""
    fi
}

# ── Show current config ──
show_config() {
    echo ""
    echo -e "  ${BOLD}CDS 当前配置${NC}"
    echo "  ─────────────────────────────"

    local vars=(CDS_USERNAME CDS_PASSWORD CDS_JWT_SECRET CDS_ROOT_DOMAINS)
    local secrets=(CDS_PASSWORD CDS_JWT_SECRET)

    for var in "${vars[@]}"; do
        local val
        val=$(get_config_var "$var")
        if [ -z "$val" ]; then
            # Try legacy names
            case "$var" in
                CDS_USERNAME) val=$(get_config_var "BT_USERNAME") ;;
                CDS_PASSWORD) val=$(get_config_var "BT_PASSWORD") ;;
                CDS_JWT_SECRET) val=$(get_config_var "JWT_SECRET") ;;
                CDS_ROOT_DOMAINS) val=$(get_config_var "ROOT_DOMAINS") ;;
            esac
        fi

        if [ -z "$val" ]; then
            echo -e "  ${var}: ${YELLOW}(未配置)${NC}"
        elif [[ " ${secrets[*]} " =~ " ${var} " ]]; then
            echo -e "  ${var}: ****${val: -4}"
        else
            echo -e "  ${var}: ${GREEN}${val}${NC}"
        fi
    done
    echo ""
}

cleanup_generated_nginx() {
    local output_dir="${1:-$NGINX_DIR}"
    rm -f \
      "${output_dir}/domain.env" \
      "${output_dir}/nginx.conf" \
      "${output_dir}/cds-nginx.conf" \
      "${output_dir}/cds-nginx.http.conf" \
      "${output_dir}/acme_apply.sh" \
      "${output_dir}/nginx.compose.yml"
}

# ── Generate nginx config from template ──
generate_nginx() {
    local root_domains_csv="$1"
    local worker_port="${2:-5500}"
    local master_port="${3:-9900}"
    local output_dir="${4:-$SCRIPT_DIR/nginx}"
    local source_env="${5:-$LOCAL_ENV_FILE}"
    local domain_env="${output_dir}/domain.env"
    local primary_domain tls_domains

    primary_domain="$(printf '%s' "$root_domains_csv" | cut -d',' -f1 | xargs)"
    if [ -z "$primary_domain" ]; then
        err "ROOT_DOMAINS 不能为空"
        return 1
    fi

    tls_domains="$root_domains_csv"

    cleanup_generated_nginx "$output_dir"
    mkdir -p "${output_dir}/certs" "${output_dir}/www/.well-known/acme-challenge"

    cat > "$domain_env" <<EOF
# internal generated file; edit cds/.cds.env then rerun ./exec_setup.sh or ./exec_cds.sh nginx render
# source: ${source_env}
ROOT_DOMAINS="${root_domains_csv}"
PRIMARY_DOMAIN="${primary_domain}"
WORKER_PORT="${worker_port}"
DASHBOARD_PORT="${master_port}"
CERT_EMAIL="admin@${primary_domain}"
NGINX_CONTAINER="nginx_miduo"
LOCAL_TLS_HOST="127.0.0.1"
TLS_DOMAINS="${tls_domains}"
EOF

    if [ ! -f "$output_dir/init_domain.sh" ]; then
        err "初始化脚本不存在: $output_dir/init_domain.sh"
        return 1
    fi

    bash "$output_dir/init_domain.sh" --config "$domain_env" >/dev/null
    ok "Nginx 配置已生成: ${output_dir}/nginx.conf"
    ok "CDS Nginx 配置已生成: ${output_dir}/cds-nginx.conf"
    ok "证书脚本已生成: ${output_dir}/acme_apply.sh"
    ok "Nginx 启动脚本: ${output_dir}/start_nginx.sh"
}

# ── Write local runtime env ──
write_local_env() {
    local username="$1"
    local password="$2"
    local jwt_secret="$3"
    local root_domains_csv="$4"
    local primary_domain
    primary_domain="$(printf '%s' "$root_domains_csv" | cut -d',' -f1 | xargs)"

    cat > "$LOCAL_ENV_FILE" << EOF
# ── CDS 本地环境配置 (由 exec_setup.sh 生成，$(date +%Y-%m-%d)) ──
export CDS_USERNAME="${username}"
export CDS_PASSWORD="${password}"
export CDS_JWT_SECRET="${jwt_secret}"
export CDS_ROOT_DOMAINS="${root_domains_csv}"
export CDS_MAIN_DOMAIN="${primary_domain}"
export CDS_PREVIEW_DOMAIN="${primary_domain}"
export CDS_DASHBOARD_DOMAIN="${primary_domain}"
EOF

    chmod 600 "$LOCAL_ENV_FILE"
    ok "本地环境文件已更新: $LOCAL_ENV_FILE"
}

# ── Main ──
main() {
    echo ""
    echo -e "  ${BOLD}CDS 一键部署配置${NC}"
    echo "  ═══════════════════════════════"
    echo ""

    # Parse args
    case "${1:-}" in
        --show)
            show_config
            return 0
            ;;
        --nginx-only)
            local root_domains
            root_domains=$(get_config_var "CDS_ROOT_DOMAINS")
            if [ -z "$root_domains" ]; then
                root_domains=$(get_config_var "ROOT_DOMAINS")
            fi
            if [ -z "$root_domains" ]; then
                local legacy_domain
                legacy_domain=$(get_config_var "CDS_MAIN_DOMAIN")
                [ -z "$legacy_domain" ] && legacy_domain=$(get_config_var "MAIN_DOMAIN")
                [ -z "$legacy_domain" ] && legacy_domain=$(get_config_var "CDS_DASHBOARD_DOMAIN")
                [ -z "$legacy_domain" ] && legacy_domain=$(get_config_var "DASHBOARD_DOMAIN")
                root_domains="$legacy_domain"
            fi
            if [ -z "$root_domains" ]; then
                err "未找到 CDS_ROOT_DOMAINS，请先运行 ./exec_setup.sh 完成完整配置"
                return 1
            fi
            generate_nginx "$root_domains" "5500" "9900" "$NGINX_DIR" "$LOCAL_ENV_FILE"
            return 0
            ;;
    esac

    # ── Step 1: Collect current values as defaults ──
    local cur_user cur_pass cur_jwt cur_roots
    cur_user=$(get_config_var "CDS_USERNAME")
    [ -z "$cur_user" ] && cur_user=$(get_config_var "BT_USERNAME")
    cur_pass=$(get_config_var "CDS_PASSWORD")
    [ -z "$cur_pass" ] && cur_pass=$(get_config_var "BT_PASSWORD")
    cur_jwt=$(get_config_var "CDS_JWT_SECRET")
    [ -z "$cur_jwt" ] && cur_jwt=$(get_config_var "JWT_SECRET")
    cur_roots=$(get_config_var "CDS_ROOT_DOMAINS")
    [ -z "$cur_roots" ] && cur_roots=$(get_config_var "ROOT_DOMAINS")
    if [ -z "$cur_roots" ]; then
        cur_roots=$(get_config_var "CDS_MAIN_DOMAIN")
        [ -z "$cur_roots" ] && cur_roots=$(get_config_var "MAIN_DOMAIN")
        [ -z "$cur_roots" ] && cur_roots=$(get_config_var "CDS_DASHBOARD_DOMAIN")
        [ -z "$cur_roots" ] && cur_roots=$(get_config_var "DASHBOARD_DOMAIN")
    fi

    # ── Step 2: Interactive prompts ──
    echo -e "  ${CYAN}步骤 1/4${NC}: Dashboard 认证"
    echo "  ──────────────────────────"
    local new_user new_pass
    prompt new_user "登录用户名" "${cur_user:-admin}"
    prompt new_pass "登录密码" "$cur_pass" true
    if [ -z "$new_pass" ]; then
        err "密码不能为空"
        return 1
    fi
    echo ""

    echo -e "  ${CYAN}步骤 2/4${NC}: JWT 签名密钥"
    echo "  ──────────────────────────"
    local new_jwt
    if [ -z "$cur_jwt" ]; then
        # Generate a random default
        local gen_jwt
        gen_jwt=$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)
        prompt new_jwt "JWT Secret (>= 32 字节，回车使用随机生成)" "$gen_jwt" true
    else
        prompt new_jwt "JWT Secret (>= 32 字节)" "$cur_jwt" true
    fi
    if [ ${#new_jwt} -lt 32 ]; then
        warn "JWT Secret 长度不足 32 字节，生产环境存在安全风险"
    fi
    echo ""

    echo -e "  ${CYAN}步骤 3/4${NC}: 域名配置"
    echo "  ──────────────────────────"
    local new_roots
    prompt new_roots "根域名列表（逗号分隔，如 miduo.org,example.com）" "${cur_roots:-}"
    if [ -z "$new_roots" ]; then
        err "根域名不能为空"
        return 1
    fi
    echo ""

    # ── Step 3: Confirm ──
    echo -e "  ${CYAN}步骤 4/4${NC}: 确认配置"
    echo "  ──────────────────────────"
    echo -e "  用户名:       ${GREEN}${new_user}${NC}"
    echo -e "  密码:         ****${new_pass: -4}"
    echo -e "  JWT Secret:   ****${new_jwt: -4}"
    echo -e "  根域名:       ${GREEN}${new_roots}${NC}"
    echo -e "  路由规则:     ${GREEN}根域名 → Dashboard；任意子域名 → Preview${NC}"
    echo ""
    echo -en "  确认写入? [Y/n]: "
    read -r confirm
    if [[ "$confirm" =~ ^[Nn] ]]; then
        warn "已取消"
        return 0
    fi

    # ── Step 4: Write ──
    echo ""
    info "写入 CDS 本地环境文件 ..."
    write_local_env "$new_user" "$new_pass" "$new_jwt" "$new_roots"

    info "生成 Nginx 配置 ..."
    generate_nginx "$new_roots" "5500" "9900" "$NGINX_DIR" "$LOCAL_ENV_FILE"

    local first_domain
    first_domain="$(printf '%s' "$new_roots" | cut -d',' -f1 | xargs)"

    echo ""
    echo "  ════════════════════════════════"
    echo -e "  ${GREEN}${BOLD}配置完成!${NC}"
    echo "  ════════════════════════════════"
    echo ""
    echo "  下一步："
    echo "    1. 启动 CDS 与 Nginx: cd $SCRIPT_DIR && ./exec_cds.sh"
    echo "    2. 如需签发证书:      cd $SCRIPT_DIR && ./exec_cds.sh cert"
    echo "    3. 查看 Nginx 状态:   cd $SCRIPT_DIR && ./exec_cds.sh nginx status"
    echo "    4. 访问 https://${first_domain}"
    echo ""
}

main "$@"
