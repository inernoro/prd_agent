#!/usr/bin/env sh
set -eu

# 兼容无下划线的历史/口头脚本名，实际发布逻辑唯一入口仍是 exec_dep.sh。
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$script_dir/exec_dep.sh" "$@"
