#!/usr/bin/env sh
set -eu

# 生产部署脚本：
# - 从 GitHub Release 下载 prd-admin dist 压缩包
# - 在稳定的 deploy/web/dist bind 根内离线校验并原子切换 current/previous
# - 校验 sha256（如果 Release 同时上传了 .sha256 文件）
# - 执行 docker-compose up -d（若系统仅有 docker compose，则自动回退）
#
# 依赖：curl + unzip（或 busybox unzip），以及 docker-compose
#
# 用法：
#   ./exec_dep.sh                # 一键部署 latest（兼容旧路径）
#   ./exec_dep.sh --commit <sha> # 部署不可变 commit 产物（后端 sha-<sha> + 前端 prd-admin-dist-sha-<sha>.zip）
#   ./exec_dep.sh --tag <tag>    # 部署不可变发布 tag 产物（后端 <tag> + 前端 prd-admin-dist-<tag>.zip）
#   ./exec_dep.sh --ref <ref>    # 部署 latest / sha-<sha> / <tag>
#   ./exec_dep.sh --skip-verify  # 跳过 sha256 校验（CDN 缓存不一致时使用）
#   SKIP_VERIFY=1 ./exec_dep.sh  # 同上，环境变量方式
#
# 可选环境变量：
#   - PRD_AGENT_RELEASE_REF：指定发布 ref（latest / sha-<commit> / <tag>）
#   - PRD_AGENT_DEPLOY_COMMIT：指定 commit，等价于 PRD_AGENT_RELEASE_REF=sha-<commit>
#   - PRD_AGENT_RELEASE_TAG：指定发布 tag，等价于 PRD_AGENT_RELEASE_REF=<tag>
#   - PRD_AGENT_RELEASE_INTENT_FILE：fast.sh 写入、exec_dep.sh 校验的同 commit 发布意图文件，默认 .prd-agent-release-intent.env
#   - PRD_AGENT_REQUIRE_FAST_INTENT=1：强制要求先跑 fast.sh 生成发布意图文件
#   - PRD_AGENT_IGNORE_FAST_INTENT=1：紧急场景忽略 fast.sh 发布意图文件漂移校验
#   - PRD_AGENT_REUSE_EXISTING_STATIC_DIST=1：复用现有 deploy/web/dist，不下载 prd-admin zip；仅用于后端/GW-only shadow 部署
#   - PRD_AGENT_API_IMAGE：覆盖后端镜像（默认按 REPO + 发布 ref 组装，并优先走 get.miduo.org 镜像代理）
#   - PRD_AGENT_LLMGW_IMAGE：覆盖独立 LLM 网关镜像（默认按 REPO + 发布 ref 组装；compose 已含 llmgw service，随 up 一起拉起）
#   - PRD_AGENT_DESIGN_OPENDESIGN_IMAGE：覆盖设计执行服务镜像（默认按 REPO + 发布 ref 组装，与 api 同批拉取）
#   - DESIGN_RUNTIME_API_KEY：api 与 design-opendesign 之间的内部密钥；.env 里没有时自动生成并写入，不打印
#   - DESIGN_ARTIFACT_PUBLIC_BASE_URL：设计服务回调 api 的公网基址，默认取 PRD_AGENT_PUBLIC_BASE_URL
#   - DESIGN_RUNTIME_READY_TIMEOUT_SECONDS：发布等待 design-opendesign 容器健康的上限，默认 420 秒
#   - API_PULL_TIMEOUT_SECONDS：发布镜像整批拉取总超时时间，默认 420 秒
#   - SKIP_API_PULL=1：跳过后端镜像拉取，仅更新静态站点并重建 compose
#   - REPO：覆盖 GitHub 仓库 owner/repo（默认尝试从 git remote 推断；推断失败则回退 inernoro/prd_agent）
#   - DIST_URL：直接指定静态 zip 下载地址（完全跳过 Release/Pages 逻辑）
#   - DIST_SHA256 / DIST_SHA256_URL：DIST_URL 对应的审计哈希或哈希文件；不可变发布必须提供其一
#   - PAGES_BASE_URL：覆盖 GitHub Pages 根地址（默认优先走 get.miduo.org 代理）
#   - PRD_AGENT_PUBLIC_BASE_URL：发布后公网表面验收与网关返回 MAP 的权威根地址，必须显式配置
#   - PRD_AGENT_API_SERVICE：正式 Compose 中的 API service 名，默认 api
#   - PRD_AGENT_ASSET_STORAGE_READINESS_INTERNAL_URL：API 容器内强制存储探针地址
#   - PRD_AGENT_ASSET_STORAGE_READINESS_ATTEMPTS / INTERVAL_SECONDS / TIMEOUT_SECONDS：存储发布门禁重试参数
#   - PRD_AGENT_RELEASE_EVIDENCE_DIR：不可覆盖的发布证据目录，默认 $HOME/prd-agent-release-evidence
#   - GITHUB_TOKEN：仅当 Release 资产为私有时需要（公开 Pages 下载不需要）
#   - LLMGW_GATE_BASE / GW_BASE：发布后网关探测使用的 serving base URL（形如 https://host/gw/v1）；
#     未设时由 PRD_AGENT_PUBLIC_BASE_URL + PRD_AGENT_PUBLIC_LLMGW_SERVING_BASE_PATH（默认 /llmgw/gw/v1）推出，发布后必跑带 key 的 serving probe
#   - LLMGW_GATE_KEY / GW_KEY：发布后网关探测使用的 X-Gateway-Key；未设时回退 .env 的 LLMGW_SERVE_KEY，三者皆空则拒绝发布
#   - LLMGW_POST_DEPLOY_SERVICE_KEY：发布后 D 层业务 smoke 使用的 scoped service key；
#     未设时兼容回退 LLMGW_GATE_KEY。
#   - LLMGW_POST_DEPLOY_PROTOCOL_CANARY_KEY：四协议 canary 使用的 scoped service key；
#     sourceSystem 应与 canary 请求的 X-Gateway-Source 一致。未设时兼容回退业务 smoke key。
#   - LLMGW_SERVE_BASE_URL：生产必须为 http://gateway，客户端会追加 /gw/v1/*，禁止 API 固定到单个 serving
#   - LLMGW_READINESS_ASSET_PROBE_KEY：生产深度 readiness 使用的稳定对象 key，必须存在
#   - LLMGW_GATE_HEALTH_SAMPLES：发布后 healthz 连续采样次数，默认 3
#   - LLMGW_GATE_HEALTH_INTERVAL_SECONDS：healthz 连续采样间隔秒数，默认 5
#   - LLMGW_GATE_SERVING_PROBE_SAMPLES：serving probe healthz 连续采样次数，默认跟随 LLMGW_GATE_HEALTH_SAMPLES
#   - LLMGW_GATE_SERVING_PROBE_INTERVAL_SECONDS：serving probe 连续采样间隔秒数，默认跟随 LLMGW_GATE_HEALTH_INTERVAL_SECONDS
#   - LLMGW_SERVING_PROBE_JSON_OUT / LLMGW_SERVING_PROBE_REPORT_MD：保存 post-deploy serving probe 证据
#   - LLMGW_GATE_RUN_SMOKE：发布后是否运行 gw-smoke.py（会真调模型）；显式给了探测 key 或业务 smoke key 时默认 1，否则默认 0
#   - LLMGW_GATE_SMOKE_TIMEOUT_SECONDS：gw-smoke.py 单请求超时，默认 120
#   - GW_SMOKE_JSON_OUT / GW_SMOKE_REPORT_MD：保存 post-deploy D 层 smoke 证据

SKIP_VERIFY="${SKIP_VERIFY:-}"
LLMGW_VERIFY_ONLY="${LLMGW_VERIFY_ONLY:-0}"
release_ref="${PRD_AGENT_RELEASE_REF:-}"
release_ref_type="ref"

print_usage() {
  cat <<'USAGE'
Usage:
  ./exec_dep.sh
  ./exec_dep.sh release
  ./exec_dep.sh --commit <40-char-sha>
  ./exec_dep.sh --tag <tag>
  ./exec_dep.sh --ref <latest|sha-commit|tag>

Compatibility:
  ./exec_dep.sh release continues to deploy latest. Prefer an immutable --commit for audited production releases.
USAGE
}

if [ -z "$release_ref" ] && [ -n "${PRD_AGENT_DEPLOY_COMMIT:-}" ]; then
  release_ref="$PRD_AGENT_DEPLOY_COMMIT"
  release_ref_type="commit"
fi
if [ -z "$release_ref" ] && [ -n "${PRD_AGENT_RELEASE_TAG:-}" ]; then
  release_ref="$PRD_AGENT_RELEASE_TAG"
  release_ref_type="tag"
fi

