#!/usr/bin/env bash
# Verify the CDS Agent R0 progress surfaces agree on the current blocker and
# next action. This is local/read-only; it does not deploy, SSH, or push.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

REFRESH_OUTPUT="${CDS_AGENT_R0_STATUS_REFRESH:-/tmp/cds-agent-r0-status-refresh-current.md}"
PROGRESS_OUTPUT="${CDS_AGENT_R0_PROGRESS_OUTPUT:-/tmp/cds-agent-current-progress-current.md}"
STATUS_DOC="$ROOT_DIR/doc/status.cds-agent-current-progress.md"

# When this check runs inside audit-cds-agent-goal.sh, CDS_AGENT_GOAL_AUDIT_REPORT
# points to the report that is still being generated. The progress board needs a
# completed goal-audit input, so fall back to its default source instead of
# treating the in-progress report path as authoritative.
if [[ -n "${CDS_AGENT_GOAL_AUDIT_REPORT:-}" && ! -f "$CDS_AGENT_GOAL_AUDIT_REPORT" ]]; then
  unset CDS_AGENT_GOAL_AUDIT_REPORT
fi

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_file() {
  local file="$1"
  [[ -f "$file" ]] || fail "missing file: $file"
}

require_text() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if ! grep -Fq "$needle" "$file"; then
    printf 'ERROR: %s missing expected text in %s\n' "$label" "$file" >&2
    printf 'EXPECTED: %s\n' "$needle" >&2
    exit 1
  fi
}

require_absent() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if grep -Fq "$needle" "$file"; then
    printf 'ERROR: %s found forbidden text in %s\n' "$label" "$file" >&2
    printf 'FORBIDDEN: %s\n' "$needle" >&2
    exit 1
  fi
}

"$SCRIPT_DIR/refresh-cds-agent-r0-status.sh" >/dev/null

require_file "$REFRESH_OUTPUT"
require_file "$PROGRESS_OUTPUT"
require_file "$STATUS_DOC"

require_text "$REFRESH_OUTPUT" 'operatorFallbackImageInput: `CDS_AGENT_SIDECAR_IMAGE`' 'refresh fallback image input'
require_text "$REFRESH_OUTPUT" 'nextAction: `continue R0.5 CDS-managed runtime capacity before any fallback env handoff`' 'refresh next action'
require_text "$REFRESH_OUTPUT" 'Continue R0.5 CDS-managed runtime capacity work' 'refresh R0 design next command'
require_text "$REFRESH_OUTPUT" 'operator/debug fallback details, not the product path' 'refresh fallback scope'
require_text "$REFRESH_OUTPUT" 'doc/design.cds-agent-managed-runtime-fact-source.md' 'refresh next command design'

require_text "$PROGRESS_OUTPUT" 'Overall status: blocked_r0' 'progress overall status'
require_text "$PROGRESS_OUTPUT" 'Current blocking gate: R0' 'progress blocking gate'
require_text "$PROGRESS_OUTPUT" 'Continue R0.5 CDS-managed runtime capacity work' 'progress exact next step'
require_text "$PROGRESS_OUTPUT" 'operator/debug fallback details, not the product path' 'progress fallback scope'
require_text "$PROGRESS_OUTPUT" 'doc/design.cds-agent-managed-runtime-fact-source.md' 'progress next command design'
require_text "$PROGRESS_OUTPUT" 'R0 managed runtime capacity: sharedRunning=' 'progress managed runtime capacity'
require_text "$PROGRESS_OUTPUT" 'Operator fallback remote host verdict:' 'progress fallback host label'
require_absent "$PROGRESS_OUTPUT" 'R0 remote host verdict:' 'progress must not promote remote host as R0 product gate'
require_text "$PROGRESS_OUTPUT" '| D1 Runtime architecture correction | done |' 'progress D1 done'
require_text "$PROGRESS_OUTPUT" '| R0.2 CDS-managed runtime fact source | done |' 'progress R0.2 done'
require_text "$PROGRESS_OUTPUT" '| R0.3 CDS-managed official SDK runtime | done_minimal |' 'progress R0.3 done minimal'
require_text "$PROGRESS_OUTPUT" '| R0.4 MAP session transport smoke | done |' 'progress R0.4 done'
require_text "$PROGRESS_OUTPUT" '| R0V Post-check | done_blocked |' 'progress R0V done blocked'
require_text "$PROGRESS_OUTPUT" '| R0.5 CDS-managed runtime capacity | in_progress |' 'progress R0.5 in progress'
require_text "$PROGRESS_OUTPUT" '| R0.2F Operator fallback host path | fallback |' 'progress fallback demotion'

require_text "$STATUS_DOC" 'Claude SDK Agent 是 CDS-managed runtime/container/sandbox' 'status doc managed runtime'
require_text "$STATUS_DOC" '只能作为 CDS operator/debug fallback，不能作为普通用户主路径' 'status doc fallback scope'
require_text "$STATUS_DOC" 'doc/plan.cds-agent-runtime-correction-limited.md' 'status doc correction plan'
require_text "$STATUS_DOC" 'doc/design.cds-agent-managed-runtime-fact-source.md' 'status doc R0 design'

printf 'CDS Agent progress consistency: pass\n'
printf -- '- refresh: %s\n' "$REFRESH_OUTPUT"
printf -- '- progress: %s\n' "$PROGRESS_OUTPUT"
printf -- '- statusDoc: %s\n' "$STATUS_DOC"
