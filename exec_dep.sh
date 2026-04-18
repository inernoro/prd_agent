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
#   ./exec_dep.sh                # 一键部署 latest（唯一支持的版本）
#   ./exec_dep.sh --skip-verify  # 跳过 sha256 校验（CDN 缓存不一致时使用）
#   SKIP_VERIFY=1 ./exec_dep.sh  # 同上，环境变量方式
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
SKIP_VERIFY="${SKIP_VERIFY:-}"
if [ "${1:-}" = "--skip-verify" ]; then SKIP_VERIFY=1; fi

if [ -n "$SKIP_VERIFY" ]; then
  echo "跳过 sha256 校验（SKIP_VERIFY=1 或 --skip-verify）"
elif [ -n "$sha_url" ] && command -v sha256sum >/dev/null 2>&1; then
  if curl -fL "$sha_url" -o "$sha_path" 2>/dev/null; then
    echo "Verifying sha256..."
    # 兼容 sha256 文件内容为："<hash>  <filename>"
    expected="$(awk '{print $1}' "$sha_path" | head -n 1)"
    actual="$(sha256sum "$zip_path" | awk '{print $1}')"
    if [ -n "$expected" ] && [ "$expected" != "$actual" ]; then
      echo "WARN: sha256 不匹配，可能是 CDN 缓存不一致，等待 5 秒后重新下载..."
      sleep 5
      curl -fL -H "Cache-Control: no-cache" "$asset_url" -o "$zip_path"
      curl -fL -H "Cache-Control: no-cache" "$sha_url" -o "$sha_path" 2>/dev/null || true
      expected="$(awk '{print $1}' "$sha_path" | head -n 1)"
      actual="$(sha256sum "$zip_path" | awk '{print $1}')"
      if [ -n "$expected" ] && [ "$expected" != "$actual" ]; then
        echo "" >&2
        echo "ERROR: sha256 校验失败（expected=$expected actual=$actual）" >&2
        echo "" >&2
        echo "可能原因：" >&2
        echo "  1. GitHub Pages CDN 缓存了不同版本的 zip 和 sha256 文件" >&2
        echo "  2. 下载过程中文件被截断或损坏" >&2
        echo "" >&2
        echo "解决办法：" >&2
        echo "  - 等待几分钟后重试（等待 CDN 缓存刷新）" >&2
        echo "  - 跳过校验：SKIP_VERIFY=1 ./exec_dep.sh" >&2
        echo "  - 或使用 --skip-verify 参数：./exec_dep.sh --skip-verify" >&2
        exit 1
      fi
      echo "重试成功，sha256 校验通过"
    fi
  fi
fi