pos_index=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      print_usage
      exit 0
      ;;
    --skip-verify)
      SKIP_VERIFY=1
      ;;
    --commit)
      shift
      if [ "$#" -eq 0 ]; then
        echo "ERROR: --commit 需要一个 commit sha" >&2
        exit 1
      fi
      release_ref="$1"
      release_ref_type="commit"
      ;;
    --commit=*)
      release_ref="${1#--commit=}"
      release_ref_type="commit"
      ;;
    --tag)
      shift
      if [ "$#" -eq 0 ]; then
        echo "ERROR: --tag 需要一个发布 tag" >&2
        exit 1
      fi
      release_ref="$1"
      release_ref_type="tag"
      ;;
    --tag=*)
      release_ref="${1#--tag=}"
      release_ref_type="tag"
      ;;
    --ref)
      shift
      if [ "$#" -eq 0 ]; then
        echo "ERROR: --ref 需要一个发布 ref" >&2
        exit 1
      fi
      release_ref="$1"
      release_ref_type="ref"
      ;;
    --ref=*)
      release_ref="${1#--ref=}"
      release_ref_type="ref"
      ;;
    --repo)
      shift
      if [ "$#" -eq 0 ]; then
        echo "ERROR: --repo 需要 owner/repo" >&2
        exit 1
      fi
      REPO="$1"
      ;;
    --repo=*)
      REPO="${1#--repo=}"
      ;;
    --*)
      echo "ERROR: 未识别参数：$1" >&2
      exit 1
      ;;
    *)
      pos_index=$((pos_index + 1))
      if [ "$pos_index" -eq 1 ] && [ "$1" = "release" ] && [ -z "$release_ref" ]; then
        release_ref="latest"
        release_ref_type="ref"
        echo "Compatibility: './exec_dep.sh release' deploys latest; prefer '--commit <40-char-sha>' for audited releases." >&2
      elif [ "$pos_index" -eq 1 ] && [ -z "$release_ref" ]; then
        release_ref="$1"
        release_ref_type="ref"
      elif [ "$pos_index" -le 2 ] && [ -z "${REPO:-}" ]; then
        REPO="$1"
      else
        echo "ERROR: 多余参数：$1" >&2
        exit 1
      fi
      ;;
  esac
  shift
done

if [ -z "$release_ref" ]; then
  release_ref="latest"
  release_ref_type="ref"
fi

normalize_commit_ref() {
  commit="$1"
  case "$commit" in
    sha-*)
      commit="${commit#sha-}"
      ;;
  esac
  lower_commit="$(printf '%s' "$commit" | tr 'A-F' 'a-f')"
  if printf '%s' "$lower_commit" | grep -Eq '^[0-9a-f]{40}$'; then
    printf 'sha-%s' "$lower_commit"
    return 0
  fi

  echo "ERROR: commit ref 必须是完整 40 位 SHA 或 sha-<40位SHA>，不能使用短 SHA：$1" >&2
  return 1
}

normalize_ref() {
  raw="$1"
  ref_type="$2"
  case "$ref_type" in
    commit)
      normalize_commit_ref "$raw"
      return $?
      ;;
    tag)
      if printf '%s' "$raw" | grep -Eq '^[A-Za-z0-9._-]+$'; then
        printf '%s' "$raw"
        return 0
      fi
      echo "ERROR: 发布 tag 只能包含 A-Z/a-z/0-9/._-：$raw" >&2
      return 1
      ;;
  esac

  case "$raw" in
    latest)
      printf '%s' "latest"
      return 0
      ;;
    sha-*)
      normalize_commit_ref "$raw"
      return $?
      ;;
  esac

  lower_raw="$(printf '%s' "$raw" | tr 'A-F' 'a-f')"
  if printf '%s' "$lower_raw" | grep -Eq '^[0-9a-f]{7,40}$'; then
    echo "ERROR: 十六进制 ref 存在歧义。部署 commit 请用 --commit <40位SHA>，部署 tag 请用 --tag <tag>：$raw" >&2
    return 1
  fi

  if printf '%s' "$raw" | grep -Eq '^[A-Za-z0-9._-]+$'; then
    printf '%s' "$raw"
    return 0
  fi

  echo "ERROR: 发布 ref 只能是 latest、commit sha、sha-<commit> 或仅含 A-Z/a-z/0-9/._- 的 tag：$raw" >&2
  return 1
}

TAG="$(normalize_ref "$release_ref" "$release_ref_type")"
if [ "$TAG" = "latest" ]; then
  echo "Deploy target: latest"
else
  echo "Deploy target: immutable ref $TAG"
fi

# 兼容两种方式传 repo：
# - 环境变量：export REPO="owner/repo"
# - 参数：./exec_dep.sh --ref <ref> --repo owner/repo
REPO="${REPO:-}"

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

default_api_image="get.miduo.org/ghcr.io/${OWNER}/${REPO_NAME}/prdagent-server:${TAG}"
default_llmgw_image="get.miduo.org/ghcr.io/${OWNER}/${REPO_NAME}/prdagent-llmgw:${TAG}"
default_llmgw_serve_image="get.miduo.org/ghcr.io/${OWNER}/${REPO_NAME}/prdagent-llmgw-serve:${TAG}"
default_llmgw_web_image="get.miduo.org/ghcr.io/${OWNER}/${REPO_NAME}/prdagent-llmgw-web:${TAG}"
default_design_opendesign_image="get.miduo.org/ghcr.io/${OWNER}/${REPO_NAME}/prdagent-design-opendesign:${TAG}"

if [ "$release_ref_type" = "commit" ] && [ "${PRD_AGENT_ALLOW_IMAGE_OVERRIDE:-0}" != "1" ]; then
  if [ -n "${PRD_AGENT_API_IMAGE:-}${PRD_AGENT_LLMGW_IMAGE:-}${PRD_AGENT_LLMGW_SERVE_IMAGE:-}${PRD_AGENT_LLMGW_WEB_IMAGE:-}${PRD_AGENT_DESIGN_OPENDESIGN_IMAGE:-}" ]; then
    echo "WARN: --commit 发布默认忽略 PRD_AGENT_*_IMAGE 覆盖，确保五个镜像钉到 ${TAG}；如确需覆盖请设置 PRD_AGENT_ALLOW_IMAGE_OVERRIDE=1" >&2
  fi
  export PRD_AGENT_API_IMAGE="$default_api_image"
  export PRD_AGENT_LLMGW_IMAGE="$default_llmgw_image"
  export PRD_AGENT_LLMGW_SERVE_IMAGE="$default_llmgw_serve_image"
  export PRD_AGENT_LLMGW_WEB_IMAGE="$default_llmgw_web_image"
  export PRD_AGENT_DESIGN_OPENDESIGN_IMAGE="$default_design_opendesign_image"
fi

# 默认后端镜像。latest 兼容旧部署；指定 ref 时钉到不可变 tag，避免 latest 竞态。
if [ -z "${PRD_AGENT_API_IMAGE:-}" ]; then
  export PRD_AGENT_API_IMAGE="$default_api_image"
fi

# 默认独立 LLM 网关镜像（控制台 llmgw/console-api，自包含 ASP.NET 服务，监听 8090，提供 /gw/healthz、
# /gw/auth/login、/gw/logs）。llmgw/console-api 已是独立项目（CI branch-image 构建 prdagent-llmgw 镜像），
# 故默认必须指向 prdagent-llmgw:<发布ref>，不能复用 api 镜像——否则 llmgw 服务会错跑
# PrdAgent.Api.dll、/gw/* 端点全缺。指定 --commit 时也必须钉到同一个 sha ref，避免
# api 是不可变版本而 GW 三容器仍漂在 latest。
if [ -z "${PRD_AGENT_LLMGW_IMAGE:-}" ]; then
  export PRD_AGENT_LLMGW_IMAGE="$default_llmgw_image"
fi

# 默认 LLM serving 网关镜像（llmgw-serve，DI 承载 LlmGateway/ModelResolver，监听 8091，暴露 /gw/v1/*）。
# compose 现在随 up 一起拉起 llmgw-serve；docker-compose.yml 默认直连 ghcr.io，需代理的主机会绕过
# get.miduo.org 预拉/超时路径而卡住或失败，故这里照 PRD_AGENT_LLMGW_IMAGE 范式钉到镜像源。
if [ -z "${PRD_AGENT_LLMGW_SERVE_IMAGE:-}" ]; then
  export PRD_AGENT_LLMGW_SERVE_IMAGE="$default_llmgw_serve_image"
fi

# 默认 LLM 网关前端静态站镜像（llmgw-web，nginx 托管控制台构建产物）。同样随 compose up 拉起，
# 默认直连 ghcr.io，需代理主机会卡住，故一并钉到 get.miduo.org 镜像源。
if [ -z "${PRD_AGENT_LLMGW_WEB_IMAGE:-}" ]; then
  export PRD_AGENT_LLMGW_WEB_IMAGE="$default_llmgw_web_image"
fi

# 设计执行服务镜像（design-opendesign）。main 的每个提交都会构建 sha-<commit>，与 api 钉同一个 ref。
if [ -z "${PRD_AGENT_DESIGN_OPENDESIGN_IMAGE:-}" ]; then
  export PRD_AGENT_DESIGN_OPENDESIGN_IMAGE="$default_design_opendesign_image"
fi

intent_value() {
  intent_key="$1"
  intent_file="$2"
  awk -F= -v key="$intent_key" '$1 == key { print substr($0, index($0, "=") + 1); exit }' "$intent_file"
}

