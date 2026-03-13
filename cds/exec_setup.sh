#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# CDS 一键部署配置脚本
#
# 功能：
#   1. 交互式收集配置（账号密码、域名等）
#   2. 写入 ~/.bashrc（CDS 系统层环境变量）
#   3. 生成 Nginx 配置文件（从模板渲染）
#   4. 可选：重载 Nginx 容器
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

# ── Helper: read current value from bashrc ──
get_bashrc_var() {
    local var_name="$1"
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

    local vars=(CDS_USERNAME CDS_PASSWORD CDS_JWT_SECRET CDS_SWITCH_DOMAIN CDS_MAIN_DOMAIN CDS_PREVIEW_DOMAIN)
    local secrets=(CDS_PASSWORD CDS_JWT_SECRET)

    for var in "${vars[@]}"; do
        local val
        val=$(get_bashrc_var "$var")
        if [ -z "$val" ]; then
            # Try legacy names
            case "$var" in
                CDS_USERNAME) val=$(get_bashrc_var "BT_USERNAME") ;;
                CDS_PASSWORD) val=$(get_bashrc_var "BT_PASSWORD") ;;
                CDS_JWT_SECRET) val=$(get_bashrc_var "JWT_SECRET") ;;
                CDS_SWITCH_DOMAIN) val=$(get_bashrc_var "SWITCH_DOMAIN") ;;
                CDS_MAIN_DOMAIN) val=$(get_bashrc_var "MAIN_DOMAIN") ;;
                CDS_PREVIEW_DOMAIN) val=$(get_bashrc_var "PREVIEW_DOMAIN") ;;
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
    local worker_port="${3:-5500}"
    local master_port="${4:-9900}"
    local output_dir="${5:-$SCRIPT_DIR/nginx}"

    local template="$TEMPLATE_DIR/cds-nginx.conf.template"
    if [ ! -f "$template" ]; then
        err "模板文件不存在: $template"
        return 1
    fi

    local output="$output_dir/cds-nginx.conf"
    sed \
        -e "s/{{MAIN_DOMAIN}}/${main_domain}/g" \
        -e "s/{{PREVIEW_DOMAIN}}/${preview_domain}/g" \
        -e "s/{{WORKER_PORT}}/${worker_port}/g" \
        -e "s/{{MASTER_PORT}}/${master_port}/g" \
        "$template" > "$output"

    ok "Nginx 配置已生成: $output"

    # Also generate the main nginx.conf if it doesn't exist
    local main_nginx="$output_dir/nginx.conf"
    if [ ! -f "$main_nginx" ]; then
        cp "$TEMPLATE_DIR/nginx.conf.template" "$main_nginx"
        ok "主 nginx.conf 已生成: $main_nginx"
    fi

    echo "$output"
}

