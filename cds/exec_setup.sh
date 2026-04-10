#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# CDS 一键部署配置脚本
#
# 功能：
#   1. 交互式收集配置（账号密码、域名等）
#   2. 写入 ~/.bashrc（CDS 系统层环境变量）
#   3. 生成 CDS 自带 Nginx 配置、Compose 与证书脚本
#
# 用法：
#   ./exec_setup.sh              # 交互式配置
#   ./exec_setup.sh --show       # 仅显示当前配置
#   ./exec_setup.sh --nginx-only # 仅重新生成 nginx 配置
# ──────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/nginx"
BASHRC="$HOME/.bashrc"
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

# ── Helper: read current value from local env / bashrc ──
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
    grep "^export ${var_name}=" "$BASHRC" 2>/dev/null | tail -1 | sed "s/^export ${var_name}=\"\(.*\)\"/\1/" || echo ""
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

    local vars=(CDS_USERNAME CDS_PASSWORD CDS_JWT_SECRET CDS_SWITCH_DOMAIN CDS_MAIN_DOMAIN CDS_PREVIEW_DOMAIN CDS_ACCESS_MODE)
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
                CDS_SWITCH_DOMAIN) val=$(get_config_var "SWITCH_DOMAIN") ;;
                CDS_MAIN_DOMAIN) val=$(get_config_var "MAIN_DOMAIN") ;;
                CDS_PREVIEW_DOMAIN) val=$(get_config_var "PREVIEW_DOMAIN") ;;
                CDS_ACCESS_MODE) val=$(get_config_var "ACCESS_MODE") ;;
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

# ── Generate nginx config from template ──
generate_nginx() {
    local main_domain="$1"
    local preview_domain="$2"
    local switch_domain="${3:-switch.${main_domain}}"
    local access_mode="${4:-prefixed}"
    local worker_port="${5:-5500}"
    local master_port="${6:-9900}"
    local output_dir="${7:-$SCRIPT_DIR/nginx}"
    local domain_env="${output_dir}/domain.env"
    local worker_domain dashboard_domain tls_domains

    case "$access_mode" in
        prefixed)
            worker_domain="$main_domain"
            dashboard_domain="cds.${main_domain}"
            ;;
        root)
            worker_domain="cds.${main_domain}"
            dashboard_domain="$main_domain"
            ;;
        *)
            err "ACCESS_MODE 仅支持 prefixed 或 root"
            return 1
            ;;
    esac

    tls_domains="${main_domain},${switch_domain}"
    if [ "$worker_domain" != "$main_domain" ] && [ "$worker_domain" != "$switch_domain" ]; then
        tls_domains="${tls_domains},${worker_domain}"
    fi
    if [ "$dashboard_domain" != "$main_domain" ] && [ "$dashboard_domain" != "$switch_domain" ] && [ "$dashboard_domain" != "$worker_domain" ]; then
        tls_domains="${tls_domains},${dashboard_domain}"
    fi

    mkdir -p "${output_dir}/certs" "${output_dir}/www/.well-known/acme-challenge"

    cat > "$domain_env" <<EOF
MAIN_DOMAIN="${main_domain}"
SWITCH_DOMAIN="${switch_domain}"
ACCESS_MODE="${access_mode}"
WORKER_DOMAIN="${worker_domain}"
DASHBOARD_DOMAIN="${dashboard_domain}"
PREVIEW_DOMAIN="${preview_domain}"
ENABLE_PREVIEW_SERVER="1"
WORKER_PORT="${worker_port}"
DASHBOARD_PORT="${master_port}"
CERT_EMAIL="admin@${main_domain}"
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
    local switch_domain="$4"
    local main_domain="$5"
    local preview_domain="$6"
    local access_mode="${7:-prefixed}"

    cat > "$LOCAL_ENV_FILE" << EOF