mkdir -p deploy/web/dist
rm -rf deploy/web/dist/*
unzip -q "$zip_path" -d deploy/web/dist

echo ""
echo "Static dist extracted to: deploy/web/dist"

# 激活独立部署模式的 nginx 配置：
# - 仓库里 default.conf 默认 symlink 到 branches/_disconnected.conf（CDS 未激活时的 502 兜底）
# - 独立部署模式下必须重指到 branches/_standalone.conf（真正的 /api/ → api:8080 反代）
# - 幂等：每次部署都重建 symlink，抗漂移、抗 git 副作用
NGINX_CONF_D="deploy/nginx/conf.d"
STANDALONE_CONF="$NGINX_CONF_D/branches/_standalone.conf"
DEFAULT_CONF="$NGINX_CONF_D/default.conf"
if [ ! -f "$STANDALONE_CONF" ]; then
  echo "ERROR: 缺少独立部署 nginx 配置：$STANDALONE_CONF" >&2
  echo "  这通常意味着仓库不完整，请确认已 git pull 到最新。" >&2
  exit 1
fi
echo "Activating standalone nginx config (default.conf -> branches/_standalone.conf) ..."
rm -f "$DEFAULT_CONF"
ln -s "branches/_standalone.conf" "$DEFAULT_CONF"

# 自动探测 / 安装 ffmpeg，并把宿主机真实路径导出为 FFMPEG_PATH / FFPROBE_PATH
# docker-compose.yml 通过 bind mount 把 ${FFMPEG_PATH} → 容器内的 /usr/local/bin/ffmpeg
# 探测顺序：
#   1) 用户显式指定的 FFMPEG_PATH/FFPROBE_PATH（存在即用）
#   2) 宿主机 PATH 中已有的 ffmpeg/ffprobe（标准 apt/brew/手动安装都走这条）
#   3) /opt/ffmpeg-static/ffmpeg（历史默认位置）
#   4) 都没有 → 自动下载 johnvansickle 静态版到 /opt/ffmpeg-static/
ensure_ffmpeg() {
  # —— 1) 用户显式指定 —— 尊重，不改写
  if [ -n "${FFMPEG_PATH:-}" ] && [ -n "${FFPROBE_PATH:-}" ]; then
    if [ -x "$FFMPEG_PATH" ] && [ -x "$FFPROBE_PATH" ]; then
      echo "使用用户指定 ffmpeg：$FFMPEG_PATH"
      return 0
    fi
    echo "WARN: FFMPEG_PATH=$FFMPEG_PATH 或 FFPROBE_PATH=$FFPROBE_PATH 不可执行，继续自动探测..." >&2
    unset FFMPEG_PATH FFPROBE_PATH
  fi

  # —— 2) 宿主机 PATH 已有（典型：/usr/local/bin/ffmpeg 或 /usr/bin/ffmpeg）
  host_ffmpeg="$(command -v ffmpeg 2>/dev/null || true)"
  host_ffprobe="$(command -v ffprobe 2>/dev/null || true)"
  if [ -n "$host_ffmpeg" ] && [ -n "$host_ffprobe" ]; then
    # 解析符号链接到真实路径（docker bind mount 对符号链接行为不稳）
    if command -v readlink >/dev/null 2>&1; then
      real_ffmpeg="$(readlink -f "$host_ffmpeg" 2>/dev/null || echo "$host_ffmpeg")"
      real_ffprobe="$(readlink -f "$host_ffprobe" 2>/dev/null || echo "$host_ffprobe")"
    else
      real_ffmpeg="$host_ffmpeg"
      real_ffprobe="$host_ffprobe"
    fi
    export FFMPEG_PATH="$real_ffmpeg"
    export FFPROBE_PATH="$real_ffprobe"
    ver="$("$real_ffmpeg" -version 2>/dev/null | head -n 1 || true)"
    echo "检测到宿主机 ffmpeg：$real_ffmpeg"
    echo "检测到宿主机 ffprobe：$real_ffprobe"
    [ -n "$ver" ] && echo "  版本：$ver"
    return 0
  fi

  # —— 3) 历史默认位置 /opt/ffmpeg-static
  if [ -x "/opt/ffmpeg-static/ffmpeg" ] && [ -x "/opt/ffmpeg-static/ffprobe" ]; then
    export FFMPEG_PATH="/opt/ffmpeg-static/ffmpeg"
    export FFPROBE_PATH="/opt/ffmpeg-static/ffprobe"
    echo "使用 /opt/ffmpeg-static/ffmpeg"
    return 0
  fi

  # —— 4) 都没有，走下载流程（目标 /opt/ffmpeg-static）
  ffmpeg_target="/opt/ffmpeg-static/ffmpeg"
  ffprobe_target="/opt/ffmpeg-static/ffprobe"

  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) arch_slug="amd64" ;;
    aarch64|arm64) arch_slug="arm64" ;;
    armv7l|armhf) arch_slug="armhf" ;;
    i386|i686) arch_slug="i686" ;;
    *)
      echo "WARN: 未识别架构 $arch，跳过 ffmpeg 自动安装。请手动准备 $ffmpeg_target 和 $ffprobe_target" >&2
      return 0
      ;;
  esac

  SUDO=""
  if [ "$(id -u)" != "0" ] && [ ! -w "/opt" ]; then
    if command -v sudo >/dev/null 2>&1; then
      SUDO="sudo"
    else
      echo "ERROR: /opt 不可写且无 sudo，无法自动安装 ffmpeg。" >&2
      echo "      请手动执行（以 root 身份）：" >&2
      echo "        mkdir -p /opt/ffmpeg-static && \\" >&2
      echo "        curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${arch_slug}-static.tar.xz | \\" >&2
      echo "          tar xJ -C /opt/ffmpeg-static --strip-components=1" >&2
      return 1
    fi
  fi

  ffmpeg_url="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${arch_slug}-static.tar.xz"
  ffmpeg_tmp="$tmp_dir/ffmpeg-static.tar.xz"

  echo "正在下载 ffmpeg 静态版 ($arch_slug) ..."
  echo "  来源：$ffmpeg_url"
  if ! curl -fL "$ffmpeg_url" -o "$ffmpeg_tmp"; then
    echo "ERROR: 下载 ffmpeg 失败。" >&2
    echo "      你可以手动执行：" >&2
    echo "        $SUDO mkdir -p /opt/ffmpeg-static && \\" >&2
    echo "        curl -L $ffmpeg_url | $SUDO tar xJ -C /opt/ffmpeg-static --strip-components=1" >&2
    return 1
  fi

  echo "解压到 /opt/ffmpeg-static ..."
  $SUDO mkdir -p /opt/ffmpeg-static
  if ! $SUDO tar xJf "$ffmpeg_tmp" -C /opt/ffmpeg-static --strip-components=1; then
    echo "ERROR: 解压 ffmpeg 失败（需要系统自带 xz 支持的 tar）。" >&2
    return 1
  fi

  if [ -x "$ffmpeg_target" ] && [ -x "$ffprobe_target" ]; then
    export FFMPEG_PATH="$ffmpeg_target"
    export FFPROBE_PATH="$ffprobe_target"
    ver="$("$ffmpeg_target" -version 2>/dev/null | head -n 1 || true)"
    echo "ffmpeg 安装完成：${ver:-$ffmpeg_target}"
  else
    echo "ERROR: ffmpeg 安装后仍找不到 $ffmpeg_target / $ffprobe_target" >&2
    return 1
  fi
}

ensure_ffmpeg || echo "WARN: ffmpeg 自动安装失败，视频创作 / 转录相关功能可能报错。" >&2

echo "Pulling latest api image..."
$COMPOSE pull api

echo "Ensuring Docker network exists..."
docker network inspect prdagent-network >/dev/null 2>&1 || docker network create prdagent-network

echo "Starting compose (force recreate to ensure new image is used)..."
$COMPOSE up -d --force-recreate


