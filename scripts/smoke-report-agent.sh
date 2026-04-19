#!/usr/bin/env bash
# ============================================
# 冒烟测试: Report Agent (周报管理)
# ============================================
#
# 端点黄金路径:
#   POST /api/report-agent/teams                  创建团队
#   GET  /api/report-agent/teams/:id/templates    查模板列表
#   POST /api/report-agent/reports                创建周报
#   GET  /api/report-agent/reports/:id            读取周报
#   (best-effort cleanup) DELETE 对应实体
#
# 只测基础 CRUD; 不触发 LLM 生成正文(那是 prd-agent smoke 的职责)。
# 注意: 创建 team 需要 leaderUserId; 用 SMOKE_USER 值作为临时 leader。
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_STEP_TOTAL=5
smoke_init "Report Agent"

STAMP=$(date +%Y%m%d-%H%M%S)
TEAM_NAME="smoke-team-${STAMP}"

# --- 1. 创建团队 ------------------------------------------------------
smoke_step "创建团队 '$TEAM_NAME'"
# leaderUserId 必须是系统中真实存在的用户。X-AI-Impersonate=$SMOKE_USER
# 假冒的 login 本身就对应一个真实用户,直接复用它最省心;若该用户不
# 存在会返回 400,冒烟自己就会失败退出。
leader_body=$(jq -n \
  --arg name "$TEAM_NAME" \
  --arg leader "$SMOKE_USER" \
  '{name:$name, leaderUserId:$leader, reportVisibility:"all_members"}')
resp=$(smoke_post /api/report-agent/teams "$leader_body")
TEAM_ID=$(smoke_get_data "$resp" .id)
smoke_assert_nonempty "$TEAM_ID" "teamId"
smoke_ok "Team 创建成功: $TEAM_ID"

# --- 2. 查模板列表 ----------------------------------------------------
smoke_step "GET /api/report-agent/teams/:id/templates"
# 新建团队的默认模板应由后端 seed(至少一个)。如果为空,后面创建
# 周报会炸,所以提前验证。
resp=$(smoke_get "/api/report-agent/teams/$TEAM_ID/templates" || true)
template_count=$(printf '%s' "$resp" | jq -r '.data | length' 2>/dev/null || echo "0")
if [[ "${template_count:-0}" -lt 1 ]]; then
  # 无默认模板 —— 手动创建一个最小模板,以便后续 report 创建能过
  smoke_verbose "未发现默认模板,手动创建一个最小模板"
  tpl_body=$(jq -n \
    '{name:"smoke-tpl", sections:[{id:"s1", title:"本周总结", required:false}]}')
  tpl_resp=$(smoke_post "/api/report-agent/teams/$TEAM_ID/templates" "$tpl_body" || true)
  TEMPLATE_ID=$(smoke_get_data "$tpl_resp" .id 2>/dev/null || echo "")
else
  TEMPLATE_ID=$(printf '%s' "$resp" | jq -r '.data[0].id')
fi
smoke_assert_nonempty "$TEMPLATE_ID" "templateId"
smoke_ok "Template 就位: $TEMPLATE_ID"

# --- 3. 创建周报 ------------------------------------------------------
smoke_step "POST /api/report-agent/reports (creationMode=manual)"
report_body=$(jq -n \
  --arg team "$TEAM_ID" \
  --arg tpl "$TEMPLATE_ID" \
  '{teamId:$team, templateId:$tpl, creationMode:"manual"}')
resp=$(smoke_post /api/report-agent/reports "$report_body")
REPORT_ID=$(smoke_get_data "$resp" .id)
smoke_assert_nonempty "$REPORT_ID" "reportId"
smoke_ok "Weekly Report 创建成功: $REPORT_ID"

# --- 4. 读取周报详情 --------------------------------------------------
smoke_step "GET /api/report-agent/reports/:id"
resp=$(smoke_get "/api/report-agent/reports/$REPORT_ID")
status=$(smoke_get_data "$resp" '.status // "?"')
got_team=$(smoke_get_data "$resp" .teamId)
smoke_assert_eq "$got_team" "$TEAM_ID" "report.teamId"
smoke_ok "报告状态=$status, teamId 一致"

# --- 5. 清理 (best-effort) --------------------------------------------
smoke_step "清理测试团队 + 周报"
smoke_delete "/api/report-agent/reports/$REPORT_ID" >/dev/null 2>&1 \
  && smoke_verbose "report $REPORT_ID 已删" \
  || printf '⚠ 删除 report %s 失败 (可能无端点,需人工清理)\n' "$REPORT_ID" >&2
smoke_delete "/api/report-agent/teams/$TEAM_ID" >/dev/null 2>&1 \
  && smoke_verbose "team $TEAM_ID 已删" \
  || printf '⚠ 删除 team %s 失败 (可能无端点,需人工清理)\n' "$TEAM_ID" >&2
smoke_ok "清理完成 (best-effort)"

smoke_done
