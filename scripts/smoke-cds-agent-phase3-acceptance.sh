#!/usr/bin/env bash
# RETIRED 2026-07-09（整组退役，见 doc/debt.cds.agent.acceptance-smoke-drift.md）
# 这批手工取证 smoke 用硬编码文案 grep -Fq 断言，文档改写后已链式漂移失效。
# 按台账「修复或退役」一次性决策：退役。未接 CI，保留文件仅作历史取证参考，
# 不再维护、不作为验收依据。如需同类校验请改用结构化锚点重写并接最小 CI。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

require_file() {
  local file="$1"
  local label="$2"
  if [[ ! -s "$file" ]]; then
    echo "FAIL: missing ${label}: ${file}" >&2
    exit 1
  fi
}

require_match() {
  local pattern="$1"
  local file="$2"
  local label="$3"
  if ! rg -q "$pattern" "$file"; then
    echo "FAIL: missing ${label} in ${file}" >&2
    exit 1
  fi
}

REPORT_MD="doc/report.cds.agent.phase3-acceptance.2026-05-19.md"
REPORT_HTML="doc/report.cds-agent-phase3-acceptance-2026-05-19.html"
REPORT_PDF="doc/report.cds-agent-phase3-acceptance-2026-05-19.pdf"
ROADMAP="doc/design.cds.agent.commercial-architecture-and-roadmap.md"

require_file "$REPORT_MD" "Phase 3 acceptance markdown"
require_file "$REPORT_HTML" "Phase 3 acceptance html"
require_file "$REPORT_PDF" "Phase 3 acceptance pdf"

require_match "CDS Agent Phase 3 验收报告" "$REPORT_MD" "Phase 3 report title"
require_match "P3-1.*trace" "$REPORT_MD" "P3-1 evidence"
require_match "P3-2.*adapter" "$REPORT_MD" "P3-2 evidence"
require_match "P3-3.*SLA" "$REPORT_MD" "P3-3 evidence"
require_match "P3-4.*定时巡检" "$REPORT_MD" "P3-4 evidence"
require_match "P3-5a.*权限" "$REPORT_MD" "P3-5a evidence"
require_match "P3-5b.*scoped" "$REPORT_MD" "P3-5b evidence"
require_match "P3-5c.*team-shared" "$REPORT_MD" "P3-5c evidence"
require_match "P3-5d.*owner" "$REPORT_MD" "P3-5d evidence"
require_match "runtime profile 不得回到 global default/resolve" "$REPORT_MD" "profile isolation red line"
require_match "Owner UI 不得触发写入或改变 agent loop" "$REPORT_MD" "owner UI readonly red line"
require_match "scripts/smoke-cds-agent-owner-policy-ui.sh" "$REPORT_MD" "owner policy smoke evidence"
require_match "P3-6 Phase 3 验收包" "$ROADMAP" "roadmap Phase 3 acceptance entry"
require_match "report.cds-agent-phase3-acceptance-2026-05-19.pdf" "$ROADMAP" "roadmap Phase 3 pdf evidence"

echo "PASS: CDS Agent Phase 3 acceptance package static smoke"
