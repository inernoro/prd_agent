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
#   - PRD_AGENT_API_IMAGE：覆盖后端镜像（默认按 REPO + 发布 ref 组装，并优先走 get.miduo.org 镜像代理）
#   - PRD_AGENT_LLMGW_IMAGE：覆盖独立 LLM 网关镜像（默认按 REPO + 发布 ref 组装；compose 已含 llmgw service，随 up 一起拉起）
#   - API_PULL_TIMEOUT_SECONDS：后端镜像拉取超时时间，默认 30 秒
#   - SKIP_API_PULL=1：跳过后端镜像拉取，仅更新静态站点并重建 compose
#   - REPO：覆盖 GitHub 仓库 owner/repo（默认尝试从 git remote 推断；推断失败则回退 inernoro/prd_agent）
#   - DIST_URL：直接指定静态 zip 下载地址（完全跳过 Release/Pages 逻辑）
#   - PAGES_BASE_URL：覆盖 GitHub Pages 根地址（默认优先走 get.miduo.org 代理）
#   - GITHUB_TOKEN：仅当 Release 资产为私有时需要（公开 Pages 下载不需要）
#   - LLMGW_MODE=http：全量切 HTTP 时必须先通过 scripts/llmgw-release-gate.py
#   - LLMGW_HTTP_APP_CALLER_ALLOWLIST：灰度入口列表；非空时这些入口会走 http 权威，也必须先通过 release gate
#   - LLMGW_CANARY_STAGE：灰度阶段，allowlist 非空且非全量 http 时必填；枚举 intent-text/chat/streaming/vision/image/video-asr
#   - LLMGW_SHADOW_FULL_SAMPLE_PERCENT：shadow 模式非流式完整比对采样比例，默认 0
#     非 0 时会强制部署后 serving probe + gw-smoke 校验，但不会要求已有 shadow 样本数
#   - LLMGW_GATE_BASE / GW_BASE：release gate 使用的 serving base URL（形如 https://host/gw/v1）
#   - LLMGW_GATE_KEY / GW_KEY：release gate 使用的 X-Gateway-Key；未设时回退 LLMGW_SERVE_KEY
#   - LLMGW_GATE_MIN_TOTAL：全局 shadow 最小样本数，默认 30
#   - LLMGW_GATE_MIN_PER_APP：每个 appCaller 最小样本数，默认 30
#   - LLMGW_GATE_SHADOW_SINCE_HOURS：http/canary 发布只接受最近 N 小时 shadow 样本，默认 24
#   - LLMGW_GATE_MIN_COVERAGE_HOURS：http/canary 发布要求 shadow 样本覆盖至少 N 小时，默认 24；设 0 可关闭
#   - LLMGW_GATE_HEALTH_SAMPLES：全量 http 前 healthz 连续采样次数，默认 3
#   - LLMGW_GATE_HEALTH_INTERVAL_SECONDS：healthz 连续采样间隔秒数，默认 5
#   - LLMGW_GATE_APP_CALLERS：逗号/分号分隔的 appCallerCode 列表，逐个 gate
#   - LLMGW_GATE_FULL_HTTP_APP_CALLERS：全量 http 未显式设置 LLMGW_GATE_APP_CALLERS 时默认逐个 gate 的核心入口列表
#   - LLMGW_GATE_REQUIRED_KINDS：逗号/分号分隔的 kind[:min] 列表，例如 send:30,stream:30，防 resolve-only 放行
#     全量 LLMGW_MODE=http 时若未显式设置，默认要求 send/stream/raw 各达到 LLMGW_GATE_MIN_PER_APP（默认 30）
#   - LLMGW_GATE_REQUIRED_APP_KINDS：逗号/分号分隔的 appCallerCode:kind:min 列表，例如 report-agent.generate::chat:send:30
#     全量 LLMGW_MODE=http 时若未显式设置，默认要求图片/视频/ASR 等 raw 入口各自达到 raw 样本门槛
#   - LLMGW_GATE_FULL_HTTP_APP_KINDS：全量 http 未显式设置 LLMGW_GATE_REQUIRED_APP_KINDS 时默认逐个 gate 的 appCallerCode:kind:min 列表
#   - LLMGW_GATE_CANARY_KIND_MIN：canary 阶段默认 kind 样本门槛，默认跟随 LLMGW_GATE_MIN_PER_APP
#   - LLMGW_GATE_CANARY_APP_KIND_MIN：canary 阶段 raw app-kind 样本门槛，默认跟随 LLMGW_GATE_CANARY_KIND_MIN
#   - LLMGW_GATE_CANARY_APP_KINDS：canary 阶段自定义 appCallerCode:kind:min 列表
#   - LLMGW_GATE_JSON_OUT：可选，保存 release gate JSON 证据报告（不含密钥）
#   - LLMGW_GATE_REPORT_MD：可选，保存 release gate Markdown 证据报告（不含密钥）
#   - LLMGW_GATE_RUN_SERVING_PROBE：是否在 http/canary 发布时强制运行 llmgw-serving-probe.py，默认 1
#   - LLMGW_GATE_SERVING_PROBE_SAMPLES：serving probe healthz 连续采样次数，默认跟随 LLMGW_GATE_HEALTH_SAMPLES
#   - LLMGW_GATE_SERVING_PROBE_INTERVAL_SECONDS：serving probe 连续采样间隔秒数，默认跟随 LLMGW_GATE_HEALTH_INTERVAL_SECONDS
#   - LLMGW_SERVING_PROBE_JSON_OUT / LLMGW_SERVING_PROBE_REPORT_MD：保存 post-deploy serving probe 证据
#   - LLMGW_GATE_RUN_SMOKE：是否在 http/canary 发布时强制运行 gw-smoke.py，默认 1
#   - LLMGW_GATE_SMOKE_TIMEOUT_SECONDS：gw-smoke.py 单请求超时，默认 120
#   - GW_SMOKE_JSON_OUT / GW_SMOKE_REPORT_MD：保存 post-deploy D 层 smoke 证据
#   - LLMGW_SKIP_RELEASE_GATE=1：仅紧急回滚/人工强制时跳过 http gate（会打印警告）

