#!/usr/bin/env bash
set -euo pipefail

ROADMAP="doc/design.cds.agent.commercial-architecture-and-roadmap.md"
REPORT_MD="doc/report.cds.agent.p4-1-remote-preflight.2026-05-19.md"
REPORT_HTML="doc/report.cds-agent-p4-1-remote-preflight-2026-05-19.html"
REPORT_PDF="doc/report.cds-agent-p4-1-remote-preflight-2026-05-19.pdf"
PREFLIGHT="scripts/preflight-cds-agent-cds-self-update.sh"
VISUAL="scripts/smoke-cds-agent-workbench-visual.sh"

require_file() {
  local file="$1"
  local label="$2"
  if [[ ! -s "$file" ]]; then
    printf 'FAIL: missing %s: %s\n' "$label" "$file" >&2
    exit 1
  fi
}

require_match() {
  local needle="$1"
  local file="$2"
  local label="$3"
  if ! grep -Fq "$needle" "$file"; then
    printf 'FAIL: missing %s in %s: %s\n' "$label" "$file" "$needle" >&2
    exit 1
  fi
}

require_file "$REPORT_MD" "P4-1 markdown report"
require_file "$REPORT_HTML" "P4-1 html report"
require_file "$REPORT_PDF" "P4-1 pdf report"

require_match "P4-1 远端发布前验收与试用入口" "$ROADMAP" "roadmap P4-1 entry"
require_match "P4-2 远端 R1 provider-switch profile 闭环" "$ROADMAP" "roadmap P4-2 next entry"
require_match "$REPORT_PDF" "$ROADMAP" "roadmap P4-1 pdf evidence"
require_match "远端 preview 当前运行时代码已覆盖 P3-5d" "$ROADMAP" "roadmap no redundant deploy rationale"

require_match "local_head_full" "$PREFLIGHT" "full head comparison"
require_match "skipped_branch_local_alias_guarded" "$PREFLIGHT" "branch-local alias guard skip"
require_match "workbenchSignalGroups" "$VISUAL" "visual signal groups"
require_match "provider/profile guidance" "$VISUAL" "provider guidance visual signal"
require_match "workflow and KB readonly" "$VISUAL" "workflow/kb visual signal"

require_match "runtime-status" "$REPORT_MD" "runtime-status evidence"
require_match "currentBlockingGate=R1" "$REPORT_MD" "R1 blocker"
require_match "不需要为 P4-1 重复远端部署" "$REPORT_MD" "no redundant deploy conclusion"
require_match "/tmp/cds-agent-p4-1-remote-workbench.coverage.json" "$REPORT_MD" "visual coverage evidence"

printf 'PASS: CDS Agent P4-1 remote preflight acceptance package static smoke\n'
