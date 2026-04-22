---
name: weekly-update-summary
description: Generates weekly project reports from git history. Collects commits, PRs, and contributor data, analyzes and categorizes changes, then produces a structured Chinese-language weekly report (overview, completed items, next-week priorities) saved to doc/report.YYYY-WXX.md. Trigger words: "生成周报", "写周报", "weekly report", "本周总结".
---

# Weekly Update Summary — 自动化周报生成

每周自动从 git 历史中收集数据，分析归类后生成结构化中文周报。

## 核心纪律（必须遵守）

### 纪律 1：时间边界按“提交日期文本”判断，不做时区换算

> **根因案例**：同一批提交如果按 `--since/--until` 直接让 Git 解析日期，容易受提交自带时区影响，把周日晚或下周一的提交卷进错误周次。

**正确做法**：
1. 周边界只定义为 `MONDAY ~ SUNDAY` 两个日期字符串，例如 `2026-04-13 ~ 2026-04-19`
2. 统一使用 **提交时间**（`%cd`）并配合 `--date=short` 输出 `YYYY-MM-DD`
3. 只按这个日期文本过滤：`$1 >= MONDAY && $1 <= SUNDAY`
4. **不要**再用 `--since/--until` 做最终统计判断

```bash
git log "$DEFAULT_BRANCH" --format="%cd\t%H\t%an\t%s" --date=short | \
  awk -F '\t' -v s="$MONDAY" -v e="$SUNDAY" '$1 >= s && $1 <= e'
```

### 纪律 2：只统计默认主干分支，不使用 `--all`

> **根因案例**：`--all` 会把未合并分支、WIP merge、临时调试分支和历史噪声一起统计进去，导致“研发活动周报”和“主干落地周报”混淆。

**正确做法**：
1. 先检测默认主干分支（通常是 `main`）
2. 之后所有 commit、PR、贡献者、类型分布统计都只对这个分支执行
3. **禁止** `git log --all ...`

```bash
DEFAULT_BRANCH=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
DEFAULT_BRANCH=${DEFAULT_BRANCH:-main}
```
### 纪律 3：PR 边界按“本周实际落地主干的 PR”判断，不按 PR 编号连续段

> **根因案例**：本仓库存在“低编号 PR 晚于高编号 PR 合并”的情况。如果用 `#FIRST ~ #LAST` 当周边界，会把跨周 PR 和下周 PR 一起卷进来。
>
> **新增根因案例**：仅靠 `git log --merges` 会漏掉 fast-forward merge 到 `main` 的 PR，例如 PR #396 这种“已落地主干、但没有 merge commit”的情况。

**正确做法**：
1. **PR 身份**以 GitHub PR 元数据为准：只统计 `base = DEFAULT_BRANCH` 且 `merged = true` 的 PR
2. **周归属**以该 PR 最终落地主干的 SHA 在本地 `git` 里的 `%cd --date=short` 为准
3. 这一步要同时覆盖 merge commit、fast-forward merge、rebase merge
4. 只有在拿不到 GitHub PR 元数据时，才退化为本地 `git log --first-parent --merges`
5. 附录列出**本周实际 PR 集合**
6. 头部和附录标题**不要**再写 `#FIRST ~ #LAST`

```bash
# 伪代码：
# 1. 查询 GitHub PR：base=DEFAULT_BRANCH, merged=true
# 2. 取 merge_commit_sha（或最终落地主干的 SHA）
# 3. 用 git show -s --format="%cd" --date=short <sha> 判定是否属于 MONDAY~SUNDAY
```

### 纪律 4：深读 PR 实际 commits，不信 merge commit 标题

> **根因案例**：PR #201 标题是 `remove: delete TAPD template`，但实际 25 个 commits 包含 ECharts 重构等重大功能。

**正确做法**：对每个 PR，用 `git log HASH^1..HASH^2 --oneline` 读取全部 commits，基于 commits 内容判断 PR 真实主题。

### 纪律 5：先列脉络确认，再写完整报告

> **根因案例**：直接生成完整报告，脉络分组有误，修改成本高。先列脉络候选让用户确认，一次通过。

**正确做法**：完成数据收集和 PR 深读后，**必须先向用户展示重大脉络候选列表**，等用户确认后再生成完整报告。