SKIP_VERIFY="${SKIP_VERIFY:-}"
release_ref="${PRD_AGENT_RELEASE_REF:-}"
release_ref_type="ref"
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
      if [ "$pos_index" -eq 1 ] && [ -z "$release_ref" ]; then
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

if [ "$release_ref_type" = "commit" ] && [ "${PRD_AGENT_ALLOW_IMAGE_OVERRIDE:-0}" != "1" ]; then
  if [ -n "${PRD_AGENT_API_IMAGE:-}${PRD_AGENT_LLMGW_IMAGE:-}${PRD_AGENT_LLMGW_SERVE_IMAGE:-}${PRD_AGENT_LLMGW_WEB_IMAGE:-}" ]; then
    echo "WARN: --commit 发布默认忽略 PRD_AGENT_*_IMAGE 覆盖，确保四个镜像钉到 ${TAG}；如确需覆盖请设置 PRD_AGENT_ALLOW_IMAGE_OVERRIDE=1" >&2
  fi
  export PRD_AGENT_API_IMAGE="$default_api_image"
  export PRD_AGENT_LLMGW_IMAGE="$default_llmgw_image"
  export PRD_AGENT_LLMGW_SERVE_IMAGE="$default_llmgw_serve_image"
  export PRD_AGENT_LLMGW_WEB_IMAGE="$default_llmgw_web_image"
fi

# 默认后端镜像。latest 兼容旧部署；指定 ref 时钉到不可变 tag，避免 latest 竞态。
if [ -z "${PRD_AGENT_API_IMAGE:-}" ]; then
  export PRD_AGENT_API_IMAGE="$default_api_image"
fi

