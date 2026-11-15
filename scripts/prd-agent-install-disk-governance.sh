#!/bin/sh
set -eu
# Production host installer. Preview the exact actions unless --execute is supplied.
execute=0
case "${1:-}" in
  --execute) execute=1 ;;
  '') ;;
  *) echo "usage: $0 [--execute]" >&2; exit 64 ;;
esac
root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
if [ "$execute" = 0 ]; then
  printf '%s\n' 'Install release/cleanup lock, daily artifact retention, 30-day request-log retention every 15 minutes, Nginx rotation and journald limits.'
  printf '%s\n' 'Existing containers require the explicit per-container log rollout; this installer does not recreate containers or restart Docker.'
  exit 0
fi
[ "$(id -u)" = 0 ]
[ -d /root/inernoro/prd_agent/.git ]
command -v flock >/dev/null
command -v logrotate >/dev/null
install -d -m 0755 /usr/local/lib/prd-agent /var/lib/prd-agent /etc/systemd/journald.conf.d
install -m 0755 "$root/scripts/prd-agent-artifact-retention.py" /usr/local/sbin/prd-agent-artifact-retention
install -m 0755 "$root/scripts/prd-agent-with-release-lock.sh" /usr/local/sbin/prd-agent-with-release-lock
install -m 0755 "$root/scripts/prd-agent-request-log-retention.sh" /usr/local/sbin/prd-agent-request-log-retention
install -m 0755 "$root/scripts/prd-agent-container-log-rollout.py" /usr/local/sbin/prd-agent-container-log-rollout
install -m 0644 "$root/scripts/prd-agent-request-log-retention.js" /usr/local/lib/prd-agent/request-log-retention.js
for unit in prd-agent-artifact-retention.service prd-agent-artifact-retention.timer prd-agent-request-log-retention.service prd-agent-request-log-retention.timer; do
  install -m 0644 "$root/deploy/systemd/$unit" "/etc/systemd/system/$unit"
done
install -m 0644 "$root/deploy/logrotate/prd-agent-nginx" /etc/logrotate.d/prd-agent-nginx
install -m 0644 "$root/deploy/journald/prd-agent-disk.conf" /etc/systemd/journald.conf.d/prd-agent-disk.conf
logrotate --debug /etc/logrotate.d/prd-agent-nginx
systemctl daemon-reload
systemctl enable --now prd-agent-artifact-retention.timer prd-agent-request-log-retention.timer
systemctl restart systemd-journald
printf '%s\n' 'Disk governance installed; run and verify retention services before handoff.'
