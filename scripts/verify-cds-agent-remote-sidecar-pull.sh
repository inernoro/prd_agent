#!/usr/bin/env bash
# Verify that a target remote host can docker pull the sidecar image.
# Default mode is dry-run/validation. It only opens SSH and runs docker pull
# when CDS_AGENT_REMOTE_PULL_VERIFY=1.

set -euo pipefail

REPORT="${CDS_AGENT_REMOTE_PULL_REPORT:-/tmp/cds-agent-remote-sidecar-pull-current.json}"
LOG="${CDS_AGENT_REMOTE_PULL_LOG:-/tmp/cds-agent-remote-sidecar-pull-current.log}"
VERIFY="${CDS_AGENT_REMOTE_PULL_VERIFY:-0}"
IMAGE="${CDS_AGENT_SIDECAR_IMAGE:-}"
HOST="${CDS_REMOTE_HOST_HOST:-}"
USER="${CDS_REMOTE_HOST_SSH_USER:-}"
PORT="${CDS_REMOTE_HOST_SSH_PORT:-22}"
KEY_FILE="${CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE:-}"
KEY_INLINE="${CDS_REMOTE_HOST_SSH_PRIVATE_KEY:-}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "missing dependency: jq"

safe_docker_image_ref() {
  local value="$1"
  [[ -n "$value" && ${#value} -le 256 && "$value" =~ ^[a-zA-Z0-9._/:@-]+$ ]]
}

append_json_string() {
  jq --arg value "$2" '. + [$value]' <<< "$1"
}

write_report() {
  local status="$1"
  local detail="$2"
  local ssh_attempted="$3"
  local pull_attempted="$4"
  local pull_passed="$5"
  local exit_code="$6"
  mkdir -p "$(dirname "$REPORT")"
  local tmp_report="${REPORT}.tmp.$$"
  jq -n \
    --arg generatedAt "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    --arg report "$REPORT" \
    --arg status "$status" \
    --arg detail "$detail" \
    --arg image "$IMAGE" \
    --arg host "$HOST" \
    --arg user "$USER" \
    --arg port "$PORT" \
    --arg log "$LOG" \
    --argjson missing "$missing" \
    --argjson invalid "$invalid" \
    --argjson verifyEnabled "$([[ "$VERIFY" == "1" ]] && printf true || printf false)" \
    --argjson sshAttempted "$ssh_attempted" \
    --argjson pullAttempted "$pull_attempted" \
    --argjson pullPassed "$pull_passed" \
    --argjson exitCode "$exit_code" \
    '{
      generatedAt: $generatedAt,
      report: $report,
      status: $status,
      detail: $detail,
      image: (if $image == "" then null else $image end),
      host: (if $host == "" then null else $host end),
      sshUser: (if $user == "" then null else $user end),
      sshPort: $port,
      verifyEnabled: $verifyEnabled,
      sshAttempted: $sshAttempted,
      pullAttempted: $pullAttempted,
      pullPassed: $pullPassed,
      exitCode: $exitCode,
      missingConfig: $missing,
      invalidConfig: $invalid,
      log: $log,
      commandShape: "ssh -p <port> <user>@<host> docker pull <image>",
      deployAttempted: false
    }' > "$tmp_report"
  mv "$tmp_report" "$REPORT"
}

missing='[]'
invalid='[]'

[[ -n "$IMAGE" ]] || missing=$(append_json_string "$missing" "CDS_AGENT_SIDECAR_IMAGE")
[[ -n "$HOST" ]] || missing=$(append_json_string "$missing" "CDS_REMOTE_HOST_HOST")
[[ -n "$USER" ]] || missing=$(append_json_string "$missing" "CDS_REMOTE_HOST_SSH_USER")
if [[ -z "$KEY_FILE" && -z "$KEY_INLINE" ]]; then
  missing=$(append_json_string "$missing" "CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE or CDS_REMOTE_HOST_SSH_PRIVATE_KEY")
fi

if [[ -n "$IMAGE" ]] && ! safe_docker_image_ref "$IMAGE"; then
  invalid=$(append_json_string "$invalid" "CDS_AGENT_SIDECAR_IMAGE is not safe for docker pull")
fi
if [[ -n "$HOST" && "$HOST" == *"://"* ]]; then
  invalid=$(append_json_string "$invalid" "CDS_REMOTE_HOST_HOST must be hostname/IP, not URL")
fi
if [[ -n "$PORT" && ! "$PORT" =~ ^[0-9]+$ ]]; then
  invalid=$(append_json_string "$invalid" "CDS_REMOTE_HOST_SSH_PORT must be numeric")
fi
if [[ -n "$KEY_FILE" ]]; then
  if [[ ! -f "$KEY_FILE" ]]; then
    invalid=$(append_json_string "$invalid" "CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE does not exist")
  elif ! grep -q -- 'BEGIN .*PRIVATE KEY' "$KEY_FILE"; then
    invalid=$(append_json_string "$invalid" "CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE does not look like a private key")
  fi
elif [[ -n "$KEY_INLINE" && "$KEY_INLINE" != *"BEGIN "*PRIVATE\ KEY* ]]; then
  invalid=$(append_json_string "$invalid" "CDS_REMOTE_HOST_SSH_PRIVATE_KEY does not look like a private key")
fi

missing_count=$(jq 'length' <<< "$missing")
invalid_count=$(jq 'length' <<< "$invalid")
: > "$LOG"

if [[ "$invalid_count" -gt 0 ]]; then
  write_report "invalid_config" "fix invalid remote pull config before SSH" false false false 2
elif [[ "$missing_count" -gt 0 ]]; then
  write_report "missing_config" "provide remote pull config before SSH" false false false 2
elif [[ "$VERIFY" != "1" ]]; then
  write_report "dry_run_ready" "set CDS_AGENT_REMOTE_PULL_VERIFY=1 to SSH and docker pull" false false false 0
else
  tmp_key=""
  cleanup() {
    [[ -n "$tmp_key" ]] && rm -f "$tmp_key"
  }
  trap cleanup EXIT

  effective_key="$KEY_FILE"
  if [[ -z "$effective_key" ]]; then
    tmp_key="$(mktemp)"
    printf '%s' "$KEY_INLINE" > "$tmp_key"
    chmod 600 "$tmp_key"
    effective_key="$tmp_key"
  fi

  ssh_cmd=(
    ssh
    -i "$effective_key"
    -p "$PORT"
    -o BatchMode=yes
    -o ConnectTimeout=15
    -o StrictHostKeyChecking=accept-new
    "$USER@$HOST"
    "docker pull '$IMAGE'"
  )

  if "${ssh_cmd[@]}" >"$LOG" 2>&1; then
    write_report "pull_pass" "remote host docker pull succeeded" true true true 0
  else
    code=$?
    write_report "pull_failed" "remote host docker pull failed; inspect log" true true false "$code"
  fi
fi

printf '# CDS Agent Remote Sidecar Pull\n\n'
jq -r '
  "- report: `" + .report + "`",
  "- status: `" + .status + "`",
  "- image: `" + (.image // "missing") + "`",
  "- host: `" + (.host // "missing") + "`",
  "- verifyEnabled: `" + (.verifyEnabled|tostring) + "`",
  "- pullAttempted: `" + (.pullAttempted|tostring) + "`",
  "- detail: `" + .detail + "`",
  "- log: `" + .log + "`"
' "$REPORT"

status="$(jq -r '.status' "$REPORT")"
[[ "$status" == "dry_run_ready" || "$status" == "pull_pass" ]]
