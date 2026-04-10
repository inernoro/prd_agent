#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# CDS 入口 (根目录转发器)
#
# 所有逻辑都在 cds/exec_cds.sh 中维护。本文件只是转发，
# 让你在 prd_agent 根目录下直接调用，无需 cd cds/。
#
# 常用命令:
#   ./exec_cds.sh init      初始化 (写 .cds.env + 生成 nginx 配置)
#   ./exec_cds.sh start     启动 CDS + Nginx (默认后台)
#   ./exec_cds.sh stop      停止
#   ./exec_cds.sh restart   重启
#   ./exec_cds.sh status    查看状态
#   ./exec_cds.sh logs      跟随日志
# ──────────────────────────────────────────────────────────────

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/cds/exec_cds.sh" "$@"
