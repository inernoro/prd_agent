#!/usr/bin/env bash
# CDS Agent branch-local sidecar 清理脚本
#
# 默认 dry-run，只输出会删除的 BuildProfile 与受影响分支。
# 真正执行需要显式设置:
#   CDS_HOST=https://cds.miduo.org \
#   SMOKE_CDS_AGENT_BRANCH_ISOLATION_APPLY=1 \
#   SMOKE_CDS_AGENT_BRANCH_ISOLATION_CONFIRM_PROFILE_ID=claude-agent-sdk-runtime-v2-prd-agent \
#     bash scripts/repair-cds-agent-branch-isolation.sh
#
# 执行动作:
#   DELETE /api/build-profiles/<sidecarProfileId>
#
# CDS 端 delete build-profile 会同步:
#   - 删除项目 BuildProfile
#   - best-effort stop 对应容器
#   - 删除所有 branch.services[profileId] ghost rows

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CDS_PROJECT_ID="${SMOKE_CDS_PROJECT_ID:-prd-agent}"
APPLY="${SMOKE_CDS_AGENT_BRANCH_ISOLATION_APPLY:-0}"
CONFIRM_PROFILE_ID="${SMOKE_CDS_AGENT_BRANCH_ISOLATION_CONFIRM_PROFILE_ID:-}"
REPORT="${SMOKE_CDS_AGENT_BRANCH_ISOLATION_REPAIR_REPORT:-}"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_EPOCH="$(date +%s)"

fail() {
  printf '❌ %s\n' "$*" >&2
  exit 1
}

ok() {
  printf '✅ %s\n' "$*"
}

write_report() {
  local status="$1"
  local message="$2"
  local deleted_profiles_json="${3:-[]}"
  [[ -n "$REPORT" ]] || return 0
  mkdir -p "$(dirname "$REPORT")"
  jq -n \
    --arg startedAt "$STARTED_AT" \
    --arg finishedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson elapsedSeconds "$(( $(date +%s) - STARTED_EPOCH ))" \
    --arg cdsHost "$cds_base" \
    --arg projectId "$CDS_PROJECT_ID" \
    --arg apply "$APPLY" \
    --arg confirmProfileId "$CONFIRM_PROFILE_ID" \
    --arg status "$status" \
    --arg message "$message" \
    --argjson contaminated "$contaminated" \
    --argjson profileIds "$profile_ids_json" \
    --argjson deletedProfiles "$deleted_profiles_json" \
    '{
      startedAt: $startedAt,
      finishedAt: $finishedAt,
      elapsedSeconds: $elapsedSeconds,
      cdsHost: $cdsHost,
      projectId: $projectId,
      apply: ($apply == "1"),
      confirmProfileId: (if $confirmProfileId == "" then null else $confirmProfileId end),
      status: $status,
      message: $message,
      contaminatedBranchCount: ($contaminated | length),
      contaminatedBranches: $contaminated,
      candidateProfileIds: $profileIds,
      deletedProfileIds: $deletedProfiles,
      applyManifest: {
        safety: "destructive_remote_delete_build_profile",
        method: "DELETE",
        endpoint: (
          if ($profileIds | length) == 1
          then ($cdsHost + "/api/build-profiles/" + $profileIds[0])
          else null
          end
        ),
        requiredEnv: [
          "CDS_HOST",
          "AI_ACCESS_KEY or CDS_PROJECT_KEY",
          "SMOKE_CDS_AGENT_BRANCH_ISOLATION_APPLY=1",
          "SMOKE_CDS_AGENT_BRANCH_ISOLATION_CONFIRM_PROFILE_ID=<unique candidateProfileIds[0]>"
        ],
        preconditions: [
          {
            code: "unique_candidate_profile",
            expected: 1,
            actual: ($profileIds | length),
            passed: (($profileIds | length) == 1)
          },
          {
            code: "confirmation_matches_candidate",
            expected: (
              if ($profileIds | length) == 1 then $profileIds[0] else null end
            ),
            actual: (if $confirmProfileId == "" then null else $confirmProfileId end),
            passed: (($profileIds | length) == 1 and $confirmProfileId == $profileIds[0])
          },
          {
            code: "apply_flag_enabled",
            expected: "1",
            actual: $apply,
            passed: ($apply == "1")
          }
        ],
        expectedPostCheck: "SMOKE_CDS_AGENT_BRANCH_ISOLATION_REMOTE=1 bash scripts/smoke-cds-agent-branch-isolation.sh"
      }
    }' > "$REPORT"
}

if [[ -z "${CDS_HOST:-}" ]]; then
  fail "需要 CDS_HOST"
fi
if [[ ! -f "$ROOT_DIR/.claude/skills/cds/cli/cdscli.py" ]]; then
  fail "缺少 .claude/skills/cds/cli/cdscli.py"
fi
for bin in jq curl; do
  command -v "$bin" >/dev/null 2>&1 || fail "缺少依赖: $bin"
done

cds_base="${CDS_HOST%/}"
if [[ "$cds_base" != http* ]]; then
  cds_base="https://$cds_base"
fi

auth_args=(-H "Accept: application/json" -H "User-Agent: curl/8.5.0")
if [[ -n "${CDS_PROJECT_KEY:-}" ]]; then
  auth_args+=(-H "X-AI-Access-Key: $CDS_PROJECT_KEY")