输出格式：
```
**W{NUM} ({DATE_RANGE}) | {COUNT} 个 PR**

### 重大脉络候选（按影响程度排序）：

1. **{脉络名}** — {一句话总结} ({相关PR列表})
2. **{脉络名}** — {一句话总结} ({相关PR列表})
...

这些脉络你觉得对吗？有哪些需要调整、合并或拆分的？
```

### 纪律 6：文件命名使用 `report.YYYY-WXX.md`

文件名为 `doc/report.{ISO_YEAR}-W{WEEK_NUM}.md`，搜索上周报告时也要用此格式。

## 触发词

"生成周报" / "写周报" / "本周总结" / "周报" / "weekly report" / "weekly summary" / "上周总结"

---

## 执行流程

### Phase 1: 确定目标周

根据当前日期自动判断应该生成哪一周的周报。

```bash
DOW=$(date +%u)   # 1=周一 ... 7=周日
TODAY=$(date +%Y-%m-%d)
```

**判断规则**：
- 周六 (6) 或周日 (7)：生成**本周**周报
- 周一 (1)：生成**上周**周报
- 周二到周五 (2-5)：询问用户要生成本周还是上周

**计算周范围**：

```bash
if [ "$DOW" -ge 6 ]; then
  MONDAY=$(date -d "$TODAY - $((DOW - 1)) days" +%Y-%m-%d)
elif [ "$DOW" -eq 1 ]; then
  MONDAY=$(date -d "$TODAY - 7 days" +%Y-%m-%d)
fi

SUNDAY=$(date -d "$MONDAY + 6 days" +%Y-%m-%d)
WEEK_NUM=$(date -d "$MONDAY" +%V)
ISO_YEAR=$(date -d "$MONDAY" +%G)

REPORT_FILE="doc/report.${ISO_YEAR}-W${WEEK_NUM}.md"
```

**重要**：使用 `%G` (ISO 年份) 和 `%V` (ISO 周号)，不要用 `%Y`，避免跨年边界错误。

---

### Phase 2: 数据收集

依次执行 6 组 git 命令收集原始数据 → 见 [reference/data-collection.md](reference/data-collection.md)

**命令速查**：

| 步骤 | 目的 | 关键点 |
|------|------|--------|
| 2.0 | 边界准备 | 默认主干 + `MONDAY/SUNDAY` 日期字符串 |
| 2.1 | 提交总量 | `git log "$DEFAULT_BRANCH" --date=short` + 日期文本过滤 |
| 2.2 | 去重文件/行数 | **禁止** `--shortstat` 累加，用 `git diff --shortstat FIRST^..LAST` |
| 2.3 | PR 列表与深读 | 只取本周实际 merge 到主干的 PR |
| 2.4 | 贡献者统计 | 从本周 commit 集合提取 author |
| 2.5 | 提交类型分布 | 从本周 commit 集合按标准前缀归类 |
| 2.6 | 每日提交分布 | 标注每天重点方向 |

---

### Phase 3: 加载上周报告

```bash
PREV_WEEK_NUM=$((10#$WEEK_NUM - 1))
if [ "$PREV_WEEK_NUM" -lt 1 ]; then
  PREV_ISO_YEAR=$((ISO_YEAR - 1))
  PREV_WEEK_NUM=52
else
  PREV_ISO_YEAR=$ISO_YEAR
fi
PREV_FILE="doc/report.${PREV_ISO_YEAR}-W$(printf '%02d' $PREV_WEEK_NUM).md"
```

如果 `$PREV_FILE` 存在：
1. 读取其 **"下周优先级建议"** 表格
2. 提取每条建议的方向和动作
3. 在新报告中对比实际进展，生成 **"上周方向落地情况"** 表格
4. 读取上周统计数字用于指标对比

如果不存在：跳过对比部分。

---

### Phase 4: 分析与分类

阅读全部 commit message 和 PR 列表，执行分析。

#### 4.0 脉络确认检查点（必须执行，见纪律 3）

