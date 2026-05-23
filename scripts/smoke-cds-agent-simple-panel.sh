#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PAGE="$ROOT_DIR/prd-admin/src/pages/cds-agent/CdsAgentPage.tsx"

require_text() {
  local needle="$1"
  local label="$2"
  if ! grep -Fq "$needle" "$PAGE"; then
    printf '❌ missing %s: %s\n' "$label" "$needle" >&2
    exit 1
  fi
  printf '✅ %s\n' "$label"
}

printf '==========================================\n'
printf '冒烟测试: CDS Agent 简洁面板\n'
printf '目标:     %s\n' "$PAGE"
printf '==========================================\n'

require_text '1. 目标' '3-step target section'
require_text '2. 任务' '3-step task section'
require_text '3. 运行' '3-step run section'
require_text '运行只读巡检' 'single run action'
require_text 'runSimpleReadonlyReview' 'create/start/send one-click handler'
require_text 'traceId' 'trace field'
require_text 'timeoutAt' 'timeout field'
require_text 'lastEventSeq' 'last event seq field'
require_text 'Stop' 'stop state field'
require_text '产物入口' 'artifact entry field'
require_text 'formatDuration' 'elapsed duration formatter'
require_text "toolPolicy: 'readonly-auto'" 'simple mode readonly tool policy'

printf '\nCDS Agent 简洁面板冒烟通过。\n'
