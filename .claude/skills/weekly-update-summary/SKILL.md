---
name: weekly-update-summary
description: Generates weekly project reports from git history. Collects commits, PRs, and contributor data, analyzes and categorizes changes, then produces a structured Chinese-language weekly report (overview, completed items, next-week priorities) saved to doc/report.YYYY-WXX.md. Trigger words: "生成周报", "写周报", "weekly report", "本周总结".
---

# Weekly Update Summary — 自动化周报生成

每周自动从 git 历史中收集数据，分析归类后生成结构化中文周报。

## 核心纪律（必须遵守）

### 纪律 1：PR 范围从上周报告的最后一个 PR 之后开始

> **根因案例**：W10 周报仅按日期范围搜索 merge commit，遗漏了时区边界外的 PR，导致 PR 范围错误。

**正确做法**：
1. 找到上周周报文件，读取其 PR 范围（如 `#128 ~ #162`）
2. 本周 PR 从 `上周最后一个 PR + 1` 开始
3. 本周 PR 到当前 `git log --merges` 能找到的最大 PR 编号结束
4. 如果上周周报不存在，才退化为纯日期范围搜索

```bash
PREV_LAST_PR=$(grep -oP '#\d+ ~ #\K\d+' "$PREV_FILE" | head -1)
THIS_FIRST_PR=$((PREV_LAST_PR + 1))
THIS_LAST_PR=$(git log --all --merges --format="%s" | grep -oP 'Merge pull request #\K\d+' | sort -n | tail -1)
```

### 纪律 2：深读 PR 实际 commits，不信 merge commit 标题

> **根因案例**：PR #201 标题是 `remove: delete TAPD template`，但实际 25 个 commits 包含 ECharts 重构等重大功能。

**正确做法**：对每个 PR，用 `git log HASH^1..HASH^2 --oneline` 读取全部 commits，基于 commits 内容判断 PR 真实主题。

### 纪律 3：先列脉络确认，再写完整报告

> **根因案例**：直接生成完整报告，脉络分组有误，修改成本高。先列脉络候选让用户确认，一次通过。

**正确做法**：完成数据收集和 PR 深读后，**必须先向用户展示重大脉络候选列表**，等用户确认后再生成完整报告。

输出格式：
```
**W{NUM} ({DATE_RANGE}) | PR #{FIRST} ~ #{LAST} ({COUNT} 个 PR)**

### 重大脉络候选（按影响程度排序）：

1. **{脉络名}** — {一句话总结} ({相关PR列表})
2. **{脉络名}** — {一句话总结} ({相关PR列表})
...

这些脉络你觉得对吗？有哪些需要调整、合并或拆分的？
```

### 纪律 4：文件命名使用 `report.YYYY-WXX.md`

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
NEXT_MONDAY=$(date -d "$MONDAY + 7 days" +%Y-%m-%d)
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
| 2.1 | 提交总量 | `git log --oneline --since/--until` |
| 2.2 | 去重文件/行数 | **禁止** `--shortstat` 累加，用 `git diff --shortstat FIRST^..LAST` |
| 2.3 | PR 列表与深读 | 基于上周报告确定范围 + 深读每个 PR 的 commits |
| 2.4 | 贡献者统计 | `git log --format="%an"` |
| 2.5 | 提交类型分布 | 按标准前缀归类 |
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

## 边界情况处理

浅克隆边界、无提交周、跨年周、报告已存在 → 见 [reference/edge-cases.md](reference/edge-cases.md)

## 注意事项

1. **报告语言**：全部使用中文，与现有周报保持一致
2. **PR 标题**：英文 PR 标题需翻译为简洁的中文描述
3. **价值主张风格**：从用户/团队视角描述，避免技术术语
4. **排版一致性**：严格遵循模板中的表格、分隔线、引用块格式
5. **数字准确性**：所有统计数字必须来自 git 命令输出，不可估算
6. **风格**：正式技术周报风格，表格中的分类 emoji 是结构标记
