#!/bin/bash
# 校验 git commit 标题，避免提交信息自由散乱。

set -euo pipefail

MSG_FILE="${1:-}"
if [ -z "$MSG_FILE" ] || [ ! -f "$MSG_FILE" ]; then
  echo "[commit-msg] 找不到 commit message 文件。"
  exit 1
fi

subject="$(grep -v '^[[:space:]]*#' "$MSG_FILE" | sed '/^[[:space:]]*$/d' | head -n 1 || true)"
subject="${subject#"${subject%%[![:space:]]*}"}"
subject="${subject%"${subject##*[![:space:]]}"}"

if [ -z "$subject" ]; then
  echo "[commit-msg] 提交标题不能为空。"
  exit 1
fi

if [[ "$subject" =~ ^Merge[[:space:]] ]]; then
  exit 0
fi

ALLOWED_TYPES="feat fix perf refactor docs chore test ci build release revert merge security ops style polish rule"
TYPE_PATTERN="$(printf '%s' "$ALLOWED_TYPES" | tr ' ' '|')"

if [[ "$subject" =~ ^($TYPE_PATTERN)(\([a-zA-Z0-9._/-]+\))?:[[:space:]].{4,}$ ]]; then
  exit 0
fi

echo "[commit-msg] 提交标题不符合格式。"
echo "[commit-msg] 格式：type(scope): 中文说明"
echo "[commit-msg] 示例：fix(prd-admin): 更新中心筛选类型改为枚举"
echo "[commit-msg] 允许 type：$ALLOWED_TYPES"
exit 1