# 默认独立 LLM 网关镜像（控制台 prd-llmgw，自包含 ASP.NET 服务，监听 8090，提供 /gw/healthz、
# /gw/auth/login、/gw/logs）。prd-llmgw 已是独立项目（CI branch-image 构建 prdagent-llmgw 镜像），
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

  echo "Release intent: matched fast.sh warmup (tag=$TAG repo=$REPO)"
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

llmgw_mode_value() {
  value="$(config_value LLMGW_MODE LlmGateway__Mode)"
  if [ -z "$value" ]; then
    value="inproc"
  fi
  printf '%s' "$value"
}

llmgw_allowlist_value() {
  config_value LLMGW_HTTP_APP_CALLER_ALLOWLIST LlmGateway__HttpAppCallerAllowlist
}

llmgw_shadow_sample_value() {
  value="$(config_value LLMGW_SHADOW_FULL_SAMPLE_PERCENT LlmGateway__ShadowFullSamplePercent)"
  if [ -z "$value" ]; then
    value="0"
  fi
  printf '%s' "$value"
}

guard_llmgw_prod_stage_context_if_needed() {
  mode_raw="$(llmgw_mode_value)"
  mode="$(printf '%s' "$mode_raw" | tr 'A-Z' 'a-z' | xargs)"
  allowlist_raw="$(llmgw_allowlist_value)"
  allowlist_compact="$(printf '%s' "$allowlist_raw" | tr ',;\n\r' '    ' | xargs || true)"
  shadow_sample_raw="$(llmgw_shadow_sample_value)"
  shadow_sample_compact="$(printf '%s' "$shadow_sample_raw" | xargs || true)"
  shadow_sample_enabled=0
  if [ "$mode" = "shadow" ]; then
    case "$shadow_sample_compact" in
      ""|0|0.0|0.00|0.000)
        ;;
      *)
        shadow_sample_enabled=1
        ;;
    esac
  fi
  release_gate_required=0
  if [ "$mode" = "http" ] || [ -n "$allowlist_compact" ]; then
    release_gate_required=1
  fi
  if [ "$release_gate_required" != "1" ] && [ "$shadow_sample_enabled" != "1" ]; then
    return 0
  fi

  if [ "${LLMGW_PROD_STAGE_ACTIVE:-}" != "1" ] || [ -z "$(printf '%s' "${LLMGW_PROD_STAGE:-}" | xargs || true)" ]; then
    echo "ERROR: LLM Gateway shadow/canary/http 发布必须通过 scripts/llmgw-prod-stage.sh 执行。" >&2
    echo "       直接运行 exec_dep.sh 会绕过 rollout ledger、生产预检和阶段顺序审计。" >&2
    echo "       示例：scripts/llmgw-prod-stage.sh --stage shadow-start --commit <40位SHA> --execute" >&2
    exit 1
  fi
}

check_fast_release_intent
guard_llmgw_prod_stage_context_if_needed

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
manifest_url=""

if [ -n "${DIST_URL:-}" ]; then
  asset_url="$DIST_URL"
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
echo "Downloading: $asset_url"
curl -fL "$asset_url" -o "$zip_path"

sha_path="$tmp_dir/prd-admin-dist.zip.sha256"

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