check_fast_release_intent() {
  release_intent_file="${PRD_AGENT_RELEASE_INTENT_FILE:-.prd-agent-release-intent.env}"
  if [ -z "$release_intent_file" ]; then
    echo "Release intent: disabled (PRD_AGENT_RELEASE_INTENT_FILE empty)"
    return 0
  fi
  if [ "${PRD_AGENT_IGNORE_FAST_INTENT:-}" = "1" ]; then
    echo "WARN: Release intent check skipped because PRD_AGENT_IGNORE_FAST_INTENT=1" >&2
    return 0
  fi
  if [ ! -f "$release_intent_file" ]; then
    if [ "${PRD_AGENT_REQUIRE_FAST_INTENT:-}" = "1" ]; then
      echo "ERROR: PRD_AGENT_REQUIRE_FAST_INTENT=1 but release intent file is missing: $release_intent_file" >&2
      echo "       先运行 ./fast.sh --commit <40位SHA>，再用同一个 commit 运行 ./exec_dep.sh --commit <40位SHA>。" >&2
      exit 1
    fi
    echo "Release intent: none ($release_intent_file not found); exec_dep.sh will deploy requested ref directly"
    return 0
  fi

  intent_tag="$(intent_value RELEASE_TAG "$release_intent_file")"
  intent_repo="$(intent_value REPO "$release_intent_file")"
  if [ -z "$intent_tag" ] || [ -z "$intent_repo" ]; then
    echo "ERROR: release intent file is invalid: $release_intent_file" >&2
    echo "       缺少 RELEASE_TAG 或 REPO；请重新运行 ./fast.sh --commit <40位SHA>。" >&2
    exit 1
  fi
  if [ "$intent_tag" != "$TAG" ]; then
    echo "ERROR: fast.sh / exec_dep.sh release ref mismatch." >&2
    echo "       fast.sh warmed:  $intent_tag" >&2
    echo "       exec_dep wants: $TAG" >&2
    echo "       必须用同一个 commit/tag 重新运行两步；紧急绕过需显式 PRD_AGENT_IGNORE_FAST_INTENT=1。" >&2
    exit 1
  fi
  if [ "$intent_repo" != "$REPO" ]; then
    echo "ERROR: fast.sh / exec_dep.sh repo mismatch." >&2
    echo "       fast.sh repo:   $intent_repo" >&2
    echo "       exec_dep repo:  $REPO" >&2
    echo "       必须用同一个 REPO 重新运行两步；紧急绕过需显式 PRD_AGENT_IGNORE_FAST_INTENT=1。" >&2
    exit 1
  fi

  check_intent_image_match() {
    image_key="$1"
    actual_image="$2"
    intent_image="$(intent_value "$image_key" "$release_intent_file")"
    if [ -z "$intent_image" ]; then
      echo "ERROR: release intent file is invalid: $release_intent_file" >&2
      echo "       缺少 $image_key；请重新运行 ./fast.sh --commit <40位SHA>。" >&2
      exit 1
    fi
    if [ "$intent_image" != "$actual_image" ]; then
      echo "ERROR: fast.sh / exec_dep.sh image mismatch: $image_key" >&2
      echo "       fast.sh warmed:  $intent_image" >&2
      echo "       exec_dep wants: $actual_image" >&2
      echo "       必须用同一个 commit/tag 重新运行两步；紧急绕过需显式 PRD_AGENT_IGNORE_FAST_INTENT=1。" >&2
      exit 1
    fi
  }

  check_intent_image_match PRD_AGENT_API_IMAGE "$PRD_AGENT_API_IMAGE"
  check_intent_image_match PRD_AGENT_LLMGW_IMAGE "$PRD_AGENT_LLMGW_IMAGE"
  check_intent_image_match PRD_AGENT_LLMGW_SERVE_IMAGE "$PRD_AGENT_LLMGW_SERVE_IMAGE"
  check_intent_image_match PRD_AGENT_LLMGW_WEB_IMAGE "$PRD_AGENT_LLMGW_WEB_IMAGE"
  check_intent_image_match PRD_AGENT_DESIGN_OPENDESIGN_IMAGE "$PRD_AGENT_DESIGN_OPENDESIGN_IMAGE"

  echo "Release intent: matched fast.sh warmup (tag=$TAG repo=$REPO)"
}

persist_release_image_pins() {
  persist_images="${PRD_AGENT_PERSIST_IMAGE_PINS:-1}"
  if [ "$persist_images" = "0" ] || [ "$persist_images" = "false" ]; then
    echo "Release image pins: env persistence disabled"
    return
  fi

  dotenv_file="${PRD_AGENT_DOTENV_FILE:-.env}"
  dotenv_dir="$(dirname -- "$dotenv_file")"
  if [ ! -d "$dotenv_dir" ]; then
    echo "WARN: release image pins not persisted because env directory is missing: $dotenv_dir" >&2
    return
  fi

  tmp_file="${dotenv_file}.tmp.$$"
  DOTENV_FILE="$dotenv_file" \
  TMP_FILE="$tmp_file" \
  PRD_AGENT_API_IMAGE_VALUE="$PRD_AGENT_API_IMAGE" \
  PRD_AGENT_LLMGW_IMAGE_VALUE="$PRD_AGENT_LLMGW_IMAGE" \
  PRD_AGENT_LLMGW_SERVE_IMAGE_VALUE="$PRD_AGENT_LLMGW_SERVE_IMAGE" \
  PRD_AGENT_LLMGW_WEB_IMAGE_VALUE="$PRD_AGENT_LLMGW_WEB_IMAGE" \
  PRD_AGENT_DESIGN_OPENDESIGN_IMAGE_VALUE="$PRD_AGENT_DESIGN_OPENDESIGN_IMAGE" \
  python3 - <<'PY'
import os
import re
from pathlib import Path

env_path = Path(os.environ["DOTENV_FILE"])
tmp_path = Path(os.environ["TMP_FILE"])
updates = {
    "PRD_AGENT_API_IMAGE": os.environ["PRD_AGENT_API_IMAGE_VALUE"],
    "PRD_AGENT_LLMGW_IMAGE": os.environ["PRD_AGENT_LLMGW_IMAGE_VALUE"],
    "PRD_AGENT_LLMGW_SERVE_IMAGE": os.environ["PRD_AGENT_LLMGW_SERVE_IMAGE_VALUE"],
    "PRD_AGENT_LLMGW_WEB_IMAGE": os.environ["PRD_AGENT_LLMGW_WEB_IMAGE_VALUE"],
    "PRD_AGENT_DESIGN_OPENDESIGN_IMAGE": os.environ["PRD_AGENT_DESIGN_OPENDESIGN_IMAGE_VALUE"],
}

lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
seen = {key: False for key in updates}
out = []
pattern = re.compile(r"^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$")

for line in lines:
    match = pattern.match(line)
    if match and match.group(3) in updates:
        key = match.group(3)
        out.append(f"{match.group(1)}{match.group(2) or ''}{key}={updates[key]}")
        seen[key] = True
    else:
        out.append(line)

if out and out[-1] != "":
    out.append("")
for key, value in updates.items():
    if not seen[key]:
        out.append(f"{key}={value}")

tmp_path.write_text("\n".join(out) + "\n", encoding="utf-8")
PY
  mv "$tmp_file" "$dotenv_file"
  echo "Release image pins: persisted to $dotenv_file"
}

read_dotenv_value() {
  dotenv_key="$1"
  dotenv_file="${PRD_AGENT_DOTENV_FILE:-.env}"
  if [ ! -f "$dotenv_file" ]; then
    return 0
  fi
  awk -v key="$dotenv_key" '
    {
      line=$0
      sub(/\r$/, "", line)
      sub(/^[[:space:]]*export[[:space:]]+/, "", line)
      if (line ~ "^[[:space:]]*" key "[[:space:]]*=") {
        sub("^[[:space:]]*" key "[[:space:]]*=", "", line)
        sub(/^[[:space:]]+/, "", line)
        sub(/[[:space:]]+$/, "", line)
        if ((line ~ /^".*"$/) || (line ~ /^'\''.*'\''$/)) {
          line=substr(line, 2, length(line)-2)
        }
        print line
        exit
      }
    }
  ' "$dotenv_file"
}

config_value() {
  for config_key in "$@"; do
    eval "config_current=\${$config_key:-}"
    if [ -n "$config_current" ]; then
      printf '%s' "$config_current"
      return 0
    fi
    config_current="$(read_dotenv_value "$config_key")"
    if [ -n "$config_current" ]; then
      printf '%s' "$config_current"
      return 0
    fi
  done
  return 0
}

check_fast_release_intent

if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
elif command -v docker >/dev/null 2>&1; then
  COMPOSE="docker compose"
else
  echo "ERROR: 未找到 docker-compose 或 docker 命令" >&2
  exit 1
fi

compose_dotenv_file="${PRD_AGENT_DOTENV_FILE:-.env}"
compose_project_directory="${PRD_AGENT_COMPOSE_PROJECT_DIRECTORY:-}"
compose_run() {
  if [ -n "$compose_project_directory" ]; then
    set -- --project-directory "$compose_project_directory" "$@"
  fi
  if [ -f "$compose_dotenv_file" ]; then
    if [ "$COMPOSE" = "docker-compose" ]; then
      docker-compose --env-file "$compose_dotenv_file" "$@"
    else
      docker compose --env-file "$compose_dotenv_file" "$@"
    fi
    return
  fi

  if [ "$COMPOSE" = "docker-compose" ]; then
    docker-compose "$@"
  else
    docker compose "$@"
  fi
}

