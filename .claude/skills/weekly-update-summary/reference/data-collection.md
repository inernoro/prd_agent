# 数据收集命令

> 被 SKILL.md Phase 2 引用。依次执行以下 6 组 git 命令收集原始数据。

## 2.0 边界准备

> **核心原则**：
>
> 1. 只统计默认主干分支，不使用 `--all`
> 2. 使用 **提交时间** `"%cd"`，并配合 `--date=short` 输出 `YYYY-MM-DD`
> 3. 只按日期文本过滤：`MONDAY <= date <= SUNDAY`
> 4. 不做时区换算，不再用 `--since/--until` 作为最终边界判断

```bash
DEFAULT_BRANCH=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
DEFAULT_BRANCH=${DEFAULT_BRANCH:-main}

COMMITS_FILE=/tmp/weekly-commits.$$.tsv
PRS_FILE=/tmp/weekly-prs.$$.tsv

git log "$DEFAULT_BRANCH" --format="%cd\t%H\t%an\t%s" --date=short | \
  awk -F '\t' -v s="$MONDAY" -v e="$SUNDAY" '$1 >= s && $1 <= e' > "$COMMITS_FILE"
```

## 2.1 提交总量

```bash
COMMIT_COUNT=$(wc -l < "$COMMITS_FILE" | tr -d ' ')
cut -f1,2,4 "$COMMITS_FILE"
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
FIRST_COMMIT=$(tail -n 1 "$COMMITS_FILE" | cut -f2)
LAST_COMMIT=$(head -n 1 "$COMMITS_FILE" | cut -f2)

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

**Step 1 — 优先用 GitHub PR 元数据确定“哪些 PR 真正落到默认主干”**：

> **为什么**：`git log --merges` 只能看到 merge commit，看不到 fast-forward / rebase merge 到主干的 PR。
>
> **正确口径**：
>
> 1. 只取 `base = DEFAULT_BRANCH` 且 `merged = true` 的 PR
> 2. 对每个 PR，取其最终落地主干的 SHA（优先 `merge_commit_sha`）
> 3. 用本地 `git show -s --format="%cd" --date=short <sha>` 判定是否属于 `MONDAY ~ SUNDAY`

```bash
# 建议优先使用 GitHub MCP / gh / GitHub API 获取：
# - pr.number
# - pr.title
# - pr.base.ref
# - pr.merged
# - pr.merge_commit_sha
#
# 然后对每个候选 PR 执行：
git show -s --format="%cd\t%H\t%s" --date=short "$LANDING_SHA"
```

**Step 1 fallback — 如果拿不到 GitHub 元数据，再退化为主干 first-parent merge commits**：

```bash
git log "$DEFAULT_BRANCH" --first-parent --merges --format="%cd\t%H\t%s" --date=short | \
  awk -F '\t' -v s="$MONDAY" -v e="$SUNDAY" \
    '$1 >= s && $1 <= e && $3 ~ /^Merge pull request #[0-9]+ /' > "$PRS_FILE"
```

**Step 2 — 获取 PR 列表**：

```bash
while IFS=$'\t' read -r PR_DATE HASH SUBJECT; do
  PR_NUM=$(printf "%s" "$SUBJECT" | grep -oE '#[0-9]+' | head -1 | tr -d '#')
  TITLE=$(git log "$HASH^2" --oneline -1 --format="%s" 2>/dev/null)
  COMMITS=$(git log "$HASH^1..$HASH^2" --oneline 2>/dev/null | wc -l | tr -d ' ')
  echo "#$PR_NUM ($COMMITS commits) | $TITLE"
done < "$PRS_FILE"
```

> 如果使用 GitHub 元数据拿到的是 fast-forward / rebase merge，可能不存在 `HASH^2`。此时标题应直接使用 PR title，commit 数通过 GitHub PR metadata 或其它可验证方式补齐。

**Step 3 — 深读每个 PR 的实际 commits**（见纪律 2）：

```bash
while IFS=$'\t' read -r PR_DATE HASH SUBJECT; do
  PR_NUM=$(printf "%s" "$SUBJECT" | grep -oE '#[0-9]+' | head -1 | tr -d '#')
  echo "=== PR #$PR_NUM ==="
  git log "$HASH^1..$HASH^2" --oneline 2>/dev/null | head -10
done < "$PRS_FILE"
```

> **⚠️ 为什么必须深读**：merge commit 标题往往是 PR 分支的最后一次 commit 消息（可能是 merge/fix），不代表 PR 的真实主题。例如 PR #201 标题为 `remove: delete TAPD template`，但实际包含 25 个 commits 的 ECharts 报告系统重构。

## 2.4 贡献者统计

```bash
cut -f3 "$COMMITS_FILE" | sort | uniq -c | sort -rn
```

## 2.5 提交类型分布

```bash
cut -f4 "$COMMITS_FILE" | \
  sed 's/(.*//; s/:.*//' | sort | uniq -c | sort -rn
```

归入标准类别：`feat` / `fix` / `refactor` / `docs` / `chore` / `perf` / `ui` / `style` / `test` / `ci`。中文开头或无前缀的归入 "中文 commit / 无前缀"。

## 2.6 每日提交分布

```bash
cut -f1 "$COMMITS_FILE" | sort | uniq -c
```

对每天标注重点方向（分析当天 commit 消息中的关键词聚类）。
