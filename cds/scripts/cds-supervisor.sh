#!/usr/bin/env bash
# CDS 后台进程 supervisor
#
# 2026-05-28 用户反馈:"Linux service 越来越鸡肋",改用纯后台进程。
# 目标:
#   - 替代 systemd 的 Restart=always
#   - 子进程死了 2s 后重启(self-update process.exit(0) 就靠这个)
#   - 接到 SIGTERM 优雅关闭(传给 child,等 child 退出)
#   - 写 PID 文件供 stop/status 用
#   - 日志追加到 /var/log/cds-*.log,不抢 stdout
#   - 不限制任何资源(没有 cgroup 包裹)
#
# 用法:
#   ./cds-supervisor.sh master    # 启动 master daemon
#   ./cds-supervisor.sh forwarder  # 启动 forwarder
#   ./cds-supervisor.sh status master
#   ./cds-supervisor.sh stop master

set -u

SUBCMD="${1:-master}"
shift || true

CDS_ROOT="${CDS_REPO_ROOT:-/root/inernoro/prd_agent}"
NODE_BIN="${CDS_NODE_BIN:-/opt/node22/bin/node}"
RUN_DIR="${CDS_RUN_DIR:-/run/cds}"
LOG_DIR="${CDS_LOG_DIR:-/var/log/cds}"
RESTART_DELAY_SEC="${CDS_RESTART_DELAY_SEC:-2}"

mkdir -p "$RUN_DIR" "$LOG_DIR" 2>/dev/null || true

case "$SUBCMD" in
  master)
    ROLE=master
    SCRIPT="$CDS_ROOT/cds/dist/index.js"
    ;;
  forwarder)
    ROLE=forwarder
    SCRIPT="$CDS_ROOT/cds/dist/forwarder-main.js"
    ;;
  *)
    # 不是启动子命令,转给管理操作
    ;;
esac

PID_FILE="$RUN_DIR/cds-${ROLE:-unknown}.pid"
SUPERVISOR_PID_FILE="$RUN_DIR/cds-${ROLE:-unknown}.supervisor.pid"
LOG_FILE="$LOG_DIR/cds-${ROLE:-unknown}.log"

run_loop() {
  local role="$1" script="$2"
  # 自己注册到 supervisor pid 文件
  echo $$ > "$SUPERVISOR_PID_FILE"
  local child=""
  trap '
    [ -n "$child" ] && kill -TERM "$child" 2>/dev/null
    [ -n "$child" ] && wait "$child" 2>/dev/null
    rm -f "$PID_FILE" "$SUPERVISOR_PID_FILE"
    echo "[supervisor $role $(date -Iseconds)] shutdown clean"
    exit 0
  ' TERM INT

  echo "[supervisor $role $(date -Iseconds)] starting,script=$script"
  while true; do
    "$NODE_BIN" "$script" &
    child=$!
    echo $child > "$PID_FILE"
    echo "[supervisor $role $(date -Iseconds)] child pid=$child"
    wait $child
    local rc=$?
    echo "[supervisor $role $(date -Iseconds)] child exited code=$rc,${RESTART_DELAY_SEC}s 后重启"
    sleep "$RESTART_DELAY_SEC"
  done
}

case "$SUBCMD" in
  master|forwarder)
    exec >> "$LOG_FILE" 2>&1
    run_loop "$ROLE" "$SCRIPT"
    ;;

  status)
    ROLE2="${1:-master}"
    PID_F="$RUN_DIR/cds-${ROLE2}.pid"
    SUP_F="$RUN_DIR/cds-${ROLE2}.supervisor.pid"
    if [ -f "$PID_F" ] && kill -0 "$(cat "$PID_F")" 2>/dev/null; then
      echo "cds-${ROLE2}: running pid=$(cat "$PID_F") supervisor=$(cat "$SUP_F" 2>/dev/null || echo '?')"
    else
      echo "cds-${ROLE2}: not running"
      exit 1
    fi
    ;;

  stop)
    ROLE2="${1:-master}"
    SUP_F="$RUN_DIR/cds-${ROLE2}.supervisor.pid"
    if [ -f "$SUP_F" ]; then
      sup_pid=$(cat "$SUP_F")
      if kill -0 "$sup_pid" 2>/dev/null; then
        echo "stopping cds-${ROLE2} supervisor pid=$sup_pid"
        kill -TERM "$sup_pid"
        # 等 5s
        for i in 1 2 3 4 5; do
          sleep 1
          kill -0 "$sup_pid" 2>/dev/null || break
        done
        kill -0 "$sup_pid" 2>/dev/null && kill -KILL "$sup_pid" 2>/dev/null
      fi
    fi
    rm -f "$RUN_DIR/cds-${ROLE2}.pid" "$SUP_F"
    echo "cds-${ROLE2}: stopped"
    ;;

  *)
    cat >&2 <<HELP
Usage: $0 <master|forwarder|status|stop> [args]

  master                    Run cds-master daemon under supervision
  forwarder                 Run cds-forwarder daemon under supervision
  status <master|forwarder> Show running status
  stop <master|forwarder>   Send SIGTERM, wait, then SIGKILL

环境变量:
  CDS_REPO_ROOT (默认 /root/inernoro/prd_agent)
  CDS_NODE_BIN (默认 /opt/node22/bin/node)
  CDS_RUN_DIR (默认 /run/cds)
  CDS_LOG_DIR (默认 /var/log/cds)
  CDS_RESTART_DELAY_SEC (默认 2)

启动示例(用 setsid 完全脱离 shell,机器重启后失效;配合 crontab @reboot):
  setsid $0 master   < /dev/null > /dev/null 2>&1 &
  setsid $0 forwarder < /dev/null > /dev/null 2>&1 &
HELP
    exit 2
    ;;
esac