# 生产 Compose identity 必须与 release worktree 目录名无关。否则从
# prd_agent_release_<sha> 执行时会创建另一套 project，审计脚本也会找错 Mongo。
compose_project_name="${PRD_AGENT_COMPOSE_PROJECT_NAME:-${COMPOSE_PROJECT_NAME:-prd_agent}}"
if ! printf '%s' "$compose_project_name" | grep -Eq '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$'; then
  echo "ERROR: invalid Compose project name: $compose_project_name" >&2
  exit 1
fi
export COMPOSE_PROJECT_NAME="$compose_project_name"

if [ -z "$(printf '%s' "${PRD_AGENT_PUBLIC_BASE_URL:-}" | xargs || true)" ]; then
  echo "ERROR: PRD_AGENT_PUBLIC_BASE_URL is required for production deployment" >&2
  exit 1
fi
# 同一份部署输入同时驱动公网验收和 LLM Gateway 返回入口，避免两个地址各自漂移。
export LLMGW_MAP_HOME_URL="${LLMGW_MAP_HOME_URL:-$PRD_AGENT_PUBLIC_BASE_URL}"
# .env 里显式配置的回调基址优先（shell 导出的值会盖过 compose 的 --env-file，所以先读出来再兜底）。
DESIGN_ARTIFACT_PUBLIC_BASE_URL="$(config_value DESIGN_ARTIFACT_PUBLIC_BASE_URL)"
export DESIGN_ARTIFACT_PUBLIC_BASE_URL="${DESIGN_ARTIFACT_PUBLIC_BASE_URL:-$PRD_AGENT_PUBLIC_BASE_URL}"
echo "Compose project: $COMPOSE_PROJECT_NAME"

if [ ! -x scripts/llmgw-prod-topology-preflight.sh ]; then
  echo "ERROR: missing executable scripts/llmgw-prod-topology-preflight.sh" >&2
  exit 1
fi
scripts/llmgw-prod-topology-preflight.sh

persist_release_image_pins

# api 与 design-opendesign 之间的内部密钥：没人需要知道它的值。shell 或 .env 里已有就原样使用；
# 都没有时生成一把写进 .env（只追加这一行，不打印值），之后每次发布沿用同一把。
ensure_design_runtime_api_key() {
  key_dotenv_file="${PRD_AGENT_DOTENV_FILE:-.env}"
  if [ -n "${DESIGN_RUNTIME_API_KEY:-}" ] || [ -n "$(read_dotenv_value DESIGN_RUNTIME_API_KEY)" ]; then
    # persist_release_image_pins 每次发布都按进程 umask 重写 .env；密钥在里面就每次都收回只读属主。
    if [ -f "$key_dotenv_file" ] && [ -n "$(read_dotenv_value DESIGN_RUNTIME_API_KEY)" ]; then
      chmod 600 "$key_dotenv_file"
    fi
    echo "Design runtime key: configured"
    return 0
  fi
  key_dotenv_dir="$(dirname -- "$key_dotenv_file")"
  if [ ! -d "$key_dotenv_dir" ]; then
    echo "ERROR: DESIGN_RUNTIME_API_KEY 未配置，且 env 目录不存在，无法自动生成：$key_dotenv_dir" >&2
    exit 1
  fi
  generated_key="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  if [ -z "$generated_key" ]; then
    echo "ERROR: DESIGN_RUNTIME_API_KEY 自动生成失败（python3 secrets 不可用）" >&2
    exit 1
  fi
  if [ ! -f "$key_dotenv_file" ]; then
    (umask 077 && : > "$key_dotenv_file")
  fi
  printf '\nDESIGN_RUNTIME_API_KEY=%s\n' "$generated_key" >> "$key_dotenv_file"
  generated_key=""
  # .env 可能刚由 persist_release_image_pins 按进程 umask（常见 0644）建出；装了密钥就只许属主读写。
  chmod 600 "$key_dotenv_file"
  echo "Design runtime key: generated and saved to $key_dotenv_file (value not printed)"
}
ensure_design_runtime_api_key

if [ ! -f scripts/lib/static-release.sh ]; then
  echo "ERROR: missing scripts/lib/static-release.sh" >&2
  exit 1
fi
# shellcheck source=scripts/lib/static-release.sh
. scripts/lib/static-release.sh
if [ ! -f scripts/lib/gateway-bind-mount.sh ]; then
  echo "ERROR: missing scripts/lib/gateway-bind-mount.sh" >&2
  exit 1
fi
# shellcheck source=scripts/lib/gateway-bind-mount.sh
. scripts/lib/gateway-bind-mount.sh

tmp_dir="$(mktemp -d)"
release_started_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
release_evidence_id="$(date -u '+%Y%m%dT%H%M%SZ')_${TAG}_$$"
release_evidence_dir="${PRD_AGENT_RELEASE_EVIDENCE_DIR:-${HOME:-.}/prd-agent-release-evidence}"
release_evidence_file="$release_evidence_dir/${release_evidence_id}.json"
public_smoke_json="$tmp_dir/public-surface.json"
rollback_smoke_json="$tmp_dir/public-surface-rollback.json"
asset_storage_readiness_json="$tmp_dir/asset-storage-readiness.json"
static_staging_dir=""
static_release_id=""
static_release_target=""
static_rollback_target=""
compose_started=0
gateway_config_synced=0
release_completed=0
release_failure_stage="initialization"
release_rollback_result="not-needed"
asset_url=""
manifest_url=""
zip_path=""
expected=""
artifact_checksum_verified=0
gateway_service="${PRD_AGENT_GATEWAY_SERVICE:-gateway}"
api_service="${PRD_AGENT_API_SERVICE:-api}"
gateway_container_id="$(compose_run ps -q "$gateway_service" 2>/dev/null | head -n 1)"
active_static_root="deploy/web/dist"
active_nginx_conf_root="deploy/nginx/conf.d"
if [ -n "$gateway_container_id" ]; then
  mounted_static_root="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/usr/share/nginx/html"}}{{.Source}}{{end}}{{end}}' "$gateway_container_id" 2>/dev/null || true)"
  mounted_nginx_conf_root="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/etc/nginx/conf.d"}}{{.Source}}{{end}}{{end}}' "$gateway_container_id" 2>/dev/null || true)"
  if [ -n "$mounted_static_root" ]; then
    active_static_root="$mounted_static_root"
  fi
  if [ -n "$mounted_nginx_conf_root" ]; then
    active_nginx_conf_root="$mounted_nginx_conf_root"
  fi
fi
echo "Active gateway mounts: static=$active_static_root nginxConf=$active_nginx_conf_root"
static_before_mode="$(stat -c '%a' "$active_static_root" 2>/dev/null || true)"
static_before_owner="$(stat -c '%u:%g' "$active_static_root" 2>/dev/null || true)"
static_before_current="$(readlink "$active_static_root/current" 2>/dev/null || true)"
static_before_previous="$(readlink "$active_static_root/previous" 2>/dev/null || true)"

write_release_evidence() {
  evidence_status="$1"
  evidence_failure_stage="$2"
  evidence_rollback_result="$3"
  if [ -e "$release_evidence_file" ]; then
    echo "Release evidence already written: $release_evidence_file"
    return 0
  fi
  python3 scripts/prd-agent-release-evidence.py \
    --out "$release_evidence_file" \
    --status "$evidence_status" \
    --release-ref "$TAG" \
    --started-at "$release_started_at" \
    --command-semantics "${release_ref_type}:${TAG}" \
    --release-pid "$$" \
    --asset-url "$asset_url" \
    --asset-file "$zip_path" \
    --expected-sha256 "$expected" \
    --checksum-verified "$artifact_checksum_verified" \
    --manifest-url "$manifest_url" \
    --static-root "$active_static_root/current" \
    --current-link "$active_static_root/current" \
    --previous-link "$active_static_root/previous" \
    --static-before-mode "$static_before_mode" \
    --static-before-owner "$static_before_owner" \
    --static-before-current "$static_before_current" \
    --static-before-previous "$static_before_previous" \
    --smoke-json "$public_smoke_json" \
    --asset-storage-readiness-json "$asset_storage_readiness_json" \
    --gateway-bind-state "$GATEWAY_BIND_STATE" \
    --gateway-bind-reason "$GATEWAY_BIND_REASON" \
    --gateway-bind-initial-state "$GATEWAY_BIND_INITIAL_STATE" \
    --gateway-bind-initial-reason "$GATEWAY_BIND_INITIAL_REASON" \
    --gateway-bind-recreated "$GATEWAY_BIND_RECREATED" \
    --gateway-container-before "$GATEWAY_BIND_CONTAINER_BEFORE" \
    --gateway-container-after "$GATEWAY_BIND_CONTAINER_AFTER" \
    --gateway-host-static-target "$GATEWAY_BIND_HOST_STATIC_TARGET" \
    --gateway-container-static-target "$GATEWAY_BIND_CONTAINER_STATIC_TARGET" \
    --gateway-host-static-sha256 "$GATEWAY_BIND_HOST_STATIC_SHA" \
    --gateway-container-static-sha256 "$GATEWAY_BIND_CONTAINER_STATIC_SHA" \
    --gateway-host-nginx-sha256 "$GATEWAY_BIND_HOST_NGINX_SHA" \
    --gateway-container-nginx-sha256 "$GATEWAY_BIND_CONTAINER_NGINX_SHA" \
    --gateway-bind-initial-host-static-target "$GATEWAY_BIND_INITIAL_HOST_STATIC_TARGET" \
    --gateway-bind-initial-container-static-target "$GATEWAY_BIND_INITIAL_CONTAINER_STATIC_TARGET" \
    --gateway-bind-initial-host-static-sha256 "$GATEWAY_BIND_INITIAL_HOST_STATIC_SHA" \
    --gateway-bind-initial-container-static-sha256 "$GATEWAY_BIND_INITIAL_CONTAINER_STATIC_SHA" \
    --gateway-bind-initial-host-nginx-sha256 "$GATEWAY_BIND_INITIAL_HOST_NGINX_SHA" \
    --gateway-bind-initial-container-nginx-sha256 "$GATEWAY_BIND_INITIAL_CONTAINER_NGINX_SHA" \
    --failure-stage "$evidence_failure_stage" \
    --rollback-result "$evidence_rollback_result"
}