run_llmgw_release_gate_if_needed() {
  LLMGW_POST_DEPLOY_VERIFY_NEEDED=0
  LLMGW_POST_DEPLOY_GATE_BASE=""
  LLMGW_POST_DEPLOY_GATE_KEY=""
  LLMGW_POST_DEPLOY_EXPECT_COMMIT=""

  mode_raw="$(llmgw_mode_value)"
  mode="$(printf '%s' "$mode_raw" | tr 'A-Z' 'a-z' | xargs)"
  allowlist_raw="$(llmgw_allowlist_value)"
  allowlist_compact="$(printf '%s' "$allowlist_raw" | tr ',;\n\r' '    ' | xargs || true)"
  shadow_sample_raw="$(llmgw_shadow_sample_value)"
  shadow_sample_compact="$(printf '%s' "$shadow_sample_raw" | xargs || true)"
  shadow_sample_enabled=0
  if [ "$mode" = "shadow" ]; then
    case "$shadow_sample_compact" in
      ""|0|0.0|0.00|0.000)
        ;;
      *)
        shadow_sample_enabled=1
        ;;
    esac
  fi
  release_gate_required=0
  if [ "$mode" = "http" ] || [ -n "$allowlist_compact" ]; then
    release_gate_required=1
  fi
  if [ "$release_gate_required" != "1" ] && [ "$shadow_sample_enabled" != "1" ]; then
    echo "LLM Gateway release gate: skipped (LLMGW_MODE=${mode:-inproc}, allowlist=empty, shadowSample=${shadow_sample_compact:-0})"
    return 0
  fi

  if [ "${LLMGW_PROD_STAGE_ACTIVE:-}" != "1" ] || [ -z "$(printf '%s' "${LLMGW_PROD_STAGE:-}" | xargs || true)" ]; then
    echo "ERROR: LLM Gateway shadow/canary/http 发布必须通过 scripts/llmgw-prod-stage.sh 执行。" >&2
    echo "       直接运行 exec_dep.sh 会绕过 rollout ledger、生产预检和阶段顺序审计。" >&2
    echo "       示例：scripts/llmgw-prod-stage.sh --stage shadow-start --commit <40位SHA> --execute" >&2
    exit 1
  fi

  canary_stage=""
  canary_allowed_app_callers=""
  if [ -n "$allowlist_compact" ] && [ "$mode" != "http" ]; then
    canary_stage="$(printf '%s' "${LLMGW_CANARY_STAGE:-}" | tr 'A-Z' 'a-z' | xargs || true)"
    case "$canary_stage" in
      intent-text)
        canary_allowed_app_callers="report-agent.generate::chat"
        ;;
      chat)
        canary_allowed_app_callers="report-agent.generate::chat prd-agent-desktop.chat.sendmessage::chat open-platform-agent.proxy::chat"
        ;;
      streaming)
        canary_allowed_app_callers="report-agent.generate::chat prd-agent-desktop.chat.sendmessage::chat open-platform-agent.proxy::chat"
        ;;
      vision)
        canary_allowed_app_callers="visual-agent.image.vision::generation"
        ;;
      image)
        canary_allowed_app_callers="visual-agent.image.text2img::generation visual-agent.image.img2img::generation"
        ;;
      video-asr)
        canary_allowed_app_callers="video-agent.videogen::video-gen document-store.subtitle::asr transcript-agent.transcribe::asr"
        ;;
      "")
        echo "ERROR: LLM Gateway canary 发布设置了 LLMGW_HTTP_APP_CALLER_ALLOWLIST，但未设置 LLMGW_CANARY_STAGE。" >&2
        echo "       允许阶段：intent-text/chat/streaming/vision/image/video-asr；必须按低风险到高风险逐段推进。" >&2
        exit 1
        ;;
      *)
        echo "ERROR: LLMGW_CANARY_STAGE=$canary_stage 不合法；允许 intent-text/chat/streaming/vision/image/video-asr。" >&2
        exit 1
        ;;
    esac

    old_ifs="$IFS"
    IFS=',;'
    for app in ${LLMGW_HTTP_APP_CALLER_ALLOWLIST:-}; do
      app_trimmed="$(printf '%s' "$app" | xargs)"
      if [ -n "$app_trimmed" ]; then
        case " $canary_allowed_app_callers " in
          *" $app_trimmed "*)
            ;;
          *)
            echo "ERROR: LLM Gateway canary 阶段 $canary_stage 不允许入口 $app_trimmed。" >&2
            echo "       本阶段允许：$canary_allowed_app_callers" >&2
            exit 1
            ;;
        esac
      fi
    done
    IFS="$old_ifs"
    echo "LLM Gateway canary stage: $canary_stage allowlist=$allowlist_compact"
  fi

  if [ "${LLMGW_SKIP_RELEASE_GATE:-}" = "1" ]; then
    echo "ERROR: LLMGW_SKIP_RELEASE_GATE=1 is not allowed when LLM Gateway release evidence is required." >&2
    echo "       Use scripts/llmgw-rollback-inproc.sh for emergency rollback; do not bypass shadow/canary/http gates." >&2
    exit 1
  fi

  if [ ! -f "scripts/llmgw-release-gate.py" ]; then
    echo "ERROR: LLM Gateway http/canary/shadow sample 发布但缺少 scripts/llmgw-release-gate.py，拒绝发布。" >&2
    exit 1
  fi
  if [ "${LLMGW_GATE_RUN_SMOKE:-1}" != "0" ] && [ ! -f "scripts/gw-smoke.py" ]; then
    echo "ERROR: LLM Gateway http/canary/shadow sample 发布但缺少 scripts/gw-smoke.py，拒绝发布。" >&2
    exit 1
  fi
  if [ "${LLMGW_GATE_RUN_SERVING_PROBE:-1}" != "0" ] && [ ! -f "scripts/llmgw-serving-probe.py" ]; then
    echo "ERROR: LLM Gateway http/canary/shadow sample 发布但缺少 scripts/llmgw-serving-probe.py，拒绝发布。" >&2
    exit 1
  fi

  gate_base="${LLMGW_GATE_BASE:-${GW_BASE:-}}"
  gate_key="${LLMGW_GATE_KEY:-${GW_KEY:-${LLMGW_SERVE_KEY:-}}}"
  if [ -z "$gate_base" ]; then
    echo "ERROR: LLM Gateway http/canary/shadow sample 发布需要提供 LLMGW_GATE_BASE 或 GW_BASE（形如 https://host/gw/v1）以校验 serving 与 shadow 证据。" >&2
    exit 1
  fi
  if [ -z "$gate_key" ]; then
    echo "ERROR: LLM Gateway http/canary/shadow sample 发布需要提供 LLMGW_GATE_KEY/GW_KEY 或 LLMGW_SERVE_KEY 以读取 /gw/v1/shadow-comparisons 并运行 smoke。" >&2
    exit 1
  fi

  expect_commit=""
  case "$TAG" in
    sha-*)
      expect_commit="${TAG#sha-}"
      ;;
  esac

  LLMGW_POST_DEPLOY_VERIFY_NEEDED=1
  LLMGW_POST_DEPLOY_GATE_BASE="$gate_base"
  LLMGW_POST_DEPLOY_GATE_KEY="$gate_key"
  LLMGW_POST_DEPLOY_EXPECT_COMMIT="$expect_commit"

  args="--base $gate_base --min-total ${LLMGW_GATE_MIN_TOTAL:-30} --min-per-app ${LLMGW_GATE_MIN_PER_APP:-30}"
  args="$args --since-hours ${LLMGW_GATE_SHADOW_SINCE_HOURS:-24}"
  gate_min_coverage_hours="${LLMGW_GATE_MIN_COVERAGE_HOURS:-}"
  if [ "$release_gate_required" = "1" ] && [ -z "$(printf '%s' "$gate_min_coverage_hours" | xargs || true)" ]; then
    gate_min_coverage_hours="24"
    echo "LLM Gateway release gate: http/canary 未设置 LLMGW_GATE_MIN_COVERAGE_HOURS，默认要求 shadow 证据覆盖 24 小时"
  fi
  if [ -n "$(printf '%s' "$gate_min_coverage_hours" | xargs || true)" ]; then
    args="$args --min-coverage-hours $gate_min_coverage_hours"
  fi
  args="$args --health-samples ${LLMGW_GATE_HEALTH_SAMPLES:-3} --health-interval ${LLMGW_GATE_HEALTH_INTERVAL_SECONDS:-5}"
  if [ -n "${LLMGW_GATE_JSON_OUT:-}" ]; then
    args="$args --json-out $LLMGW_GATE_JSON_OUT"
  fi
  if [ -n "${LLMGW_GATE_REPORT_MD:-}" ]; then
    args="$args --report-md $LLMGW_GATE_REPORT_MD"
  fi
  if [ -n "$expect_commit" ]; then
    args="$args --shadow-release-commit $expect_commit"
  fi

  old_ifs="$IFS"
  IFS=',;'
  gate_app_callers_raw="${LLMGW_GATE_APP_CALLERS:-}"
  gate_app_callers_compact="$(printf '%s' "$gate_app_callers_raw" | tr ',;\n\r' '    ' | xargs || true)"
  if [ "$mode" = "http" ] && [ -z "$gate_app_callers_compact" ]; then
    gate_app_callers_raw="${LLMGW_GATE_FULL_HTTP_APP_CALLERS:-report-agent.generate::chat,prd-agent-desktop.chat.sendmessage::chat,open-platform-agent.proxy::chat,prd-agent-web.model-lab.run::chat,prd-agent.arena.battle::chat,visual-agent.image.text2img::generation,visual-agent.image.img2img::generation,visual-agent.image.vision::generation,video-agent.videogen::video-gen,document-store.subtitle::asr,transcript-agent.transcribe::asr}"
    echo "LLM Gateway release gate: LLMGW_MODE=http 未设置 LLMGW_GATE_APP_CALLERS，默认要求核心入口逐个达标"
  fi
  for app in ${LLMGW_HTTP_APP_CALLER_ALLOWLIST:-}; do
    app_trimmed="$(printf '%s' "$app" | xargs)"
    if [ -n "$app_trimmed" ]; then
      args="$args --app-caller $app_trimmed"
    fi
  done
  for app in ${gate_app_callers_raw}; do
    app_trimmed="$(printf '%s' "$app" | xargs)"
    if [ -n "$app_trimmed" ]; then
      args="$args --app-caller $app_trimmed"
    fi
  done
  IFS="$old_ifs"

  old_ifs="$IFS"
  IFS=',;'
  required_kinds_raw="${LLMGW_GATE_REQUIRED_KINDS:-}"
  required_kinds_compact="$(printf '%s' "$required_kinds_raw" | tr ',;\n\r' '    ' | xargs || true)"
  if [ "$mode" = "http" ] && [ -z "$required_kinds_compact" ]; then
    full_http_kind_min="${LLMGW_GATE_FULL_HTTP_KIND_MIN:-${LLMGW_GATE_MIN_PER_APP:-30}}"
    required_kinds_raw="send:${full_http_kind_min},stream:${full_http_kind_min},raw:${full_http_kind_min}"
    echo "LLM Gateway release gate: LLMGW_MODE=http 未设置 LLMGW_GATE_REQUIRED_KINDS，默认要求 $required_kinds_raw"
  elif [ -n "$canary_stage" ] && [ -z "$required_kinds_compact" ]; then
    canary_kind_min="${LLMGW_GATE_CANARY_KIND_MIN:-${LLMGW_GATE_MIN_PER_APP:-30}}"
    case "$canary_stage" in
      intent-text|chat)
        required_kinds_raw="send:${canary_kind_min}"
        ;;
      streaming)
        required_kinds_raw="stream:${canary_kind_min}"
        ;;
      vision|image|video-asr)
        required_kinds_raw="raw:${canary_kind_min}"
        ;;
    esac
    echo "LLM Gateway release gate: canary 阶段 $canary_stage 未设置 LLMGW_GATE_REQUIRED_KINDS，默认要求 $required_kinds_raw"
  fi
  for kind_req in ${required_kinds_raw}; do
    kind_req_trimmed="$(printf '%s' "$kind_req" | xargs)"
    if [ -n "$kind_req_trimmed" ]; then
      args="$args --require-kind $kind_req_trimmed"
    fi
  done
  required_app_kinds_raw="${LLMGW_GATE_REQUIRED_APP_KINDS:-}"
  required_app_kinds_compact="$(printf '%s' "$required_app_kinds_raw" | tr ',;\n\r' '    ' | xargs || true)"
  if [ "$mode" = "http" ] && [ -z "$required_app_kinds_compact" ]; then
    full_http_app_kind_min="${LLMGW_GATE_FULL_HTTP_APP_KIND_MIN:-${LLMGW_GATE_FULL_HTTP_KIND_MIN:-${LLMGW_GATE_MIN_PER_APP:-30}}}"
    required_app_kinds_raw="${LLMGW_GATE_FULL_HTTP_APP_KINDS:-visual-agent.image.text2img::generation:raw:${full_http_app_kind_min},visual-agent.image.img2img::generation:raw:${full_http_app_kind_min},visual-agent.image.vision::generation:raw:${full_http_app_kind_min},video-agent.videogen::video-gen:raw:${full_http_app_kind_min},document-store.subtitle::asr:raw:${full_http_app_kind_min},transcript-agent.transcribe::asr:raw:${full_http_app_kind_min}}"
    echo "LLM Gateway release gate: LLMGW_MODE=http 未设置 LLMGW_GATE_REQUIRED_APP_KINDS，默认要求 raw 入口逐个具备 raw 样本"
  elif [ -n "$canary_stage" ] && [ -z "$required_app_kinds_compact" ]; then
    canary_app_kind_min="${LLMGW_GATE_CANARY_APP_KIND_MIN:-${LLMGW_GATE_CANARY_KIND_MIN:-${LLMGW_GATE_MIN_PER_APP:-30}}}"
    case "$canary_stage" in
      vision)
        required_app_kinds_raw="${LLMGW_GATE_CANARY_APP_KINDS:-visual-agent.image.vision::generation:raw:${canary_app_kind_min}}"
        ;;
      image)
        required_app_kinds_raw="${LLMGW_GATE_CANARY_APP_KINDS:-visual-agent.image.text2img::generation:raw:${canary_app_kind_min},visual-agent.image.img2img::generation:raw:${canary_app_kind_min}}"
        ;;
      video-asr)
        required_app_kinds_raw="${LLMGW_GATE_CANARY_APP_KINDS:-video-agent.videogen::video-gen:raw:${canary_app_kind_min},document-store.subtitle::asr:raw:${canary_app_kind_min},transcript-agent.transcribe::asr:raw:${canary_app_kind_min}}"
        ;;
    esac
    if [ -n "$required_app_kinds_raw" ]; then
      echo "LLM Gateway release gate: canary 阶段 $canary_stage 默认要求 raw app-kind 样本逐个达标"
    fi
  fi
  for app_kind_req in ${required_app_kinds_raw}; do
    app_kind_req_trimmed="$(printf '%s' "$app_kind_req" | xargs)"
    if [ -n "$app_kind_req_trimmed" ]; then
      args="$args --require-app-kind $app_kind_req_trimmed"
    fi
  done
  IFS="$old_ifs"

  if [ "$release_gate_required" = "1" ]; then
    echo "LLM Gateway release gate: required before deploy (same-commit shadow evidence only; commit probe runs after compose up)"
    # shellcheck disable=SC2086
    GW_KEY="$gate_key" python3 scripts/llmgw-release-gate.py $args
  else
    echo "LLM Gateway release gate: skipped shadow sample startup (LLMGW_MODE=${mode:-inproc}, shadowSample=${shadow_sample_compact:-0}); serving/smoke verification runs after compose up"
  fi
}

