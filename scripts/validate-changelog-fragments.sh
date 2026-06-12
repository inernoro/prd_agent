#!/bin/bash
# 校验 changelogs/*.md 碎片格式与类型枚举。

set -euo pipefail

ALLOWED_TYPES="feat fix perf refactor docs chore test ci security ops style polish rule merge revert"
ALLOWED_PATTERN="^($(printf '%s' "$ALLOWED_TYPES" | tr ' ' '|'))$"

if [ "$#" -gt 0 ]; then
  FILES=("$@")
else
  FILES=()
  while IFS= read -r file; do
    [ -n "$file" ] && FILES+=("$file")
  done < <(git diff --cached --name-only --diff-filter=ACM -- 'changelogs/*.md' || true)
fi

if [ "${#FILES[@]}" -eq 0 ]; then
  exit 0
fi

failed=0

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

for file in "${FILES[@]}"; do
  if [ ! -f "$file" ]; then
    continue
  fi

  line_no=0
  while IFS= read -r line || [ -n "$line" ]; do
    line_no=$((line_no + 1))
    if [[ "$line" =~ ^[[:space:]]*$ ]]; then
      continue
    fi
    if [[ "$line" =~ ^[[:space:]]*# ]]; then
      continue
    fi

    IFS='|' read -r _ raw_type raw_module raw_desc _rest <<< "$line"
    type_value="$(trim "${raw_type:-}")"
    module_value="$(trim "${raw_module:-}")"
    desc_value="$(trim "${raw_desc:-}")"

    if [ -z "$type_value" ] || [ -z "$module_value" ] || [ -z "$desc_value" ] || [[ ! "$line" =~ ^[[:space:]]*\|.*\|.*\|.*\|[[:space:]]*$ ]]; then
      echo "[changelog] $file:$line_no 格式错误。应为：| type | module | 描述 |"
      failed=1
      continue
    fi

    if [[ "$type_value" == "类型" || "$module_value" == "模块" ]]; then
      echo "[changelog] $file:$line_no 不要写表头，碎片文件只写表格行。"
      failed=1
      continue
    fi

    if [[ ! "$type_value" =~ $ALLOWED_PATTERN ]]; then
      echo "[changelog] $file:$line_no 类型 '$type_value' 不在枚举中。"
      echo "[changelog] 允许类型：$ALLOWED_TYPES"
      failed=1
    fi
  done < "$file"
done

if [ "$failed" -ne 0 ]; then
  exit 1
fi

exit 0