run_public_surface_smoke() {
  smoke_output="$1"
  smoke_attempts="${2:-${PRD_AGENT_PUBLIC_SMOKE_ATTEMPTS:-12}}"
  public_base="$PRD_AGENT_PUBLIC_BASE_URL"
  public_smoke_commit_args=""
  case "$TAG" in
    sha-*) public_smoke_commit_args="--expect-commit ${TAG#sha-}" ;;
  esac
  # shellcheck disable=SC2086
  python3 scripts/prd-agent-public-surface-smoke.py \
    --base "$public_base" \
    --api-health-path "${PRD_AGENT_PUBLIC_API_HEALTH_PATH:-/api/version}" \
    --root-health-path "${PRD_AGENT_PUBLIC_ROOT_HEALTH_PATH:-/health}" \
    --llmgw-page-path "${PRD_AGENT_PUBLIC_LLMGW_PAGE_PATH:-/llmgw/}" \
    --llmgw-console-health-path "${PRD_AGENT_PUBLIC_LLMGW_CONSOLE_HEALTH_PATH:-/llmgw/gw/healthz}" \
    --llmgw-serving-health-path "${PRD_AGENT_PUBLIC_LLMGW_SERVING_HEALTH_PATH:-/llmgw/gw/v1/healthz}" \
    --attempts "$smoke_attempts" \
    --interval "${PRD_AGENT_PUBLIC_SMOKE_INTERVAL_SECONDS:-5}" \
    --timeout "${PRD_AGENT_PUBLIC_SMOKE_TIMEOUT_SECONDS:-15}" \
    --json-out "$smoke_output" \
    $public_smoke_commit_args
}

run_asset_storage_readiness() {
  readiness_url="${PRD_AGENT_ASSET_STORAGE_READINESS_INTERNAL_URL:-http://localhost:8080/health/ready?force=true}"
  readiness_attempts="${PRD_AGENT_ASSET_STORAGE_READINESS_ATTEMPTS:-3}"
  readiness_interval="${PRD_AGENT_ASSET_STORAGE_READINESS_INTERVAL_SECONDS:-10}"
  readiness_timeout="${PRD_AGENT_ASSET_STORAGE_READINESS_TIMEOUT_SECONDS:-25}"
  readiness_attempt=1
  readiness_attempt_json="$tmp_dir/asset-storage-readiness-attempt.json"
  readiness_last_response_json="$tmp_dir/asset-storage-readiness-last-response.json"

  while [ "$readiness_attempt" -le "$readiness_attempts" ]; do
    if compose_run exec -T "$api_service" \
      curl --fail-with-body -sS --max-time "$readiness_timeout" "$readiness_url" \
      > "$readiness_attempt_json"; then
      mv "$readiness_attempt_json" "$asset_storage_readiness_json"
      echo "Asset storage readiness: PASS ($readiness_url)"
      return 0
    fi
    if [ -s "$readiness_attempt_json" ]; then
      mv "$readiness_attempt_json" "$readiness_last_response_json"
    fi
    if [ "$readiness_attempt" -ge "$readiness_attempts" ]; then
      break
    fi
    echo "Asset storage readiness retry $readiness_attempt/$readiness_attempts" >&2
    sleep "$readiness_interval"
    readiness_attempt=$((readiness_attempt + 1))
  done

  if [ -s "$readiness_last_response_json" ]; then
    mv "$readiness_last_response_json" "$asset_storage_readiness_json"
  else
    printf '{"status":"unhealthy","errorCode":"probe_request_failed","attempts":%s}\n' \
      "$readiness_attempts" > "$asset_storage_readiness_json"
  fi
  echo "ERROR: asset storage readiness failed after ${readiness_attempts} attempts: $readiness_url" >&2
  echo "RECOVERY: keep the gateway online, restore Tencent COS/CDN access or the API container, then retry the release gate." >&2
  return 1
}

reload_active_gateway() {
  current_gateway_id="$(compose_run ps -q "$gateway_service" 2>/dev/null | head -n 1)"
  if [ -z "$current_gateway_id" ]; then
    echo "ERROR: active gateway container is missing" >&2
    return 1
  fi
  current_gateway_running="$(docker inspect --format '{{.State.Running}}' "$current_gateway_id" 2>/dev/null || true)"
  if [ "$current_gateway_running" != "true" ]; then
    echo "ERROR: active gateway container is not running" >&2
    return 1
  fi
  docker exec "$current_gateway_id" nginx -t
  docker exec "$current_gateway_id" nginx -s reload
}

release_exit() {
  exit_status=$?
  trap - EXIT
  if [ "$exit_status" -ne 0 ] && [ "$release_completed" != "1" ]; then
    if [ "$STATIC_RELEASE_SWITCH_PERFORMED" = "1" ]; then
      echo "Release failed at stage '$release_failure_stage'; restoring previous static release..." >&2
      if static_release_rollback "$active_static_root" "$static_rollback_target"; then
        release_rollback_result="static-restored"
        if [ "$gateway_config_synced" = "1" ]; then
          if reload_active_gateway; then
            release_rollback_result="static-restored-and-gateway-reloaded"
          else
            release_rollback_result="static-restored-gateway-reload-failed"
          fi
        fi
        if [ "$compose_started" = "1" ] && [ "$release_rollback_result" != "static-restored-gateway-reload-failed" ]; then
          if run_public_surface_smoke "$rollback_smoke_json" 6; then
            public_smoke_json="$rollback_smoke_json"
            release_rollback_result="static-restored-and-public-verified"
          else
            release_rollback_result="static-restored-public-verification-failed"
          fi
        fi
      else
        release_rollback_result="failed"
      fi
    fi
    write_release_evidence failed "$release_failure_stage" "$release_rollback_result" || true
  fi
  if [ -n "$static_staging_dir" ] && [ -d "$static_staging_dir" ]; then
    rm -rf "$static_staging_dir"
  fi
  rm -rf "$tmp_dir"
  exit "$exit_status"
}
trap release_exit EXIT

