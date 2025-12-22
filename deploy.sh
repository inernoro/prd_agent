#!/usr/bin/env sh
set -eu

# 生产部署脚本：
# - 从 GitHub Release 下载 prd-admin dist 压缩包
# - 解压到 deploy/web/dist
# - 校验 sha256（如果 Release 同时上传了 .sha256 文件）
# - 执行 docker-compose up -d（若系统仅有 docker compose，则自动回退）
#
# 依赖：curl + unzip（或 busybox unzip），以及 docker-compose
#
# 用法：
#   ./deploy.sh          # 一键部署 latest（唯一支持的版本）
#   ./deploy.sh anything # 为兼容旧用法：任何参数都会按 latest 处理
#
# 可选环境变量：
#   - PRD_AGENT_API_IMAGE：覆盖后端镜像（默认按 REPO 组装 :latest）
#   - REPO：覆盖 GitHub 仓库 owner/repo（默认尝试从 git remote 推断；推断失败则回退 inernoro/prd_agent）
#   - DIST_URL：直接指定静态 zip 下载地址（完全跳过 Release/Pages 逻辑）
#   - PAGES_BASE_URL：覆盖 GitHub Pages 根地址（默认 https://<owner>.github.io/<repo>/）
#   - GITHUB_TOKEN：仅当 Release 资产为私有时需要（公开 Pages 下载不需要）

# 只维护一个版本：latest（任何参数都按 latest 处理）
TAG="latest"
# 兼容两种方式传 repo：
# - 环境变量：export REPO="owner/repo"
# - 位置参数：./deploy.sh <tag> owner/repo
REPO="${REPO:-${2:-}}"

# 若未显式提供 REPO，尝试从当前目录的 git remote 推断（通常无需手填）
if [ -z "$REPO" ] && command -v git >/dev/null 2>&1; then
  origin="$(git config --get remote.origin.url 2>/dev/null || true)"
  case "$origin" in
    git@github.com:*)
      REPO="${origin#git@github.com:}"
      REPO="${REPO%.git}"
      ;;
    https://github.com/*)
      REPO="${origin#https://github.com/}"
      REPO="${REPO%.git}"
      ;;
  esac
fi

if [ -z "$REPO" ]; then
  # 支持“从任何地方下载源码 zip 后直接跑”：没有 git remote 就回退默认仓库
  REPO="inernoro/prd_agent"
fi

OWNER="${REPO%%/*}"
REPO_NAME="${REPO##*/}"

# 默认后端镜像（latest 一键部署）
if [ -z "${PRD_AGENT_API_IMAGE:-}" ]; then
  export PRD_AGENT_API_IMAGE="ghcr.io/${OWNER}/${REPO_NAME}/prdagent-server:latest"
fi

if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
elif command -v docker >/dev/null 2>&1; then
  COMPOSE="docker compose"
else
  echo "ERROR: 未找到 docker-compose 或 docker 命令" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT

asset_url=""
sha_url=""

if [ -n "${DIST_URL:-}" ]; then
  asset_url="$DIST_URL"
else
  pages_base="${PAGES_BASE_URL:-https://${OWNER}.github.io/${REPO_NAME}}"
  asset_url="${pages_base%/}/prd-admin-dist-latest.zip"
  sha_url="${pages_base%/}/prd-admin-dist-latest.zip.sha256"
fi

if [ -z "$asset_url" ]; then
  echo "ERROR: 未能确定静态站压缩包下载地址。" >&2
  echo "  - 默认从 GitHub Pages 下载 prd-admin-dist-latest.zip（可用 PAGES_BASE_URL 覆盖）" >&2
  echo "  - 或直接设置 DIST_URL=... 指定 zip 地址" >&2
  exit 1
fi

zip_path="$tmp_dir/prd-admin-dist.zip"
echo "Downloading: $asset_url"
curl -fL "$asset_url" -o "$zip_path"

sha_path="$tmp_dir/prd-admin-dist.zip.sha256"
if [ -n "$sha_url" ] && command -v sha256sum >/dev/null 2>&1; then
  if curl -fL "$sha_url" -o "$sha_path" 2>/dev/null; then
    echo "Verifying sha256..."
    # 兼容 sha256 文件内容为："<hash>  <filename>"
    expected="$(awk '{print $1}' "$sha_path" | head -n 1)"
    actual="$(sha256sum "$zip_path" | awk '{print $1}')"
    if [ -n "$expected" ] && [ "$expected" != "$actual" ]; then
      echo "ERROR: sha256 校验失败（expected=$expected actual=$actual）" >&2
      exit 1
    fi
  fi
fi

mkdir -p deploy/web/dist
rm -rf deploy/web/dist/*
unzip -q "$zip_path" -d deploy/web/dist

echo ""
echo "Static dist extracted to: deploy/web/dist"
echo "Starting compose..."
$COMPOSE up -d


