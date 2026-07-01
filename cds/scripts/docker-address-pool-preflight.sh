#!/usr/bin/env bash
# Docker address pool preflight for CDS.
#
# CDS creates one project bridge network plus one branch bridge network per
# active preview branch. Docker's default local address pool is small on many
# hosts, so a healthy-looking CDS install can later fail with:
#   all predefined address pools have been fully subnetted
#
# Default mode is advisory: print warnings and return 0 so first install is not
# blocked. Set CDS_DOCKER_POOL_PREFLIGHT_STRICT=1 to fail on high-risk hosts.

set -euo pipefail

STRICT="${CDS_DOCKER_POOL_PREFLIGHT_STRICT:-0}"
WARN_BRIDGE_LIMIT="${CDS_DOCKER_POOL_WARN_BRIDGE_LIMIT:-20}"
CRITICAL_BRIDGE_LIMIT="${CDS_DOCKER_POOL_CRITICAL_BRIDGE_LIMIT:-28}"

warn() {
  printf '[WARN] %s\n' "$*" >&2
}

info() {
  printf '[INFO] %s\n' "$*"
}

fail_or_warn() {
  if [ "${STRICT}" = "1" ]; then
    printf '[FAIL] %s\n' "$*" >&2
    exit 1
  fi
  warn "$*"
}

print_suggestion() {
  cat >&2 <<'TEXT'
[INFO] 建议在 Docker daemon 中配置更大的 default-address-pools，例如:
{
  "default-address-pools": [
    { "base": "10.240.0.0/16", "size": 24 },
    { "base": "10.241.0.0/16", "size": 24 }
  ]
}
[INFO] 应用前必须确认这些网段不与宿主机、VPN、内网路由冲突。修改 daemon.json 后需要重启 Docker，会中断当前容器。
TEXT
}

has_configured_default_pools() {
  if [ "${CDS_ASSUME_DOCKER_POOL_CONFIGURED:-0}" = "1" ]; then
    return 0
  fi

  local from_info=''
  from_info="$(docker info --format '{{json .DefaultAddressPools}}' 2>/dev/null || true)"
  case "${from_info}" in
    ''|'<no value>'|'null'|'[]')
      ;;
    *'template: '*|*'can'\''t evaluate field'*)
      ;;
    *)
      return 0
      ;;
  esac

  if [ -f /etc/docker/daemon.json ] && grep -q '"default-address-pools"' /etc/docker/daemon.json 2>/dev/null; then
    return 0
  fi

  return 1
}

main() {
  if ! command -v docker >/dev/null 2>&1; then
    fail_or_warn '未找到 docker 命令。CDS 部署分支时需要 Docker；请先安装并启动 Docker。'
    return 0
  fi

  if ! docker info >/dev/null 2>&1; then
    fail_or_warn 'Docker daemon 当前不可用。CDS 安装可以继续，但首次部署前必须让 docker info 成功。'
    return 0
  fi

  local bridge_count='0'
  local cds_branch_count='0'
  bridge_count="$(docker network ls --filter driver=bridge --format '{{.Name}}' 2>/dev/null | wc -l | tr -d '[:space:]')"
  cds_branch_count="$(docker network ls --filter driver=bridge --format '{{.Name}}' 2>/dev/null | grep -c '^cds-br-' || true)"

  info "Docker bridge 网络数: ${bridge_count}; CDS 分支网络数: ${cds_branch_count}"

  local configured='0'
  if has_configured_default_pools; then
    configured='1'
    info '检测到 Docker default-address-pools 已配置。'
  else
    warn '未检测到 Docker default-address-pools。分支预览增多后可能耗尽 Docker 默认地址池。'
    print_suggestion
  fi

  if [ "${bridge_count}" -ge "${CRITICAL_BRIDGE_LIMIT}" ]; then
    print_suggestion
    fail_or_warn "Docker bridge 网络数已达到 ${bridge_count}，接近默认地址池经验上限。请清理无用网络或扩容 default-address-pools。"
    return 0
  fi

  if [ "${bridge_count}" -ge "${WARN_BRIDGE_LIMIT}" ]; then
    warn "Docker bridge 网络数已达到 ${bridge_count}，建议在继续增加 CDS 分支前扩容 default-address-pools。"
    if [ "${configured}" != "1" ]; then
      print_suggestion
    fi
    return 0
  fi

  if [ "${configured}" = "1" ]; then
    info 'Docker 地址池预检通过。'
  else
    info 'Docker 地址池预检完成：当前网络数不高，但建议在正式多人使用前配置 default-address-pools。'
  fi
}

main "$@"