run_llmgw_post_deploy_verification_if_needed() {
  if [ "${LLMGW_POST_DEPLOY_VERIFY_NEEDED:-0}" != "1" ]; then
    echo "LLM Gateway post-deploy verification: skipped"
    return 0
  fi

  gate_base="${LLMGW_POST_DEPLOY_GATE_BASE:-}"
  gate_key="${LLMGW_POST_DEPLOY_GATE_KEY:-}"
  expect_commit="${LLMGW_POST_DEPLOY_EXPECT_COMMIT:-}"

  if [ -z "$gate_base" ]; then
    echo "ERROR: LLM Gateway post-deploy verification missing gate base." >&2
    exit 1
  fi
  if [ -z "$gate_key" ]; then
    echo "ERROR: LLM Gateway post-deploy verification missing gate key." >&2
    exit 1
  fi

  if [ "${LLMGW_GATE_RUN_SERVING_PROBE:-1}" != "0" ]; then
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
    echo "LLM Gateway post-deploy serving probe: required (healthz commit stability + no-key auth)"
    # shellcheck disable=SC2086
    python3 scripts/llmgw-serving-probe.py $probe_args
  else
    echo "WARN: LLM Gateway post-deploy serving probe skipped because LLMGW_GATE_RUN_SERVING_PROBE=0" >&2
  fi

  if [ "${LLMGW_GATE_RUN_SMOKE:-1}" != "0" ]; then
    echo "LLM Gateway post-deploy D-layer smoke: required (healthz/pools/send/stream/client-stream/canary)"
    GW_BASE="$gate_base" GW_KEY="$gate_key" GW_TIMEOUT="${LLMGW_GATE_SMOKE_TIMEOUT_SECONDS:-120}" GW_EXPECT_COMMIT="$expect_commit" python3 scripts/gw-smoke.py
  else
    echo "WARN: LLM Gateway post-deploy D-layer smoke skipped because LLMGW_GATE_RUN_SMOKE=0" >&2
  fi
}