elif [[ -n "${AI_ACCESS_KEY:-}" ]]; then
  auth_args+=(-H "X-AI-Access-Key: $AI_ACCESS_KEY")
else
  fail "需要 AI_ACCESS_KEY 或 CDS_PROJECT_KEY 才能调用 CDS 删除 API"
fi

printf '==========================================\n'
printf 'CDS Agent branch-local sidecar repair\n'
printf 'Project: %s\n' "$CDS_PROJECT_ID"
printf 'Apply:   %s\n' "$APPLY"
printf '==========================================\n'

branch_json=$(cd "$ROOT_DIR" && CDS_HOST="$CDS_HOST" python3 .claude/skills/cds/cli/cdscli.py branch list --project "$CDS_PROJECT_ID")
contaminated=$(
  printf '%s' "$branch_json" | jq -c '
    [.data.branches[]?
      | {id, branch, services: ((.services // {}) | keys | map(select(test("claude-agent-sdk-runtime|claude-sidecar|sidecar.*runtime"; "i"))))}
      | select((.services | length) > 0)]
  '
)
profile_ids=$(
  printf '%s' "$contaminated" | jq -r '.[].services[]' | sort -u
)
profile_ids_json=$(printf '%s\n' "$profile_ids" | jq -R 'select(length > 0)' | jq -s .)

if [[ -z "$profile_ids" ]]; then
  ok "远程未发现 branch-local sidecar service，无需清理"
  write_report "clean" "远程未发现 branch-local sidecar service，无需清理" "[]"
  exit 0
fi

printf '\n受影响分支:\n'
printf '%s\n' "$contaminated" | jq -r '.[] | "  - " + .id + " (" + .branch + "): " + (.services | join(", "))'
printf '\n候选删除 BuildProfile:\n'
printf '%s\n' "$profile_ids" | sed 's/^/  - /'

if [[ "$APPLY" != "1" ]]; then
  printf '\nDRY-RUN: 未执行删除。设置 SMOKE_CDS_AGENT_BRANCH_ISOLATION_APPLY=1 后再运行。\n'
  write_report "dry_run" "未执行删除；设置 SMOKE_CDS_AGENT_BRANCH_ISOLATION_APPLY=1 后再运行" "[]"
  exit 0
fi

profile_count=$(printf '%s\n' "$profile_ids" | sed '/^$/d' | wc -l | tr -d ' ')
if [[ "$profile_count" != "1" ]]; then
  write_report "confirm_failed" "候选 BuildProfile 数量不是 1，拒绝执行删除；请先人工复核候选列表" "[]"
  fail "候选 BuildProfile 数量不是 1，拒绝执行删除；当前数量=$profile_count"
fi
if [[ -z "$CONFIRM_PROFILE_ID" ]]; then
  write_report "confirm_failed" "缺少 SMOKE_CDS_AGENT_BRANCH_ISOLATION_CONFIRM_PROFILE_ID，拒绝执行删除" "[]"
  fail "缺少 SMOKE_CDS_AGENT_BRANCH_ISOLATION_CONFIRM_PROFILE_ID；必须精确等于候选 BuildProfile id"
fi
if [[ "$CONFIRM_PROFILE_ID" != "$profile_ids" ]]; then
  write_report "confirm_failed" "确认的 BuildProfile id 与候选不匹配，拒绝执行删除" "[]"
  fail "确认的 BuildProfile id 与候选不匹配: confirm=$CONFIRM_PROFILE_ID candidate=$profile_ids"
fi

printf '\n>>> 执行删除\n'
deleted_profiles=()
while IFS= read -r profile_id; do
  [[ -z "$profile_id" ]] && continue
  tmp=$(mktemp)
  code=$(
    curl --max-time 30 --show-error --silent \
      -o "$tmp" \
      -w '%{http_code}' \
      -X DELETE \
      "${auth_args[@]}" \
      "$cds_base/api/build-profiles/$profile_id"
  )
  body=$(cat "$tmp")
  rm -f "$tmp"
  if [[ "$code" != "200" ]]; then
    printf '%s\n' "$body" >&2
    fail "删除 $profile_id 失败: HTTP $code"
  fi
  ok "已删除 BuildProfile $profile_id"
  deleted_profiles+=("$profile_id")
done <<< "$profile_ids"

deleted_profiles_json=$(printf '%s\n' "${deleted_profiles[@]}" | jq -R 'select(length > 0)' | jq -s .)

printf '\n>>> 复查远程分支污染\n'
set +e
SMOKE_CDS_AGENT_BRANCH_ISOLATION_REMOTE=1 \
  CDS_HOST="$CDS_HOST" \
  bash "$ROOT_DIR/scripts/smoke-cds-agent-branch-isolation.sh"
verify_rc=$?
set -e
if (( verify_rc == 0 )); then
  write_report "applied_verified" "已删除候选 BuildProfile 并完成复查" "$deleted_profiles_json"
  exit 0
fi
write_report "applied_verify_failed" "已删除候选 BuildProfile，但复查仍失败；查看脚本输出继续排查" "$deleted_profiles_json"
exit "$verify_rc"