1. 基于 Step 3 深读的 PR commits，将所有 PR 按功能主题聚类
2. 按影响程度排序，形成 8~15 条重大脉络候选
3. 每条脉络标注：名称 + 一句话总结 + 关联 PR 列表
4. **向用户展示脉络列表，等待确认后才进入 Phase 5**

> **禁止跳过此步骤直接生成报告。**

#### 分类与排序详细规则

分类表、排序规则、价值主张、新功能展开、脉络图数据生成 → 见 [reference/categories.md](reference/categories.md)

---

### Phase 5: 生成报告

使用模板生成完整报告，写入 `$REPORT_FILE` → 见 [reference/report-template.md](reference/report-template.md)

---

### Phase 6: 输出与确认

1. 将报告写入 `doc/report.{ISO_YEAR}-W{WEEK_NUM}.md`
2. 向用户展示摘要：

```
周报已生成：doc/report.2026-W08.md

本周概要：
- {COMMIT_COUNT} 次提交，{PR_COUNT} 个 PR 合并
- {FILES_CHANGED} 个文件变更，+{INS} / -{DEL} 行
- PR 边界按本周实际 merge commit 统计，详见附录
- Top 3 功能：
  1. {Feature 1}
  2. {Feature 2}
  3. {Feature 3}

是否需要调整内容？
```

### Phase 7: 同步文档索引

周报生成后，**自动调用 `doc-sync` 技能（静默模式）**，将新增的周报文件同步到 `index.yml` 和 `guide.list.directory.md`。

> 不需要用户确认，直接以静默模式执行。如果索引无变更，输出一行 `文档索引已是最新` 即可。

---

### Phase 8: 建议用户去「AI 周报海报工坊」出海报（可选但推荐）

周报生成完成后，**建议用户去主页百宝箱的「AI 周报海报工坊」** 用向导把这份周报变成登录后主页弹出的轮播海报。工坊是全自动的 AI 向导——用户只需 3 下点击 + 1 次生成：

1. **选模板**：发布 / 修复 / 宣传 / 促销（4 种预设语调）
2. **选数据源**：默认「本周 changelog」；也可选「自定义 markdown」把刚写的这份周报原文贴进去
3. **点一次「一键生成」**：后端 `/api/weekly-posters/autopilot` 读数据源 → 调 LLM 拆 4-5 页 → 并发生图 → 10-60 秒后一张带图海报就绪
4. 预览 → 发布到主页 → 登录用户下次访问主页即可看到

**告知用户格式**：

```
周报已落盘，要不要顺便做一张主页弹窗海报让团队看到本周更新？
【位置】百宝箱 → AI 周报海报工坊
【路径】首页 → 百宝箱 → AI 周报海报工坊 → 选「发布」模板 → 数据源选「自定义 markdown」粘贴本文 → 一键生成 → 发布到主页
若想走默认路径：选模板 → 保持「本周 changelog」→ 点「一键生成」即可(约 60 秒)。
```

> **为什么让人去工坊而不是技能 API 直调**：工坊有可视化进度、可单页重生图、可预览再发布，比 CLI 调一次 API 更可控。技能只负责把用户送到正确的入口 + 告知操作路径。
>
> 如果用户明确说「请 AI 帮我把刚写的周报直接发成海报草稿」，才走 `POST /api/weekly-posters/autopilot`（`sourceType=freeform`, `freeformContent=<报告内容>`）建立草稿，然后告知用户去工坊点生图 + 发布。

---

## 边界情况处理

浅克隆边界、无提交周、跨年周、报告已存在 → 见 [reference/edge-cases.md](reference/edge-cases.md)

## 注意事项

1. **报告语言**：全部使用中文，与现有周报保持一致
2. **PR 标题**：英文 PR 标题需翻译为简洁的中文描述
3. **价值主张风格**：从用户/团队视角描述，避免技术术语
4. **排版一致性**：严格遵循模板中的表格、分隔线、引用块格式
5. **数字准确性**：所有统计数字必须来自 git 命令输出，不可估算
6. **边界口径**：时间边界用 `%cd --date=short` 的日期文本，默认主干分支，不做时区换算
7. **PR 展示**：不要再使用 `#FIRST ~ #LAST` 作为头部或附录标题
8. **风格**：正式技术周报风格，表格中的分类 emoji 是结构标记
