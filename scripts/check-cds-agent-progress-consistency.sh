#!/usr/bin/env bash
# Verify the CDS Agent R0 progress surfaces agree on the current blocker and
# next action. This is local/read-only; it does not deploy, SSH, or push.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

REFRESH_OUTPUT="${CDS_AGENT_R0_STATUS_REFRESH:-/tmp/cds-agent-r0-status-refresh-current.md}"
PROGRESS_OUTPUT="${CDS_AGENT_R0_PROGRESS_OUTPUT:-/tmp/cds-agent-current-progress-current.md}"
STATUS_DOC="$ROOT_DIR/doc/status.cds-agent-current-progress.md"

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

"$SCRIPT_DIR/refresh-cds-agent-r0-status.sh" >/dev/null

require_file "$REFRESH_OUTPUT"
require_file "$PROGRESS_OUTPUT"
require_file "$STATUS_DOC"

require_text "$REFRESH_OUTPUT" 'requiredImageInput: `CDS_AGENT_SIDECAR_IMAGE`' 'refresh required image input'
require_text "$REFRESH_OUTPUT" 'nextAction: `provide missing env before apply`' 'refresh next action'
require_text "$REFRESH_OUTPUT" 'CDS_AGENT_SIDECAR_IMAGE=<pullable-registry-image>' 'refresh next command image'
require_text "$REFRESH_OUTPUT" 'CDS_REMOTE_HOST_HOST=<host-or-ip-no-protocol>' 'refresh next command host'

require_text "$PROGRESS_OUTPUT" 'Overall status: blocked_r0' 'progress overall status'
require_text "$PROGRESS_OUTPUT" 'Current blocking gate: R0' 'progress blocking gate'
require_text "$PROGRESS_OUTPUT" 'Provide the two R0 external inputs first.' 'progress exact next step'
require_text "$PROGRESS_OUTPUT" 'GHCR is only an optional candidate path.' 'progress GHCR scope'
require_text "$PROGRESS_OUTPUT" 'CDS_AGENT_SIDECAR_IMAGE=<pullable-registry-image>' 'progress next command image'

require_text "$STATUS_DOC" '当前不能按这个倒计时执行，因为 R0 仍缺外部输入' 'status doc R0 blocker'
require_text "$STATUS_DOC" 'GHCR 只是当前仓库场景下自动推导的候选发布路径，不是架构目标' 'status doc GHCR scope'
require_text "$STATUS_DOC" '当前指向补齐 `CDS_AGENT_SIDECAR_IMAGE` 和 remote host 参数' 'status doc exact next step'

printf 'CDS Agent progress consistency: pass\n'
printf -- '- refresh: %s\n' "$REFRESH_OUTPUT"
printf -- '- progress: %s\n' "$PROGRESS_OUTPUT"
printf -- '- statusDoc: %s\n' "$STATUS_DOC"
