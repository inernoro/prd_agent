#!/usr/bin/env sh
set -eu

target="${1:-/}"
warning_percent="${2:-80}"
critical_percent="${3:-90}"
label="${4:-LLM Gateway production disk}"

for value in "$warning_percent" "$critical_percent"; do
  if ! printf '%s' "$value" | grep -Eq '^[0-9]+$'; then
    echo "ERROR: disk usage threshold must be an integer: $value" >&2
    exit 64
  fi
done
if [ "$warning_percent" -ge "$critical_percent" ] || [ "$critical_percent" -gt 100 ]; then
  echo "ERROR: thresholds must satisfy warning < critical <= 100" >&2
  exit 64
fi

probe_path="$target"
while [ ! -e "$probe_path" ]; do
  parent="$(dirname -- "$probe_path")"
  if [ "$parent" = "$probe_path" ]; then
    echo "ERROR: disk monitor cannot find existing parent for: $target" >&2
    exit 64
  fi
  probe_path="$parent"
done

usage_raw="$(df -P "$probe_path" | awk 'NR == 2 { print $5 }')"
usage_percent="${usage_raw%%%}"
mount_point="$(df -P "$probe_path" | awk 'NR == 2 { print $6 }')"
available_kb="$(df -Pk "$probe_path" | awk 'NR == 2 { print $4 }')"
if ! printf '%s' "$usage_percent" | grep -Eq '^[0-9]+$'; then
  echo "ERROR: disk monitor could not parse usage for: $target" >&2
  exit 64
fi

timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
if [ "$usage_percent" -ge "$critical_percent" ]; then
  message="CRITICAL: $label usage=${usage_percent}% availableKB=$available_kb mount=$mount_point target=$target at=$timestamp"
  echo "$message"
  command -v logger >/dev/null 2>&1 && logger -p user.crit -t llmgw-disk "$message" || true
  exit 2
fi
if [ "$usage_percent" -ge "$warning_percent" ]; then
  message="WARNING: $label usage=${usage_percent}% availableKB=$available_kb mount=$mount_point target=$target at=$timestamp"
  echo "$message"
  command -v logger >/dev/null 2>&1 && logger -p user.warning -t llmgw-disk "$message" || true
  exit 1
fi

if [ "${LLMGW_DISK_MONITOR_QUIET_OK:-0}" != "1" ]; then
  echo "OK: $label usage=${usage_percent}% availableKB=$available_kb mount=$mount_point target=$target at=$timestamp"
fi