# ── Write bashrc ──
write_bashrc() {
    local username="$1"
    local password="$2"
    local jwt_secret="$3"
    local switch_domain="$4"
    local main_domain="$5"
    local preview_domain="$6"

    # Remove existing CDS_ and legacy BT_ entries
    local tmp
    tmp=$(mktemp)
    grep -v -E "^export (CDS_USERNAME|CDS_PASSWORD|CDS_JWT_SECRET|CDS_SWITCH_DOMAIN|CDS_MAIN_DOMAIN|CDS_PREVIEW_DOMAIN|BT_USERNAME|BT_PASSWORD|JWT_SECRET|SWITCH_DOMAIN|MAIN_DOMAIN|PREVIEW_DOMAIN)=" "$BASHRC" > "$tmp" 2>/dev/null || true

    # Remove old marker block if exists
    sed -i '/^# ── CDS 系统配置/,/^$/d' "$tmp"

    # Append new config
    cat >> "$tmp" << EOF

# ── CDS 系统配置 (由 exec_setup.sh 生成，$(date +%Y-%m-%d)) ──
export CDS_USERNAME="${username}"
export CDS_PASSWORD="${password}"
export CDS_JWT_SECRET="${jwt_secret}"
export CDS_SWITCH_DOMAIN="${switch_domain}"
export CDS_MAIN_DOMAIN="${main_domain}"
export CDS_PREVIEW_DOMAIN="${preview_domain}"
EOF

    cp "$tmp" "$BASHRC"
    rm -f "$tmp"

    ok "~/.bashrc 已更新"
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
            domain=$(get_bashrc_var "CDS_MAIN_DOMAIN")
            if [ -z "$domain" ]; then
                domain=$(get_bashrc_var "MAIN_DOMAIN")
            fi
            if [ -z "$domain" ]; then
                err "未找到 CDS_MAIN_DOMAIN，请先运行 ./exec_setup.sh 完成完整配置"
                return 1
            fi
            local preview
            preview=$(get_bashrc_var "CDS_PREVIEW_DOMAIN")
            [ -z "$preview" ] && preview=$(get_bashrc_var "PREVIEW_DOMAIN")
            [ -z "$preview" ] && preview="$domain"
            generate_nginx "$domain" "$preview"
            return 0
            ;;
    esac

    # ── Step 1: Collect current values as defaults ──
    local cur_user cur_pass cur_jwt cur_switch cur_main cur_preview
    cur_user=$(get_bashrc_var "CDS_USERNAME")
    [ -z "$cur_user" ] && cur_user=$(get_bashrc_var "BT_USERNAME")
    cur_pass=$(get_bashrc_var "CDS_PASSWORD")
    [ -z "$cur_pass" ] && cur_pass=$(get_bashrc_var "BT_PASSWORD")
    cur_jwt=$(get_bashrc_var "CDS_JWT_SECRET")
    [ -z "$cur_jwt" ] && cur_jwt=$(get_bashrc_var "JWT_SECRET")
    cur_switch=$(get_bashrc_var "CDS_SWITCH_DOMAIN")
    [ -z "$cur_switch" ] && cur_switch=$(get_bashrc_var "SWITCH_DOMAIN")
    cur_main=$(get_bashrc_var "CDS_MAIN_DOMAIN")
    [ -z "$cur_main" ] && cur_main=$(get_bashrc_var "MAIN_DOMAIN")
    cur_preview=$(get_bashrc_var "CDS_PREVIEW_DOMAIN")
    [ -z "$cur_preview" ] && cur_preview=$(get_bashrc_var "PREVIEW_DOMAIN")

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
    local new_main new_switch new_preview
    prompt new_main    "主域名 (如 miduo.org)" "${cur_main:-}"
    if [ -z "$new_main" ]; then
        err "主域名不能为空"
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
    info "写入 ~/.bashrc ..."
    write_bashrc "$new_user" "$new_pass" "$new_jwt" "$new_switch" "$new_main" "$new_preview"

    info "生成 Nginx 配置 ..."
    generate_nginx "$new_main" "$new_preview"

    # ── Step 5: Optional nginx reload ──
    echo ""
    local nginx_conf="$SCRIPT_DIR/nginx/cds-nginx.conf"
    local nginx_main="$SCRIPT_DIR/nginx/nginx.conf"

    echo -e "  ${BOLD}Nginx 部署说明${NC}"
    echo "  ──────────────────────────"
    echo ""
    echo "  生成的文件："
    echo "    主配置:  $nginx_main"
    echo "    CDS 配置: $nginx_conf"
    echo ""
    echo "  部署方式（二选一）："
    echo ""
    echo "  方式 A: 替换宿主机 nginx（推荐）"
    echo "    cp $nginx_main /root/inernoro/nginx/nginx.conf"
    echo "    cp $nginx_conf /root/inernoro/nginx/conf.d/cds.conf"
    echo "    docker exec nginx_miduo nginx -t && docker exec nginx_miduo nginx -s reload"
    echo ""
    echo "  方式 B: 仅添加 CDS 配置（不动主 nginx.conf）"
    echo "    mkdir -p /root/inernoro/nginx/conf.d"
    echo "    cp $nginx_conf /root/inernoro/nginx/conf.d/cds.conf"
    echo "    # 需要在主 nginx.conf 的 http {} 块末尾加一行："
    echo "    #   include /etc/nginx/conf.d/*.conf;"
    echo "    docker exec nginx_miduo nginx -t && docker exec nginx_miduo nginx -s reload"
    echo ""

    echo -en "  是否自动部署 Nginx 配置到宿主机? [y/N]: "
    read -r auto_deploy
    if [[ "$auto_deploy" =~ ^[Yy] ]]; then
        echo -en "  Nginx 配置目录 [/root/inernoro/nginx]: "
        read -r nginx_dir
        nginx_dir="${nginx_dir:-/root/inernoro/nginx}"

        echo -en "  Nginx 容器名 [nginx_miduo]: "
        read -r nginx_container
        nginx_container="${nginx_container:-nginx_miduo}"

        echo -en "  使用方式 A (替换主配置) 还是 B (仅添加 CDS conf)? [A/b]: "
        read -r deploy_mode
        deploy_mode="${deploy_mode:-A}"

        if [[ "$deploy_mode" =~ ^[Aa] ]]; then
            info "复制主 nginx.conf ..."
            cp "$nginx_main" "$nginx_dir/nginx.conf"
            mkdir -p "$nginx_dir/conf.d"
            info "复制 CDS nginx 配置 ..."
            cp "$nginx_conf" "$nginx_dir/conf.d/cds.conf"
        else
            mkdir -p "$nginx_dir/conf.d"
            info "复制 CDS nginx 配置 ..."
            cp "$nginx_conf" "$nginx_dir/conf.d/cds.conf"
            warn "请确保主 nginx.conf 中包含: include /etc/nginx/conf.d/*.conf;"
        fi

        # Mount conf.d into container if not already mounted
        info "测试 Nginx 配置 ..."
        if docker exec "$nginx_container" nginx -t 2>&1; then
            info "重载 Nginx ..."
            docker exec "$nginx_container" nginx -s reload
            ok "Nginx 已重载"
        else
            err "Nginx 配置测试失败，请手动检查"
            return 1
        fi
    fi

    echo ""
    echo "  ════════════════════════════════"
    echo -e "  ${GREEN}${BOLD}配置完成!${NC}"
    echo "  ════════════════════════════════"
    echo ""
    echo "  下一步："
    echo "    1. source ~/.bashrc"
    echo "    2. cd $SCRIPT_DIR && ./exec_cds.sh"
    echo "    3. 访问 https://cds.${new_main}"
    echo ""
}

main "$@"
