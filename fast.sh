#!/usr/bin/env sh
set -eu

# Best-effort warmup for production deploys. The real deploy is done by
# exec_dep.sh, so this script must not block a frontend-only release forever.
# When both scripts are used, this script writes a release intent file and
# exec_dep.sh refuses to deploy a different ref. This keeps api / llmgw /
# llmgw-serve / llmgw-web on the same immutable commit during GW cutover.
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

while [ "$#" -gt 0 ]; do
  case "$1" in
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
    --skip-verify)
      ;;
    --*)
      echo "ERROR: 未识别参数：$1" >&2
      exit 1
      ;;
    *)
      echo "ERROR: 多余参数：$1" >&2
      exit 1
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

tag="$(normalize_ref "$release_ref" "$release_ref_type")"
repo="${REPO:-inernoro/prd_agent}"
default_api_image="get.miduo.org/ghcr.io/${repo}/prdagent-server:${tag}"
default_llmgw_image="get.miduo.org/ghcr.io/${repo}/prdagent-llmgw:${tag}"
default_llmgw_serve_image="get.miduo.org/ghcr.io/${repo}/prdagent-llmgw-serve:${tag}"
default_llmgw_web_image="get.miduo.org/ghcr.io/${repo}/prdagent-llmgw-web:${tag}"

if [ "$release_ref_type" = "commit" ] && [ "${PRD_AGENT_ALLOW_IMAGE_OVERRIDE:-0}" != "1" ]; then
  if [ -n "${PRD_AGENT_API_IMAGE:-}${PRD_AGENT_LLMGW_IMAGE:-}${PRD_AGENT_LLMGW_SERVE_IMAGE:-}${PRD_AGENT_LLMGW_WEB_IMAGE:-}" ]; then
    echo "WARN: --commit 发布默认忽略 PRD_AGENT_*_IMAGE 覆盖，确保四个镜像钉到 ${tag}；如确需覆盖请设置 PRD_AGENT_ALLOW_IMAGE_OVERRIDE=1" >&2
  fi
  api_image="$default_api_image"
  llmgw_image="$default_llmgw_image"
  llmgw_serve_image="$default_llmgw_serve_image"
  llmgw_web_image="$default_llmgw_web_image"
else
  api_image="${PRD_AGENT_API_IMAGE:-$default_api_image}"
  llmgw_image="${PRD_AGENT_LLMGW_IMAGE:-$default_llmgw_image}"
  llmgw_serve_image="${PRD_AGENT_LLMGW_SERVE_IMAGE:-$default_llmgw_serve_image}"
  llmgw_web_image="${PRD_AGENT_LLMGW_WEB_IMAGE:-$default_llmgw_web_image}"
fi
# 单张镜像的预热超时。30s 是拍出来的，api 镜像每次都拉不完就被掐断，于是每次发布
# 都稳定产出一串 "context canceled" —— 这些 warn 级噪音会挤占 CDS buildFailure 那个
# 「只取最后 10 条 warn/error」的窗口，把真正的失败原因顶出摘要。
# 180s 的依据：api 镜像约数百 MB，按生产机常见的 5-10 MB/s 出口带宽算，冷拉一张需要
# 60-120s，180s 留一倍余量；仍拉不完就是网络确实有问题，该走下面的 WARN 跳过。
timeout_seconds="${FAST_PULL_TIMEOUT_SECONDS:-180}"
# 全部镜像预热的**总**预算。单张放宽到 180s 之后必须有这道闸：整条
# scripts/llmgw-prod-stage.sh 是一条 SSH 命令，共享 CDS 侧 30 分钟的执行超时，
# 后面还有 exec_dep.sh 的权威 pull + 构建 + post-deploy 门禁。没有总闸的话，
# 谁再把单张调大一点，「预热超时」就会变成更难查的 release.exec.timeout。
total_timeout_seconds="${FAST_PULL_TOTAL_TIMEOUT_SECONDS:-420}"
warm_started_at="$(date +%s)"
release_intent_file="${PRD_AGENT_RELEASE_INTENT_FILE:-.prd-agent-release-intent.env}"