reuse_static_dist="$(printf '%s' "${PRD_AGENT_REUSE_EXISTING_STATIC_DIST:-0}" | tr 'A-Z' 'a-z' | xargs || true)"
release_failure_stage="static-preflight"
case "$reuse_static_dist" in
  1|true|yes)
    if [ -L "$active_static_root/current" ]; then
      active_static_validation_root="$active_static_root/current"
      static_release_target="$(readlink "$active_static_root/current")"
    else
      active_static_validation_root="$active_static_root"
    fi
    if [ ! -s "$active_static_validation_root/index.html" ]; then
      echo "ERROR: PRD_AGENT_REUSE_EXISTING_STATIC_DIST=1 but the active static index is missing or empty: $active_static_validation_root/index.html" >&2
      echo "RECOVERY: restore a complete verified static artifact before retrying the backend/GW-only deployment." >&2
      exit 1
    fi
    echo "Static dist reuse enabled: keeping $active_static_validation_root"
    ;;
  *)
    sha_url=""

    if [ -n "${DIST_URL:-}" ]; then
      asset_url="$DIST_URL"
      sha_url="${DIST_SHA256_URL:-}"
    else
      pages_base="${PAGES_BASE_URL:-https://get.miduo.org/https://${OWNER}.github.io/${REPO_NAME}}"
      asset_url="${pages_base%/}/prd-admin-dist-${TAG}.zip"
      sha_url="${pages_base%/}/prd-admin-dist-${TAG}.zip.sha256"
      manifest_url="${pages_base%/}/release-manifest-${TAG}.json"
    fi

    if [ -z "$asset_url" ]; then
      echo "ERROR: 未能确定静态站压缩包下载地址。" >&2
      echo "  - 默认从 GitHub Pages 下载 prd-admin-dist-${TAG}.zip（可用 PAGES_BASE_URL 覆盖）" >&2
      echo "  - 或直接设置 DIST_URL=... 指定 zip 地址" >&2
      exit 1
    fi

    if [ -n "$manifest_url" ]; then
      manifest_path="$tmp_dir/release-manifest.json"
      if curl -fL "$manifest_url" -o "$manifest_path" 2>/dev/null; then
        echo "Release manifest: $manifest_url"
        grep -E '"commit"|"ref"|"apiImage"|"llmgwImage"|"llmgwServeImage"|"llmgwWebImage"|"webDist"|"webSha256"' "$manifest_path" || true
      fi
    fi

    zip_path="$tmp_dir/prd-admin-dist.zip"
    release_failure_stage="static-download"
    echo "Downloading: $asset_url"
    curl -fL "$asset_url" -o "$zip_path"

    sha_path="$tmp_dir/prd-admin-dist.zip.sha256"
    artifact_checksum_verified=0
    if [ -n "$SKIP_VERIFY" ]; then
      if [ "$TAG" != "latest" ]; then
        echo "ERROR: immutable release $TAG cannot skip static artifact SHA256 verification" >&2
        exit 1
      fi
      echo "WARN: latest compatibility release skipped sha256 verification" >&2
    else
      expected="$(printf '%s' "${DIST_SHA256:-}" | tr 'A-F' 'a-f' | xargs || true)"
      if [ -z "$expected" ] && [ -n "$sha_url" ]; then
        if curl -fL "$sha_url" -o "$sha_path" 2>/dev/null; then
          expected="$(awk '{print $1}' "$sha_path" | head -n 1 | tr 'A-F' 'a-f')"
        fi
      fi
      if [ -n "$expected" ]; then
        echo "Verifying sha256..."
        if command -v sha256sum >/dev/null 2>&1; then
          actual="$(sha256sum "$zip_path" | awk '{print $1}')"
        elif command -v shasum >/dev/null 2>&1; then
          actual="$(shasum -a 256 "$zip_path" | awk '{print $1}')"
        else
          echo "ERROR: sha256sum or shasum is required for static artifact verification" >&2
          exit 1
        fi
        if [ -n "$expected" ] && [ "$expected" != "$actual" ]; then
          echo "WARN: sha256 不匹配，可能是 CDN 缓存不一致，等待 5 秒后重新下载..."
          sleep 5
          curl -fL -H "Cache-Control: no-cache" "$asset_url" -o "$zip_path"
          if [ -z "${DIST_SHA256:-}" ] && [ -n "$sha_url" ]; then
            curl -fL -H "Cache-Control: no-cache" "$sha_url" -o "$sha_path" 2>/dev/null || true
            expected="$(awk '{print $1}' "$sha_path" | head -n 1 | tr 'A-F' 'a-f')"
          fi
          if command -v sha256sum >/dev/null 2>&1; then
            actual="$(sha256sum "$zip_path" | awk '{print $1}')"
          else
            actual="$(shasum -a 256 "$zip_path" | awk '{print $1}')"
          fi
          if [ -n "$expected" ] && [ "$expected" != "$actual" ]; then
            echo "ERROR: sha256 校验失败（expected=$expected actual=$actual）" >&2
            echo "RECOVERY: wait for CDN propagation or provide the audited DIST_SHA256; immutable releases cannot bypass verification." >&2
            exit 1
          fi
          echo "重试成功，sha256 校验通过"
        fi
        if ! printf '%s' "$expected" | grep -Eq '^[0-9a-f]{64}$'; then
          echo "ERROR: static artifact SHA256 must contain exactly 64 hexadecimal characters" >&2
          exit 1
        fi
        artifact_checksum_verified=1
      fi
      if [ "$TAG" != "latest" ] && [ "$artifact_checksum_verified" != "1" ]; then
        echo "ERROR: immutable release $TAG is missing a verifiable static artifact SHA256" >&2
        echo "RECOVERY: publish the .sha256 asset or set DIST_SHA256/DIST_SHA256_URL." >&2
        exit 1
      fi
    fi

    if [ ! -x scripts/validate-static-dist.sh ]; then
      echo "ERROR: missing executable scripts/validate-static-dist.sh" >&2
      exit 1
    fi
    release_failure_stage="static-offline-validation"
    static_release_id="${TAG}-$(date -u '+%Y%m%dT%H%M%SZ')-$$"
    mkdir -p "$active_static_root"
    static_staging_dir="$active_static_root/.staging-$static_release_id"
    if [ -e "$static_staging_dir" ] || [ -L "$static_staging_dir" ]; then
      echo "ERROR: static staging path already exists: $static_staging_dir" >&2
      exit 1
    fi
    mkdir -p "$static_staging_dir"
    unzip -q "$zip_path" -d "$static_staging_dir"
    scripts/validate-static-dist.sh --normalize "$static_staging_dir"

    echo "Static release staged and verified: $static_staging_dir"
    ;;
esac

if [ ! -x scripts/validate-static-dist.sh ]; then
  echo "ERROR: missing executable scripts/validate-static-dist.sh" >&2
  exit 1
fi
if [ -L "$active_static_root/current" ]; then
  active_static_validation_root="$active_static_root/current"
else
  active_static_validation_root="$active_static_root"
fi
scripts/validate-static-dist.sh --normalize "$active_static_validation_root"

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

sync_active_gateway_nginx_config() {
  source_conf="deploy/nginx/conf.d/branches/_standalone.conf"
  target_conf="$active_nginx_conf_root/branches/_standalone.conf"
  target_default="$active_nginx_conf_root/default.conf"
  config_backup_dir="$tmp_dir/nginx-config-backup"
  mkdir -p "$config_backup_dir" "$(dirname "$target_conf")"

  if [ -e "$target_conf" ] || [ -L "$target_conf" ]; then
    cp -a "$target_conf" "$config_backup_dir/standalone.conf"
  fi
  if [ -e "$target_default" ] || [ -L "$target_default" ]; then
    cp -a "$target_default" "$config_backup_dir/default.conf"
  fi

  if [ "$source_conf" != "$target_conf" ]; then
    target_conf_next="${target_conf}.next.$$"
    cp "$source_conf" "$target_conf_next"
    chmod 644 "$target_conf_next"
    python3 - "$target_conf_next" "$target_conf" <<'PY'
import os
import sys

os.replace(sys.argv[1], sys.argv[2])
PY
  fi
  static_release_atomic_link "$target_default" "branches/_standalone.conf"

  if [ -n "$(compose_run ps -q "$gateway_service" 2>/dev/null | head -n 1)" ]; then
    if ! reload_active_gateway; then
      echo "ERROR: new gateway config failed validation; restoring active config backup" >&2
      if [ -e "$config_backup_dir/standalone.conf" ] || [ -L "$config_backup_dir/standalone.conf" ]; then
        cp "$config_backup_dir/standalone.conf" "${target_conf}.restore.$$"
        python3 - "${target_conf}.restore.$$" "$target_conf" <<'PY'
import os
import sys

os.replace(sys.argv[1], sys.argv[2])
PY
      elif [ "$source_conf" != "$target_conf" ]; then
        rm -f "$target_conf"
      fi
      rm -f "$target_default"
      if [ -e "$config_backup_dir/default.conf" ] || [ -L "$config_backup_dir/default.conf" ]; then
        cp -a "$config_backup_dir/default.conf" "$target_default"
      fi
      reload_active_gateway || true
      return 1
    fi
  fi
  gateway_config_synced=1
}

activate_pending_static_release() {
  if [ -z "$static_staging_dir" ]; then
    return 0
  fi

  release_failure_stage="static-atomic-switch"
  static_activation_file="$tmp_dir/static-activation.txt"
  static_release_activate "$static_staging_dir" "$active_static_root" "$static_release_id" > "$static_activation_file"
  static_staging_dir=""
  static_release_target="$STATIC_RELEASE_TARGET"
  static_rollback_target="$STATIC_RELEASE_ROLLBACK_TARGET"
  if [ -z "$static_release_target" ]; then
    echo "ERROR: static release activation did not return a target" >&2
    return 1
  fi
  echo "Static release activated after service readiness: current=$static_release_target previous=${static_rollback_target:-none}"
}

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

# MAP 只有一条模型调用路径（独立网关 serving），发布前不再有影子样本门禁。
# 发布后必须带 key 探测一次公网网关：地址默认由 PRD_AGENT_PUBLIC_BASE_URL 推出，
# key 默认取 .env 里的 LLMGW_SERVE_KEY，所以不需要额外配置；拿不到 key 就拒绝发布。
prepare_llmgw_post_deploy_verification() {
  LLMGW_POST_DEPLOY_VERIFY_NEEDED=0
  public_serving_base="${PRD_AGENT_PUBLIC_BASE_URL%/}${PRD_AGENT_PUBLIC_LLMGW_SERVING_BASE_PATH:-/llmgw/gw/v1}"
  gate_base="${LLMGW_GATE_BASE:-${GW_BASE:-$public_serving_base}}"
  explicit_gate_key="${LLMGW_GATE_KEY:-${GW_KEY:-}}"
  gate_key="${explicit_gate_key:-$(config_value LLMGW_SERVE_KEY)}"
  if [ -z "$gate_key" ]; then
    echo "ERROR: LLM Gateway post-deploy probe 需要 key：LLMGW_GATE_KEY / GW_KEY / LLMGW_SERVE_KEY 均为空，拒绝发布。" >&2
    exit 1
  fi
  for required_script in scripts/llmgw-serving-probe.py scripts/gw-smoke.py; do
    if [ ! -f "$required_script" ]; then
      echo "ERROR: LLM Gateway post-deploy probe 缺少 $required_script，拒绝发布。" >&2
      exit 1
    fi
  done

  # D 层 smoke 会真的调模型：显式给了探测 key 或业务 smoke key 才默认跑，只有 serve key 时默认跳过。
  if [ -n "$explicit_gate_key" ] || [ -n "${LLMGW_POST_DEPLOY_SERVICE_KEY:-}" ]; then
    LLMGW_POST_DEPLOY_RUN_SMOKE="${LLMGW_GATE_RUN_SMOKE:-1}"
  else
    LLMGW_POST_DEPLOY_RUN_SMOKE="${LLMGW_GATE_RUN_SMOKE:-0}"
  fi
  echo "LLM Gateway post-deploy probe target: $gate_base"

  expect_commit=""
  case "$TAG" in
    sha-*)
      expect_commit="${TAG#sha-}"
      ;;
  esac

  LLMGW_POST_DEPLOY_VERIFY_NEEDED=1
  LLMGW_POST_DEPLOY_GATE_BASE="$gate_base"
  LLMGW_POST_DEPLOY_GATE_KEY="$gate_key"
  LLMGW_POST_DEPLOY_SMOKE_KEY="${LLMGW_POST_DEPLOY_SERVICE_KEY:-$gate_key}"
  LLMGW_POST_DEPLOY_EXPECT_COMMIT="$expect_commit"
}

