# 数据收集命令

> 被 SKILL.md Phase 2 引用。依次执行以下 6 组 git 命令收集原始数据。

## 2.1 提交总量

```bash
COMMIT_COUNT=$(git log --oneline --since="$MONDAY" --until="$NEXT_MONDAY" | wc -l)
git log --oneline --since="$MONDAY" --until="$NEXT_MONDAY"
```

## 2.2 去重文件/行数统计

> **⛔ 绝对禁止使用 `git log --shortstat` 逐条累加！**
>
> 该方式会导致被多次提交修改的文件和行数被重复计算，产生严重膨胀的数字。
> 本仓库为 shallow clone（`.git/shallow` 含 9 个边界提交），膨胀更为极端。
>
> **实际案例**：W06 真实净变更为 +53K 行，但累加 shortstat 得到 +2.3M 行（膨胀 44 倍）。

**正确做法** — 使用 `git diff --shortstat` 在首尾提交之间做一次性差分：

```bash
FIRST_COMMIT=$(git log --since="$MONDAY" --until="$NEXT_MONDAY" --reverse --format="%H" | head -1)
LAST_COMMIT=$(git log --since="$MONDAY" --until="$NEXT_MONDAY" --format="%H" | head -1)

# 尝试包含第一个提交的变更 (FIRST^..LAST)
STATS=$(git diff --shortstat "$FIRST_COMMIT^..$LAST_COMMIT" 2>/dev/null)
if [ $? -ne 0 ]; then
  # 浅克隆边界：第一个提交的 parent 不可达，退而使用 FIRST..LAST
  STATS=$(git diff --shortstat "$FIRST_COMMIT..$LAST_COMMIT")
  # 注意：此方式少算第一个提交的变更，误差通常可忽略
fi

echo "$STATS"
# 输出格式: "325 files changed, 37362 insertions(+), 5449 deletions(-)"
```

## 2.3 PR 列表与深度分析

**Step 1 — 确定 PR 范围**（基于上周报告，见纪律 1）：

```bash
# 从上周报告读取最后一个 PR 号
PREV_LAST_PR=$(grep -oP '#\d+ ~ #\K\d+' "$PREV_FILE" 2>/dev/null | head -1)
if [ -n "$PREV_LAST_PR" ]; then
  THIS_FIRST_PR=$((PREV_LAST_PR + 1))
else
  # 退化：从 merge commit 日期范围搜索
  THIS_FIRST_PR=$(git log --all --merges --format="%s" --since="$MONDAY" --until="$NEXT_MONDAY" | grep -oP 'Merge pull request #\K\d+' | sort -n | head -1)
fi
THIS_LAST_PR=$(git log --all --merges --format="%s" | grep -oP 'Merge pull request #\K\d+' | sort -n | tail -1)
```

**Step 2 — 获取 PR 列表**：

```bash
for PR_NUM in $(seq $THIS_FIRST_PR $THIS_LAST_PR); do
  HASH=$(git log --all --merges --format="%H %s" | grep "Merge pull request #${PR_NUM} " | head -1 | awk '{print $1}')
  if [ -n "$HASH" ]; then
    TITLE=$(git log "$HASH^2" --oneline -1 --format="%s" 2>/dev/null)
    COMMITS=$(git log "$HASH^1..$HASH^2" --oneline 2>/dev/null | wc -l)
    echo "#$PR_NUM ($COMMITS commits) | $TITLE"
  fi
done
```

**Step 3 — 深读每个 PR 的实际 commits**（见纪律 2）：

```bash
# 对每个 PR，读取其完整 commit 列表
for PR_NUM in $(seq $THIS_FIRST_PR $THIS_LAST_PR); do
  HASH=$(git log --all --merges --format="%H %s" | grep "Merge pull request #${PR_NUM} " | head -1 | awk '{print $1}')
  if [ -n "$HASH" ]; then
    echo "=== PR #$PR_NUM ==="
    git log "$HASH^1..$HASH^2" --oneline 2>/dev/null | head -10
  fi
done
```

> **⚠️ 为什么必须深读**：merge commit 标题往往是 PR 分支的最后一次 commit 消息（可能是 merge/fix），不代表 PR 的真实主题。例如 PR #201 标题为 `remove: delete TAPD template`，但实际包含 25 个 commits 的 ECharts 报告系统重构。

## 2.4 贡献者统计

```bash
git log --since="$MONDAY" --until="$NEXT_MONDAY" --format="%an" | sort | uniq -c | sort -rn
```

## 2.5 提交类型分布

```bash
git log --since="$MONDAY" --until="$NEXT_MONDAY" --format="%s" | \
  sed 's/(.*//; s/:.*//' | sort | uniq -c | sort -rn
```

归入标准类别：`feat` / `fix` / `refactor` / `docs` / `chore` / `perf` / `ui` / `style` / `test` / `ci`。中文开头或无前缀的归入 "中文 commit / 无前缀"。

## 2.6 每日提交分布

```bash
git log --since="$MONDAY" --until="$NEXT_MONDAY" \
  --format="%ad" --date=format:"%m-%d %A" | sort | uniq -c
```

对每天标注重点方向（分析当天 commit 消息中的关键词聚类）。