warm_image() {
  name="$1"
  image="$2"

  elapsed=$(( $(date +%s) - warm_started_at ))
  if [ "$elapsed" -ge "$total_timeout_seconds" ]; then
    echo "WARN: ${name} image warmup skipped (total warmup budget ${total_timeout_seconds}s exhausted); exec_dep.sh will enforce release pull" >&2
    return 0
  fi

  # 单张的超时必须被**剩余**总预算夹住，否则总闸是假的：
  # 默认 4 张 x 180s 在 420s 的总预算下，前两张各卡满就已经 360s，
  # 第三张仍按整 180s 起跑 → 实际 540s，比广告的 420s 多出四分之一，
  # 而这段时间是从发布 SSH 窗口里借的（Codex review P2，2026-07-29）。
  # 同理 FAST_PULL_TIMEOUT_SECONDS 被调得比总预算还大时，第一张就该被夹住。
  remaining=$(( total_timeout_seconds - elapsed ))
  pull_timeout="$timeout_seconds"
  if [ "$remaining" -lt "$pull_timeout" ]; then
    pull_timeout="$remaining"
  fi

  echo "Warming ${name} image: $image (timeout ${pull_timeout}s, remaining budget ${remaining}s)"
  # stdout（层进度）继续直连：它是 info 级的，既给人等待反馈又不污染 warn 窗口。
  # stderr 收进临时文件，失败时只压成一行 WARN —— 掐掉噪音靠的是这里，
  # 不是靠「不再超时」（超时仍可能发生，但 warn 行数从几十行降到 1 行）。
  pull_err="$(mktemp)"
  if command -v timeout >/dev/null 2>&1; then
    if timeout "$pull_timeout" docker pull "$image" 2>"$pull_err"; then
      rm -f "$pull_err"
      echo "${name} image warmup completed"
    else
      echo "WARN: ${name} image warmup skipped or timed out after ${pull_timeout}s (last: $(tail -n 3 "$pull_err" | tr '\n' ' ')); exec_dep.sh will enforce release pull" >&2
      rm -f "$pull_err"
    fi
  else
    if docker pull "$image" 2>"$pull_err"; then
      rm -f "$pull_err"
      echo "${name} image warmup completed"
    else
      echo "WARN: ${name} image warmup failed (last: $(tail -n 3 "$pull_err" | tr '\n' ' ')); exec_dep.sh will enforce release pull" >&2
      rm -f "$pull_err"
    fi
  fi
}

warm_image "api" "$api_image"
warm_image "llmgw" "$llmgw_image"
warm_image "llmgw-serve" "$llmgw_serve_image"
warm_image "llmgw-web" "$llmgw_web_image"

write_release_intent() {
  if [ -z "$release_intent_file" ]; then
    return 0
  fi

  intent_dir="$(dirname "$release_intent_file")"
  if [ "$intent_dir" != "." ]; then
    mkdir -p "$intent_dir"
  fi

  tmp_intent="${release_intent_file}.tmp.$$"
  {
    printf 'RELEASE_TAG=%s\n' "$tag"
    printf 'RELEASE_REF_TYPE=%s\n' "$release_ref_type"
    printf 'RELEASE_REF=%s\n' "$release_ref"
    printf 'REPO=%s\n' "$repo"
    printf 'PRD_AGENT_API_IMAGE=%s\n' "$api_image"
    printf 'PRD_AGENT_LLMGW_IMAGE=%s\n' "$llmgw_image"
    printf 'PRD_AGENT_LLMGW_SERVE_IMAGE=%s\n' "$llmgw_serve_image"
    printf 'PRD_AGENT_LLMGW_WEB_IMAGE=%s\n' "$llmgw_web_image"
    printf 'WRITTEN_AT_UTC=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date '+%Y-%m-%dT%H:%M:%SZ')"
  } > "$tmp_intent"
  mv "$tmp_intent" "$release_intent_file"
  echo "Release intent written: $release_intent_file (tag=$tag repo=$repo)"
}

write_release_intent