if [ -n "${SKIP_API_PULL:-}" ]; then
  echo "Skipping release image pull (SKIP_API_PULL=1)"
else
  echo "Pulling release images:"
  echo "  api: $PRD_AGENT_API_IMAGE"
  echo "  llmgw: $PRD_AGENT_LLMGW_IMAGE"
  echo "  llmgw-serve: $PRD_AGENT_LLMGW_SERVE_IMAGE"
  echo "  llmgw-web: $PRD_AGENT_LLMGW_WEB_IMAGE"
  pull_timeout_seconds="${API_PULL_TIMEOUT_SECONDS:-30}"
  if command -v timeout >/dev/null 2>&1; then
    if ! timeout "$pull_timeout_seconds" $COMPOSE pull api llmgw llmgw-serve llmgw-web; then
      if [ "$TAG" = "latest" ]; then
        echo "WARN: release image pull skipped or timed out after ${pull_timeout_seconds}s; continuing with existing local images" >&2
      else
        echo "ERROR: immutable release image pull failed for ${TAG}; refusing to continue with existing local images" >&2
        exit 1
      fi
    fi
  elif ! $COMPOSE pull api llmgw llmgw-serve llmgw-web; then
    if [ "$TAG" = "latest" ]; then
      echo "WARN: release image pull failed; continuing with existing local images" >&2
    else
      echo "ERROR: immutable release image pull failed for ${TAG}; refusing to continue with existing local images" >&2
      exit 1
    fi
  fi
fi

run_llmgw_release_gate_if_needed

refresh_gateway_after_compose() {
  gateway_service="${PRD_AGENT_GATEWAY_SERVICE:-gateway}"
  if [ -z "$(printf '%s' "$gateway_service" | xargs || true)" ]; then
    echo "Gateway refresh skipped: PRD_AGENT_GATEWAY_SERVICE is empty"
    return 0
  fi

  if $COMPOSE config --services 2>/dev/null | grep -Fxq "$gateway_service"; then
    echo "Refreshing gateway service to pick up recreated upstream container IPs..."
    $COMPOSE up -d --no-deps --force-recreate "$gateway_service"
  else
    echo "Gateway refresh skipped: service '$gateway_service' not found in compose"
  fi
}

echo "Ensuring Docker network exists..."
docker network inspect prdagent-network >/dev/null 2>&1 || docker network create prdagent-network

echo "Starting compose (force recreate to ensure new image is used)..."
$COMPOSE up -d --force-recreate

refresh_gateway_after_compose

run_llmgw_post_deploy_verification_if_needed
