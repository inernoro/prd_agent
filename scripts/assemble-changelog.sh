#!/usr/bin/env bash
# assemble-changelog.sh — 将 changelogs/ 碎片文件合并进 CHANGELOG.md
# 用法：bash scripts/assemble-changelog.sh [--dry-run]
#
# 碎片文件格式：changelogs/YYYY-MM-DD_<短描述>.md
# 内容为一行或多行表格行，例如：
#   | feat | prd-admin | 新增XX功能 |
#
# 执行后碎片文件会被 git rm。

set -euo pipefail

CHANGELOG="CHANGELOG.md"
FRAGMENTS_DIR="changelogs"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

# 收集所有碎片文件（排除 .gitkeep）
shopt -s nullglob
fragments=("$FRAGMENTS_DIR"/*.md)
shopt -u nullglob

if [[ ${#fragments[@]} -eq 0 ]]; then
  echo "没有碎片文件需要合并。"
  exit 0
fi

echo "找到 ${#fragments[@]} 个碎片文件："

# 按日期分组
declare -A date_entries

for f in "${fragments[@]}"; do
  basename=$(basename "$f")
  # 提取日期 (YYYY-MM-DD)
  date_part="${basename%%_*}"

  if [[ ! "$date_part" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "  ⚠ 跳过格式不正确的文件: $basename"
    continue
  fi

  content=$(cat "$f")
  if [[ -n "${date_entries[$date_part]+x}" ]]; then
    date_entries[$date_part]+=$'\n'"$content"
  else
    date_entries[$date_part]="$content"
  fi
  echo "  ✓ $basename → $date_part"
done

if [[ ${#date_entries[@]} -eq 0 ]]; then
  echo "没有有效的碎片文件。"
  exit 0
fi

# 按日期降序排序
sorted_dates=($(echo "${!date_entries[@]}" | tr ' ' '\n' | sort -r))

# 构建插入内容
insert_block=""
for date in "${sorted_dates[@]}"; do
  insert_block+="### $date"$'\n'
  insert_block+=$'\n'
  insert_block+="| 类型 | 模块 | 描述 |"$'\n'
  insert_block+="|------|------|------|"$'\n'
  insert_block+="${date_entries[$date]}"$'\n'
  insert_block+=$'\n'
done

if $DRY_RUN; then
  echo ""
  echo "=== 将插入以下内容（dry-run）==="
  echo "$insert_block"
  exit 0
fi

# 在 "## [未发布]" 后插入
# 找到 "[未发布]" 行号
line_num=$(grep -n '## \[未发布\]' "$CHANGELOG" | head -1 | cut -d: -f1)

if [[ -z "$line_num" ]]; then
  echo "❌ 找不到 '## [未发布]' 标记"
  exit 1
fi

# 在 [未发布] 后插入空行 + 内容
head -n "$line_num" "$CHANGELOG" > "${CHANGELOG}.tmp"
echo "" >> "${CHANGELOG}.tmp"
echo -n "$insert_block" >> "${CHANGELOG}.tmp"

# 检查 [未发布] 后面是否已有相同日期的条目，如果有则需要合并
tail_start=$((line_num + 1))
tail -n +"$tail_start" "$CHANGELOG" >> "${CHANGELOG}.tmp"
mv "${CHANGELOG}.tmp" "$CHANGELOG"

# 删除碎片文件
for f in "${fragments[@]}"; do
  if git ls-files --error-unmatch "$f" &>/dev/null 2>&1; then
    git rm -q "$f"
  else
    rm "$f"
  fi
done

echo ""
echo "✅ 已合并 ${#fragments[@]} 个碎片到 $CHANGELOG"
echo "💡 请检查 $CHANGELOG 并提交。"
