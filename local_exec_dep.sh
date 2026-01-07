#!/usr/bin/env bash
set -euo pipefail

# 本地 server-only 一键构建/启动脚本（不含 desktop）
# 目标：
# - 不再执行 exec_dep.sh 那种“下载 admin dist + pull 远端 api 镜像”
# - 直接从本仓库源码构建：api 镜像 + gateway(含 prd-admin dist) 镜像
# - 一键 docker compose up（可选离线 docker load）
#
# 默认：使用“生产式”compose（docker-compose.yml + docker-compose.local.yml）
# 可选：--dev 使用 docker-compose.dev.yml（更像开发环境，暴露更多端口）
#
# 重要：后端已强制要求使用 Tencent COS（缺少必需环境变量会直接启动失败）

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
用法：
  ./local_exec_dep.sh [--dev] [--load-tars] [--skip-cos-check] [up|build|down|restart]

说明：
  - 默认模式（推荐）：prod-like
    使用 docker-compose.yml + docker-compose.local.yml
    - gateway：本地构建，内置 prd-admin dist（无需下载 zip）
    - api：本地构建（无需 pull 远端 ghcr 镜像）
    访问入口： http://localhost:5500

  - --dev：
    使用 docker-compose.dev.yml（本地构建 web+api；并暴露 Mongo/Redis/API 端口）

可选参数：
  --load-tars        启动前自动 docker load deploy/images/*.tar（用于离线/弱网）
  --skip-cos-check   跳过 COS 环境变量预检查（不建议；缺失时容器会启动失败）

命令：
  up        构建并启动（默认）
  build     仅构建镜像
  down      停止并清理容器（保留数据卷）
  restart   重启（down -> up）

关键环境变量（必须）：
  - TENCENT_COS_BUCKET
  - TENCENT_COS_REGION
  - TENCENT_COS_SECRET_ID
  - TENCENT_COS_SECRET_KEY

可选环境变量：
  - JWT_SECRET：未设置时脚本会生成一个仅用于本机的随机值（>=32 bytes）
  - TENCENT_COS_PUBLIC_BASE_URL：用于头像/静态资源 URL 拼接（不填不影响 api 启动，但部分头像 URL 可能为空）

离线镜像缓存（可选）：
  - 把 *.tar 放到 deploy/images/ 下（例如：docker save -o deploy/images/mongo-8.0.tar mongo:8.0）
EOF
}

if [ "${1:-}" = "help" ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

MODE="prod-like"
ACTION="up"
LOAD_TARS=0
SKIP_COS_CHECK=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dev)
      MODE="dev"
      shift
      ;;
    --load-tars)
      LOAD_TARS=1
      shift
      ;;
    --skip-cos-check)
      SKIP_COS_CHECK=1
      shift
      ;;
    up|build|down|restart)
      ACTION="$1"
      shift
      ;;
    *)
      echo "ERROR: 未知参数：$1" >&2
      echo "" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# 优先使用 docker compose（v2），兼容无 version 的 compose 文件；再回退 docker-compose（v1/独立版）
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "ERROR: 未找到 docker compose / docker-compose，请先安装并确保 docker daemon 正常运行" >&2
  exit 1
fi

# BuildKit 能显著减少重复下载/重复编译（尤其 pnpm 与 dotnet restore/publish）
export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}"
export COMPOSE_DOCKER_CLI_BUILD="${COMPOSE_DOCKER_CLI_BUILD:-1}"

compose_args=()
if [ "$MODE" = "dev" ]; then
  compose_args=(-f "$ROOT_DIR/docker-compose.dev.yml")
else
  compose_args=(-f "$ROOT_DIR/docker-compose.yml" -f "$ROOT_DIR/docker-compose.local.yml")
fi

if [ "$LOAD_TARS" -eq 1 ]; then
  tar_dir="$ROOT_DIR/deploy/images"
  if [ -d "$tar_dir" ]; then
    shopt -s nullglob
    tars=("$tar_dir"/*.tar)
    shopt -u nullglob
    if [ "${#tars[@]}" -gt 0 ]; then
      echo "Loading local docker image tars from: $tar_dir"
      for tar in "${tars[@]}"; do
        echo "  - docker load -i $(basename "$tar")"
        docker load -i "$tar" >/dev/null
      done
      echo "Done loading image tars."
      echo ""
    fi
  fi
fi

if [ "${JWT_SECRET:-}" = "" ]; then
  # 生成一个本机用的随机 JWT_SECRET（不写入仓库）
  if command -v openssl >/dev/null 2>&1; then
    JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  elif command -v python3 >/dev/null 2>&1; then
    JWT_SECRET="$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(48))
PY
)"
  else
    # 极端兜底：至少 32 bytes
    JWT_SECRET="local-dev-only-please-change-me-32bytes-minimum!!"
  fi
  export JWT_SECRET
  echo "JWT_SECRET 未设置，已为本机临时生成一个随机值（仅当前进程有效）。"
  echo ""
fi

if [ "$SKIP_COS_CHECK" -ne 1 ]; then
  missing=()
  for k in TENCENT_COS_BUCKET TENCENT_COS_REGION TENCENT_COS_SECRET_ID TENCENT_COS_SECRET_KEY; do
    if [ "${!k:-}" = "" ]; then
      missing+=("$k")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "ERROR: 后端已强制要求使用 Tencent COS，但你缺少必需环境变量：" >&2
    for k in "${missing[@]}"; do
      echo "  - $k" >&2
    done
    echo "" >&2
    echo "你可以这样注入（示例，不要把真实密钥写进仓库文件）： " >&2
    echo "  export TENCENT_COS_BUCKET=***" >&2
    echo "  export TENCENT_COS_REGION=***" >&2
    echo "  export TENCENT_COS_SECRET_ID=***" >&2
    echo "  export TENCENT_COS_SECRET_KEY=***" >&2
    echo "" >&2
    echo "如确实要跳过检查（不建议）：./local_exec_dep.sh --skip-cos-check up" >&2
    exit 2
  fi
fi

case "$ACTION" in
  build)
    "${COMPOSE[@]}" "${compose_args[@]}" build
    ;;
  up)
    "${COMPOSE[@]}" "${compose_args[@]}" up -d --build --remove-orphans
    echo ""
    echo "已启动："
    echo "  - 入口（gateway + admin）：http://localhost:5500"
    if [ "$MODE" = "dev" ]; then
      echo "  - API（直连）：http://localhost:5000"
      echo "  - MongoDB：mongodb://localhost:18081"
      echo "  - Redis：localhost:18082"
    fi
    ;;
  down)
    "${COMPOSE[@]}" "${compose_args[@]}" down --remove-orphans
    ;;
  restart)
    "${COMPOSE[@]}" "${compose_args[@]}" down --remove-orphans
    "${COMPOSE[@]}" "${compose_args[@]}" up -d --build --remove-orphans
    ;;
esac

