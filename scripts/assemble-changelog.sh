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
date_keys=()
date_values=()

find_date_index() {
  local needle="$1"
  local i
  for ((i = 0; i < ${#date_keys[@]}; i++)); do
    if [[ "${date_keys[$i]}" == "$needle" ]]; then
      echo "$i"
      return 0
    fi
  done
  echo "-1"
}

get_date_entries() {
  local needle="$1"
  local i
  for ((i = 0; i < ${#date_keys[@]}; i++)); do
    if [[ "${date_keys[$i]}" == "$needle" ]]; then
      echo "${date_values[$i]}"
      return 0
    fi
  done
}

for f in "${fragments[@]}"; do
  basename=$(basename "$f")
  # 提取日期 (YYYY-MM-DD)
  date_part="${basename%%_*}"

  if [[ ! "$date_part" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "  跳过格式不正确的文件: $basename"
    continue
  fi

  content=$(cat "$f")
  index=$(find_date_index "$date_part")
  if [[ "$index" -ge 0 ]]; then
    date_values[$index]="${date_values[$index]}"$'\n'"$content"
  else
    date_keys+=("$date_part")
    date_values+=("$content")
  fi
  echo "  $basename -> $date_part"
done

if [[ ${#date_keys[@]} -eq 0 ]]; then
  echo "没有有效的碎片文件。"
  exit 0
fi

# 按日期降序排序
IFS=$'\n' sorted_dates=($(printf '%s\n' "${date_keys[@]}" | sort -r))
unset IFS

if ! grep -q '## \[未发布\]' "$CHANGELOG"; then
  echo "找不到 '## [未发布]' 标记"
  exit 1
fi

# 合并交给 scripts/lib/changelog_merge.py：已有同日期段就并进那一段，没有才新起一段。
# 原来这里是「无条件在 [未发布] 后插入整块」，下面还留着一行
# 「检查是否已有相同日期的条目，如果有则需要合并」的注释——注释承诺的行为并不存在。
# 后果不是排版难看：ChangelogReader 对每个 `### 日期` 都新建一个 ChangelogDay 且不去重，
# 更新中心会把同一天渲染成两组，日期顺序还会往回跳。
payload_file=$(mktemp)
trap 'rm -f "$payload_file"' EXIT
{
  printf '{'
  first=true
  for date in "${sorted_dates[@]}"; do
    $first || printf ','
    first=false
    printf '"%s":' "$date"
    get_date_entries "$date" | python3 -c 'import json,sys; print(json.dumps([l for l in sys.stdin.read().split("\n") if l.strip()], ensure_ascii=False))'
  done
  printf '}'
} > "$payload_file"

# dry-run 走同一条 merge 路径，只是不落盘、不删碎片。
# 原来它自己拼一份预览：那份预览把每个日期都画成新起一段，而真跑会并进已有段——
# 预览与实际行为不一致，等于给了一个看着像证据、其实不成立的东西（形状 8）。
if $DRY_RUN; then
  echo ""
  echo "=== dry-run：将按下面这样合并（不落盘、不删碎片）==="
  python3 "$(dirname "$0")/lib/changelog_merge.py" --dry-run "$CHANGELOG" "$payload_file"
  exit 0
fi

python3 "$(dirname "$0")/lib/changelog_merge.py" "$CHANGELOG" "$payload_file"

# 删除碎片文件
for f in "${fragments[@]}"; do
  if git ls-files --error-unmatch "$f" &>/dev/null 2>&1; then
    git rm -q "$f"
  else
    rm "$f"
  fi
done

echo ""
echo "已合并 ${#fragments[@]} 个碎片到 $CHANGELOG"
echo "请检查 $CHANGELOG 并提交。"