run_llmgw_post_deploy_verification_if_needed() {
  if [ "${LLMGW_POST_DEPLOY_VERIFY_NEEDED:-0}" != "1" ]; then
    echo "LLM Gateway post-deploy verification: skipped"
    return 0
  fi

  gate_base="${LLMGW_POST_DEPLOY_GATE_BASE:-}"
  gate_key="${LLMGW_POST_DEPLOY_GATE_KEY:-}"
  smoke_key="${LLMGW_POST_DEPLOY_SMOKE_KEY:-$gate_key}"
  protocol_canary_key="${LLMGW_POST_DEPLOY_PROTOCOL_CANARY_KEY:-$smoke_key}"
  expect_commit="${LLMGW_POST_DEPLOY_EXPECT_COMMIT:-}"

  if [ -z "$gate_base" ]; then
    echo "ERROR: LLM Gateway post-deploy verification missing gate base." >&2
    exit 1
  fi
  if [ -z "$gate_key" ]; then
    echo "ERROR: LLM Gateway post-deploy verification missing gate key." >&2
    exit 1
  fi
  if [ -z "$smoke_key" ]; then
    echo "ERROR: LLM Gateway post-deploy verification missing scoped smoke key." >&2
    exit 1
  fi

  # 带 key 的 serving 探测是发布必过项，不提供跳过开关：MAP 的全部模型调用都经这一跳。
  probe_args="--base $gate_base"
  probe_args="$probe_args --samples ${LLMGW_GATE_SERVING_PROBE_SAMPLES:-${LLMGW_GATE_HEALTH_SAMPLES:-3}}"
  probe_args="$probe_args --interval ${LLMGW_GATE_SERVING_PROBE_INTERVAL_SECONDS:-${LLMGW_GATE_HEALTH_INTERVAL_SECONDS:-5}}"
  if [ -n "${LLMGW_SERVING_PROBE_JSON_OUT:-}" ]; then
    probe_args="$probe_args --json-out $LLMGW_SERVING_PROBE_JSON_OUT"
  fi
  if [ -n "${LLMGW_SERVING_PROBE_REPORT_MD:-}" ]; then
    probe_args="$probe_args --report-md $LLMGW_SERVING_PROBE_REPORT_MD"
  fi
  if [ -n "$expect_commit" ]; then
    probe_args="$probe_args --expect-commit $expect_commit"
  fi
  echo "LLM Gateway post-deploy serving probe: required (readyz with key + healthz commit stability + no-key auth)"
  # shellcheck disable=SC2086
  LLMGW_GATE_KEY="$gate_key" python3 scripts/llmgw-serving-probe.py $probe_args

  if [ "${LLMGW_POST_DEPLOY_RUN_SMOKE:-1}" != "0" ]; then
    echo "LLM Gateway post-deploy D-layer smoke: required (healthz/pools/send/stream/client-stream/canary)"
    GW_BASE="$gate_base" GW_KEY="$smoke_key" GW_TIMEOUT="${LLMGW_GATE_SMOKE_TIMEOUT_SECONDS:-120}" GW_EXPECT_COMMIT="$expect_commit" python3 scripts/gw-smoke.py
  else
    echo "LLM Gateway post-deploy D-layer smoke: skipped（只有 serve key 时默认不调模型；要跑请设 LLMGW_POST_DEPLOY_SERVICE_KEY 或 LLMGW_GATE_RUN_SMOKE=1）"
  fi

  protocol_canary_arg=""
  run_protocol_canary="$(printf '%s' "${LLMGW_POST_DEPLOY_RUN_PROTOCOL_CANARY:-0}" | xargs || true)"
  case "$run_protocol_canary" in
    1|true|TRUE|yes|YES|on|ON)
      if [ ! -f "scripts/llmgw-protocol-canary.py" ]; then
        echo "ERROR: LLM Gateway post-deploy protocol canary requested but scripts/llmgw-protocol-canary.py is missing." >&2
        exit 1
      fi
      if [ -z "$expect_commit" ]; then
        echo "ERROR: LLM Gateway post-deploy protocol canary requires immutable --commit/sha tag so --expect-commit can be enforced." >&2
        exit 1
      fi
      if [ -z "$protocol_canary_key" ]; then
        echo "ERROR: LLM Gateway post-deploy protocol canary requires LLMGW_POST_DEPLOY_PROTOCOL_CANARY_KEY or a compatible smoke key." >&2
        exit 1
      fi
      protocol_canary_json="${LLMGW_POST_DEPLOY_PROTOCOL_CANARY_JSON_OUT:-}"
      protocol_canary_md="${LLMGW_POST_DEPLOY_PROTOCOL_CANARY_REPORT_MD:-}"
      protocol_canary_max_runtime_calls="${LLMGW_POST_DEPLOY_PROTOCOL_CANARY_MAX_RUNTIME_CALLS:-${LLMGW_PROTOCOL_CANARY_MAX_RUNTIME_CALLS:-4}}"
      if [ -z "$(printf '%s' "$protocol_canary_json" | xargs || true)" ]; then
        echo "ERROR: LLMGW_POST_DEPLOY_RUN_PROTOCOL_CANARY=1 requires LLMGW_POST_DEPLOY_PROTOCOL_CANARY_JSON_OUT." >&2
        exit 1
      fi
      protocol_canary_json_dir="$(dirname -- "$protocol_canary_json")"
      if [ -n "$protocol_canary_json_dir" ] && [ "$protocol_canary_json_dir" != "." ]; then
        mkdir -p "$protocol_canary_json_dir"
      fi
      if [ -n "$(printf '%s' "$protocol_canary_md" | xargs || true)" ]; then
        protocol_canary_md_dir="$(dirname -- "$protocol_canary_md")"
        if [ -n "$protocol_canary_md_dir" ] && [ "$protocol_canary_md_dir" != "." ]; then
          mkdir -p "$protocol_canary_md_dir"
        fi
      fi
      protocol_canary_report_args=""
      if [ -n "$(printf '%s' "$protocol_canary_md" | xargs || true)" ]; then
        protocol_canary_report_args="--report-md $protocol_canary_md"
      fi
      echo "LLM Gateway post-deploy protocol canary: required before runtime gates"
      # shellcheck disable=SC2086
      GW_KEY="$protocol_canary_key" python3 scripts/llmgw-protocol-canary.py \
        --base "$gate_base" \
        --expect-commit "$expect_commit" \
        --execute \
        --max-runtime-calls "$protocol_canary_max_runtime_calls" \
        --json-out "$protocol_canary_json" \
        $protocol_canary_report_args
      protocol_canary_arg="--protocol-canary-json $protocol_canary_json"
      ;;
    *)
      if [ -n "$(printf '%s' "${LLMGW_POST_DEPLOY_PROTOCOL_CANARY_JSON_OUT:-}" | xargs || true)" ]; then
        echo "LLM Gateway post-deploy protocol canary: disabled; not passing unverified JSON to runtime gates"
      fi
      ;;
  esac
}

if [ -n "${SKIP_API_PULL:-}" ]; then
  echo "Skipping release image pull (SKIP_API_PULL=1)"
else
  echo "Pulling release images:"
  echo "  api: $PRD_AGENT_API_IMAGE"
  echo "  llmgw: $PRD_AGENT_LLMGW_IMAGE"
  echo "  llmgw-serve: $PRD_AGENT_LLMGW_SERVE_IMAGE"
  echo "  llmgw-web: $PRD_AGENT_LLMGW_WEB_IMAGE"
  echo "  design-opendesign: $PRD_AGENT_DESIGN_OPENDESIGN_IMAGE"
  # 这里的一次 compose pull 覆盖六个服务，使用 fast.sh 已校准的整批总预算
  # 420 秒，而不是它的单镜像 180 秒预算。调用方仍可按目标环境显式覆盖，
  # 但不可变发布的失败语义不变。
  pull_timeout_seconds="${API_PULL_TIMEOUT_SECONDS:-420}"
  echo "Release image pull timeout budget: ${pull_timeout_seconds}s"
  if command -v timeout >/dev/null 2>&1; then
    if [ -f "$compose_dotenv_file" ]; then
      pull_command="$COMPOSE --env-file $compose_dotenv_file"
    else
      pull_command="$COMPOSE"
    fi
    if ! timeout "$pull_timeout_seconds" $pull_command pull api llmgw llmgw-serve llmgw-serve-b llmgw-web design-opendesign; then
      if [ "$TAG" = "latest" ]; then
        echo "WARN: release image pull skipped or timed out after ${pull_timeout_seconds}s; continuing with existing local images" >&2
      else
        echo "ERROR: immutable release image pull failed for ${TAG}; refusing to continue with existing local images" >&2
        exit 1
      fi
    fi
  elif ! compose_run pull api llmgw llmgw-serve llmgw-serve-b llmgw-web design-opendesign; then
    if [ "$TAG" = "latest" ]; then
      echo "WARN: release image pull failed; continuing with existing local images" >&2
    else
      echo "ERROR: immutable release image pull failed for ${TAG}; refusing to continue with existing local images" >&2
      exit 1
    fi
  fi