# ── CDS 本地环境配置 (由 exec_setup.sh 生成，$(date +%Y-%m-%d)) ──
export CDS_USERNAME="${username}"
export CDS_PASSWORD="${password}"
export CDS_JWT_SECRET="${jwt_secret}"
export CDS_SWITCH_DOMAIN="${switch_domain}"
export CDS_MAIN_DOMAIN="${main_domain}"
export CDS_PREVIEW_DOMAIN="${preview_domain}"
export CDS_ACCESS_MODE="${access_mode}"
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
            local domain
            domain=$(get_config_var "CDS_MAIN_DOMAIN")
            if [ -z "$domain" ]; then
                domain=$(get_config_var "MAIN_DOMAIN")
            fi
            if [ -z "$domain" ]; then
                err "未找到 CDS_MAIN_DOMAIN，请先运行 ./exec_setup.sh 完成完整配置"
                return 1
            fi
            local preview
            preview=$(get_config_var "CDS_PREVIEW_DOMAIN")
            [ -z "$preview" ] && preview=$(get_config_var "PREVIEW_DOMAIN")
            [ -z "$preview" ] && preview="$domain"
            local switch
            switch=$(get_config_var "CDS_SWITCH_DOMAIN")
            [ -z "$switch" ] && switch=$(get_config_var "SWITCH_DOMAIN")
            [ -z "$switch" ] && switch="switch.${domain}"
            local access_mode
            access_mode=$(get_config_var "CDS_ACCESS_MODE")
            [ -z "$access_mode" ] && access_mode=$(get_config_var "ACCESS_MODE")
            [ -z "$access_mode" ] && access_mode="prefixed"
            generate_nginx "$domain" "$preview" "$switch" "$access_mode"
            return 0
            ;;
    esac

    # ── Step 1: Collect current values as defaults ──
    local cur_user cur_pass cur_jwt cur_switch cur_main cur_preview cur_access_mode
    cur_user=$(get_config_var "CDS_USERNAME")
    [ -z "$cur_user" ] && cur_user=$(get_config_var "BT_USERNAME")
    cur_pass=$(get_config_var "CDS_PASSWORD")
    [ -z "$cur_pass" ] && cur_pass=$(get_config_var "BT_PASSWORD")
    cur_jwt=$(get_config_var "CDS_JWT_SECRET")
    [ -z "$cur_jwt" ] && cur_jwt=$(get_config_var "JWT_SECRET")
    cur_switch=$(get_config_var "CDS_SWITCH_DOMAIN")
    [ -z "$cur_switch" ] && cur_switch=$(get_config_var "SWITCH_DOMAIN")
    cur_main=$(get_config_var "CDS_MAIN_DOMAIN")
    [ -z "$cur_main" ] && cur_main=$(get_config_var "MAIN_DOMAIN")
    cur_preview=$(get_config_var "CDS_PREVIEW_DOMAIN")
    [ -z "$cur_preview" ] && cur_preview=$(get_config_var "PREVIEW_DOMAIN")
    cur_access_mode=$(get_config_var "CDS_ACCESS_MODE")
    [ -z "$cur_access_mode" ] && cur_access_mode=$(get_config_var "ACCESS_MODE")

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
    local new_main new_switch new_preview new_access_mode
    prompt new_main    "主域名 (如 miduo.org)" "${cur_main:-}"
    if [ -z "$new_main" ]; then
        err "主域名不能为空"
        return 1
    fi
    prompt new_access_mode "访问模式 (prefixed/root)" "${cur_access_mode:-prefixed}"
    if [ "$new_access_mode" != "prefixed" ] && [ "$new_access_mode" != "root" ]; then
        err "访问模式只能是 prefixed 或 root"
        return 1
    fi
    prompt new_switch  "分支切换域名" "${cur_switch:-switch.${new_main}}"
    prompt new_preview "预览域名后缀" "${cur_preview:-${new_main}}"
    echo ""

    # ── Step 3: Confirm ──
    echo -e "  ${CYAN}步骤 4/4${NC}: 确认配置"
    echo "  ──────────────────────────"
    echo -e "  用户名:       ${GREEN}${new_user}${NC}"
    echo -e "  密码:         ****${new_pass: -4}"
    echo -e "  JWT Secret:   ****${new_jwt: -4}"
    echo -e "  主域名:       ${GREEN}${new_main}${NC}"
    echo -e "  访问模式:     ${GREEN}${new_access_mode}${NC}"
    echo -e "  切换域名:     ${GREEN}${new_switch}${NC}"
    echo -e "  预览域名:     ${GREEN}${new_preview}${NC}"
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
    write_local_env "$new_user" "$new_pass" "$new_jwt" "$new_switch" "$new_main" "$new_preview" "$new_access_mode"

    info "生成 Nginx 配置 ..."
    generate_nginx "$new_main" "$new_preview" "$new_switch" "$new_access_mode"

    echo ""
    echo "  ════════════════════════════════"
    echo -e "  ${GREEN}${BOLD}配置完成!${NC}"
    echo "  ════════════════════════════════"
    echo ""
    echo "  下一步："
    echo "    1. 启动 Nginx: cd $NGINX_DIR && ./start_nginx.sh"
    echo "    2. 如需证书: cd $NGINX_DIR && ./acme_apply.sh"
    echo "    3. cd $SCRIPT_DIR && ./exec_cds.sh"
    if [ "$new_access_mode" = "root" ]; then
        echo "    4. 访问 https://${new_main}"
    else
        echo "    4. 访问 https://cds.${new_main}"
    fi
    echo ""
}

main "$@"
