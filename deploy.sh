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
#   REPO="inernoro/prd_agent" ./deploy.sh v1.2.3
#   REPO="inernoro/prd_agent" ./deploy.sh latest
#
# 必需环境变量：
#   PRD_AGENT_API_IMAGE=ghcr.io/<org>/<repo>/prdagent-server:<tag>   (或 @sha256:...)
# 可选：
#   GITHUB_TOKEN=...  (仅当仓库/Release 资产为私有时需要)

REPO="${REPO:-}"
TAG="${1:-latest}"

if [ -z "$REPO" ]; then
  echo "ERROR: 请设置 REPO（例如 REPO=inernoro/prd_agent）" >&2
  exit 1
fi

if [ -z "${PRD_AGENT_API_IMAGE:-}" ]; then
  echo "ERROR: 请设置 PRD_AGENT_API_IMAGE（例如 ghcr.io/inernoro/prd_agent/prdagent-server:vX.Y.Z 或 @sha256:...）" >&2
  exit 1
fi

if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
elif command -v docker >/dev/null 2>&1; then
  COMPOSE="docker compose"
else
  echo "ERROR: 未找到 docker-compose 或 docker 命令" >&2
  exit 1
fi

api="https://api.github.com/repos/$REPO/releases"
if [ "$TAG" = "latest" ]; then
  url="$api/latest"
else
  url="$api/tags/$TAG"
fi

auth_header=""
if [ -n "${GITHUB_TOKEN:-}" ]; then
  auth_header="Authorization: token $GITHUB_TOKEN"
fi

tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT

release_json="$tmp_dir/release.json"
if [ -n "$auth_header" ]; then
  curl -fsSL -H "$auth_header" "$url" -o "$release_json"
else
  curl -fsSL "$url" -o "$release_json"
fi

pick_asset_url_py='
import json,sys,re
data=json.load(open(sys.argv[1],"r",encoding="utf-8"))
assets=data.get("assets",[])
pat=re.compile(r"^prd-admin-dist-.*\.zip$")
for a in assets:
    name=a.get("name","")
    if pat.match(name):
        print(a.get("browser_download_url",""))
        sys.exit(0)
print("")
sys.exit(0)
'

asset_url="$(python3 -c "$pick_asset_url_py" "$release_json" 2>/dev/null || true)"
if [ -z "$asset_url" ]; then
  # 兼容 python3 不存在：用最弱的 grep/awk 兜底（要求 JSON 里有 browser_download_url）
  asset_url="$(grep -Eo '"browser_download_url":[ ]*"[^"]+"' "$release_json" | grep -E 'prd-admin-dist-.*\.zip' | head -n 1 | awk -F'"' '{print $4}' || true)"
fi

if [ -z "$asset_url" ]; then
  echo "ERROR: 未在 Release($TAG) 中找到 prd-admin dist 资产（期望名称形如 prd-admin-dist-<tag>.zip）" >&2
  echo "       你可以去 Release 页面确认是否有上传 dist 压缩包。" >&2
  exit 1
fi

sha_url=""
sha_url="$(printf "%s" "$asset_url" | sed 's/\.zip$/.zip.sha256/')"

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