fi

prepare_llmgw_post_deploy_verification

refresh_gateway_after_compose() {
  gateway_service="${PRD_AGENT_GATEWAY_SERVICE:-gateway}"
  if [ -z "$(printf '%s' "$gateway_service" | xargs || true)" ]; then
    echo "Gateway refresh skipped: PRD_AGENT_GATEWAY_SERVICE is empty"
    return 0
  fi

  if compose_run config --services 2>/dev/null | grep -Fxq "$gateway_service"; then
    gateway_container_id="$(compose_run ps -q "$gateway_service" 2>/dev/null | head -n 1)"
    gateway_running=""
    if [ -n "$gateway_container_id" ]; then
      gateway_running="$(docker inspect --format '{{.State.Running}}' "$gateway_container_id" 2>/dev/null || true)"
    fi
    if [ "$gateway_running" = "true" ]; then
      echo "Synchronizing active gateway config and reloading in place without changing its container IP..."
      sync_active_gateway_nginx_config
      gateway_reconcile_bind_mounts \
        "$gateway_container_id" \
        "$active_static_root" \
        "$active_nginx_conf_root" \
        "$compose_project_directory" \
        "$gateway_service"
    else
      echo "Starting gateway service for the first time..."
      compose_run up -d --no-deps "$gateway_service"
      reload_active_gateway
      gateway_config_synced=1
    fi
  else
    echo "Gateway refresh skipped: service '$gateway_service' not found in compose"
  fi
}

compose_services_without_gateway() {
  gateway_service="${PRD_AGENT_GATEWAY_SERVICE:-gateway}"
  compose_run config --services 2>/dev/null | grep -Fvx "$gateway_service" | xargs
}

wait_for_llmgw_serving_readiness() {
  timeout_seconds="${LLMGW_SERVING_READY_TIMEOUT_SECONDS:-180}"
  if ! printf '%s' "$timeout_seconds" | grep -Eq '^[0-9]+$' || [ "$timeout_seconds" -lt 1 ]; then
    echo "ERROR: LLMGW_SERVING_READY_TIMEOUT_SECONDS must be a positive integer" >&2
    exit 1
  fi

  services=""
  for service in llmgw-serve llmgw-serve-b; do
    if compose_run config --services 2>/dev/null | grep -Fxq "$service"; then
      services="$services $service"
    fi
  done
  services="$(printf '%s' "$services" | xargs || true)"
  if [ -z "$services" ]; then
    echo "LLM Gateway serving readiness wait skipped: no serving services in compose"
    return 0
  fi

  echo "Waiting for LLM Gateway serving readiness: services=$services timeout=${timeout_seconds}s"
  deadline=$(( $(date +%s) + timeout_seconds ))
  while :; do
    all_ready=1
    states=""
    for service in $services; do
      container_id="$(compose_run ps -q "$service" 2>/dev/null | head -n 1)"
      if [ -z "$container_id" ]; then
        state="missing"
        all_ready=0
      else
        running="$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || true)"
        health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id" 2>/dev/null || true)"
        state="running=$running,health=$health"
        if [ "$running" != "true" ] || [ "$health" != "healthy" ]; then
          all_ready=0
        fi
        if [ "$health" = "unhealthy" ] || [ "$running" = "false" ]; then
          echo "ERROR: serving service $service cannot become ready ($state)" >&2
          compose_run ps >&2 || true
          exit 1
        fi
      fi
      states="$states $service[$state]"
    done

    if [ "$all_ready" = "1" ]; then
      echo "LLM Gateway serving readiness: PASS$states"
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "ERROR: serving readiness timeout after ${timeout_seconds}s:$states" >&2
      compose_run ps >&2 || true
      exit 1
    fi
    sleep 2
  done
}

# 设计执行服务是本次发布涉及的专项服务：引擎没就绪就不许记成功（生产发布安全规则条目 3）。
# 判据只认 compose 里声明的容器健康检查（匿名 /healthz/ready，引擎健康才 200）。
wait_for_design_runtime_readiness() {
  design_service="design-opendesign"
  if ! compose_run config --services 2>/dev/null | grep -Fxq "$design_service"; then
    echo "Design runtime readiness wait skipped: no $design_service service in compose"
    return 0
  fi
  design_timeout_seconds="${DESIGN_RUNTIME_READY_TIMEOUT_SECONDS:-420}"
  if ! printf '%s' "$design_timeout_seconds" | grep -Eq '^[0-9]+$' || [ "$design_timeout_seconds" -lt 1 ]; then
    echo "ERROR: DESIGN_RUNTIME_READY_TIMEOUT_SECONDS must be a positive integer" >&2
    exit 1
  fi
  echo "Waiting for design runtime readiness: service=$design_service timeout=${design_timeout_seconds}s"
  design_deadline=$(( $(date +%s) + design_timeout_seconds ))
  while :; do
    design_container_id="$(compose_run ps -q "$design_service" 2>/dev/null | head -n 1)"
    design_running=""
    design_health="missing"
    if [ -n "$design_container_id" ]; then
      design_running="$(docker inspect --format '{{.State.Running}}' "$design_container_id" 2>/dev/null || true)"
      design_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$design_container_id" 2>/dev/null || true)"
    fi
    design_state="running=${design_running:-none},health=$design_health"
    if [ "$design_running" = "true" ] && [ "$design_health" = "healthy" ]; then
      echo "Design runtime readiness: PASS $design_service[$design_state]"
      return 0
    fi
    if [ "$design_health" = "unhealthy" ] || [ "$design_running" = "false" ]; then
      echo "ERROR: design runtime $design_service cannot become ready ($design_state); see: docker logs $design_service" >&2
      exit 1
    fi
    if [ "$(date +%s)" -ge "$design_deadline" ]; then
      echo "ERROR: design runtime readiness timeout after ${design_timeout_seconds}s: $design_service[$design_state]" >&2
      exit 1
    fi
    sleep 3
  done
}

if [ "$LLMGW_VERIFY_ONLY" = "1" ]; then
  echo "LLM Gateway verify-only: preserving current containers"
  release_failure_stage="asset-storage-readiness"
  run_asset_storage_readiness
  activate_pending_static_release
else
  release_failure_stage="compose-update"
  echo "Ensuring Docker network exists..."
  docker network inspect prdagent-network >/dev/null 2>&1 || docker network create prdagent-network
  compose_started=1

  release_services="$(compose_services_without_gateway)"
  if [ -z "$release_services" ]; then
    echo "ERROR: no non-gateway compose services found for deployment" >&2
    exit 1
  fi
  echo "Starting non-gateway services while preserving the gateway container IP..."
  # shellcheck disable=SC2086
  compose_run up -d --force-recreate $release_services

  # Refresh existing DNS resolutions immediately after the API container is
  # replaced. This uses the currently active config and static release, so the
  # public gateway does not wait for the longer serving-readiness phase.
  if [ -n "$(compose_run ps -q "$gateway_service" 2>/dev/null | head -n 1)" ]; then
    reload_active_gateway
  fi

  wait_for_llmgw_serving_readiness

  release_failure_stage="design-runtime-readiness"
  wait_for_design_runtime_readiness

  release_failure_stage="asset-storage-readiness"
  run_asset_storage_readiness

  activate_pending_static_release

  refresh_gateway_after_compose

  deploy_receipt_file="$(printf '%s' "${LLMGW_DEPLOY_RECEIPT_FILE:-}" | xargs || true)"
  if [ -n "$deploy_receipt_file" ]; then
    deploy_receipt_dir="$(dirname -- "$deploy_receipt_file")"
    mkdir -p "$deploy_receipt_dir"
    deploy_receipt_tmp="${deploy_receipt_file}.tmp.$$"
    {
      printf 'RELEASE_REF=%s\n' "$TAG"
      printf 'DEPLOYED_AT=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    } > "$deploy_receipt_tmp"
    mv "$deploy_receipt_tmp" "$deploy_receipt_file"
    echo "LLM Gateway deploy receipt written: $deploy_receipt_file"
  fi
fi

release_failure_stage="llmgw-post-deploy-verification"
run_llmgw_post_deploy_verification_if_needed

release_failure_stage="public-product-surface"
run_public_surface_smoke "$public_smoke_json"

release_failure_stage="release-evidence"
write_release_evidence success "" "not-needed"
release_completed=1
echo "Production release completed with public surface evidence: $release_evidence_file"
