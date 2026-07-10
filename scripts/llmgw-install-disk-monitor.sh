#!/usr/bin/env sh
set -eu

execute=0
if [ "${1:-}" = "--execute" ]; then
  execute=1
elif [ "$#" -gt 0 ]; then
  echo "usage: $0 [--execute]" >&2
  exit 64
fi

root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
monitor="$root/scripts/llmgw-disk-usage-monitor.sh"
retention="$root/scripts/llmgw-backup-retention.py"
service="$root/deploy/systemd/llmgw-disk-monitor.service"
timer="$root/deploy/systemd/llmgw-disk-monitor.timer"
retention_service="$root/deploy/systemd/llmgw-backup-retention.service"
retention_timer="$root/deploy/systemd/llmgw-backup-retention.timer"

for file in "$monitor" "$retention" "$service" "$timer" "$retention_service" "$retention_timer"; do
  if [ ! -f "$file" ]; then
    echo "ERROR: required file missing: $file" >&2
    exit 1
  fi
done

if [ "$execute" != "1" ]; then
  echo "+ install -m 0755 $monitor /usr/local/sbin/llmgw-disk-usage-monitor"
  echo "+ install -m 0755 $retention /usr/local/sbin/llmgw-backup-retention"
  echo "+ install -m 0644 $service /etc/systemd/system/llmgw-disk-monitor.service"
  echo "+ install -m 0644 $timer /etc/systemd/system/llmgw-disk-monitor.timer"
  echo "+ install -m 0644 $retention_service /etc/systemd/system/llmgw-backup-retention.service"
  echo "+ install -m 0644 $retention_timer /etc/systemd/system/llmgw-backup-retention.timer"
  echo "+ systemctl daemon-reload"
  echo "+ systemctl enable --now llmgw-disk-monitor.timer llmgw-backup-retention.timer"
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: --execute must run as root" >&2
  exit 1
fi

install -m 0755 "$monitor" /usr/local/sbin/llmgw-disk-usage-monitor
install -m 0755 "$retention" /usr/local/sbin/llmgw-backup-retention
install -m 0644 "$service" /etc/systemd/system/llmgw-disk-monitor.service
install -m 0644 "$timer" /etc/systemd/system/llmgw-disk-monitor.timer
install -m 0644 "$retention_service" /etc/systemd/system/llmgw-backup-retention.service
install -m 0644 "$retention_timer" /etc/systemd/system/llmgw-backup-retention.timer
systemctl daemon-reload
systemctl enable --now llmgw-disk-monitor.timer llmgw-backup-retention.timer
systemctl start llmgw-disk-monitor.service
systemctl --no-pager --full status llmgw-disk-monitor.timer llmgw-backup-retention.timer
