---
name: weekly-update-summary
description: Generates weekly project reports from git history. Collects commits, PRs, and contributor data, analyzes and categorizes changes, then produces a structured Chinese-language weekly report (overview, completed items, next-week priorities) saved to doc/report.YYYY-WXX.md. Trigger words: "生成周报", "写周报", "weekly report", "本周总结".
---

# 自动化周报生成

> **版本**：v1.0.0 | **状态**：已落地 | **触发**：`/weekly`、"生成周报"、"写周报"、"weekly report"、"本周总结"

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

### 纪律 2：统计基线必须是 `origin/<DEFAULT_BRANCH>`，不是本地分支也不是 HEAD

> **根因案例 v1**：`--all` 会把未合并分支、WIP merge、临时调试分支和历史噪声一起统计进去，导致"研发活动周报"和"主干落地周报"混淆。
>
> **根因案例 v2（2026-06-07）**：上周 EtJga 分支当天写 W22 周报时，技能跑在该分支 checkout 上，`git log "$DEFAULT_BRANCH"` 用了本地 `main`（未 fetch 最新）/ 或当前 checkout 的 EtJga 分支，结果把 EtJga 分支独有的 #663 / #668 / #669 / #673 / #674 / #681 / #683 / #687 / #698 等"未合 main"的 PR 全算进了 W22 主干，导致同一周（W22）由两次 session 跑出**192 提交 / 33 PR vs 250 提交 / 24 PR**两套不一致结果。

**正确做法**：
1. **检测默认主干分支**：
   ```bash
   DEFAULT_BRANCH=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
   DEFAULT_BRANCH=${DEFAULT_BRANCH:-main}
   ```
2. **强制 fetch 一次**（无网络重试 4 次指数退避，参考 git-fetch/pull 规则）：
   ```bash
   git fetch origin "$DEFAULT_BRANCH" --quiet
   ```
3. **所有后续 `git log` / `git diff` / `git show` 必须以 `origin/$DEFAULT_BRANCH` 为基线**，不允许使用 `$DEFAULT_BRANCH`（本地分支）/ `HEAD` / 当前 checkout 分支：
   ```bash
   # 正确
   git log "origin/$DEFAULT_BRANCH" --format="%cd%x09%H%x09%an%x09%s" --date=short

   # 错误（用本地分支，可能落后于远端 / 用错分支）
   git log "$DEFAULT_BRANCH" ...
   git log main ...
   git log ...   # 默认走 HEAD
   ```
4. **禁止** `git log --all ...`
5. **判定脚本**（生成报告前自查）：
   - 我执行了 `git fetch origin <DEFAULT_BRANCH>` 吗？
   - 我所有 `git log` / `git diff` 都加了 `origin/` 前缀吗？
   - 我手头的 `origin/main` HEAD commit 与远端最新一致吗？（再 fetch 一次比对 SHA）
6. **冷启动场景**：在浅克隆（shallow clone）下，PR 的 merge commit 父级可能未拉取，需要 `git fetch origin --deepen=500` 或更多直到能解析所有 W 内 PR 的 `merge_commit_sha^`
### 纪律 3：PR 边界按"本周实际落地 origin/<DEFAULT_BRANCH> 的 PR"判断，不按 PR 编号连续段、不信 GitHub `mergedAt`

> **根因案例 v1**：本仓库存在"低编号 PR 晚于高编号 PR 合并"的情况。如果用 `#FIRST ~ #LAST` 当周边界，会把跨周 PR 和下周 PR 一起卷进来。
>
> **根因案例 v2**：仅靠 `git log --merges` 会漏掉 fast-forward merge 到 `main` 的 PR，例如 PR #396 这种"已落地主干、但没有 merge commit"的情况。
>
> **根因案例 v3（2026-06-07）**：GitHub `mergedAt` 是 PR 在 GitHub 上的合并时间（UTC，含时区），可能与本地 main 上 merge commit 的 `%cd --date=short`（本地时区）**跨日**。例如 PR #698 GitHub `mergedAt = 2026-05-31 23:50 UTC` 但 main 上 merge commit `commit date = 2026-06-01`，按 mergedAt 算进 W22 / 按 commit date 算进 W23。统一规则：**只信 commit date，不信 GitHub mergedAt**。

**正确做法**：
1. **PR 身份**：先用 GitHub API 拿候选 PR 列表（`base = DEFAULT_BRANCH` 且 `merged = true`）
2. **二次校验**：对每个候选 PR，用 `git log "origin/$DEFAULT_BRANCH" --grep="#<PR_NUM>" --format="%H"` 或解析 PR 的 `merge_commit_sha` 在 `origin/$DEFAULT_BRANCH` 上是否可达：
   ```bash
   git merge-base --is-ancestor "$MERGE_SHA" "origin/$DEFAULT_BRANCH" && echo "yes" || echo "no"
   ```
   `no` = 这个 PR 没真正落到主干，**不计入**
3. **周归属**：以**本地 `origin/$DEFAULT_BRANCH` 上 merge commit 的 `%cd --date=short`** 为准（不是 GitHub mergedAt）：
   ```bash
   git show -s --format="%cd" --date=short "$MERGE_SHA"
   ```
4. 同时覆盖三种落地方式：merge commit / fast-forward merge / rebase merge / squash merge
5. 只在 GitHub API 完全不可用时，才退化为 `git log "origin/$DEFAULT_BRANCH" --first-parent --merges`
6. 附录列出**本周实际 PR 集合**，每条带 PR 号 + 本地 commit date + 标题
7. 头部和附录标题**不要**再写 `#FIRST ~ #LAST`
8. **判定脚本**（生成报告前自查）：
   - 我每个 PR 都跑了 `git merge-base --is-ancestor` 验证它在 `origin/$DEFAULT_BRANCH` 上吗？
   - 我用的"本周日期"是本地 commit date，不是 GitHub mergedAt 吗？
   - 我的 PR 总数 = `comm -12 <(github_prs.sort) <(local_main_merges.sort) | wc -l`?

### 纪律 3.5：同一周两次跑必须出同一份报告（幂等性）

> **根因案例（2026-06-07）**：同一周 W22 由两个 session（5-31 EtJga、6-07 MV3AY）分别跑，结果是 192/33 vs 250/24 两套，脉络也部分不一致。根因 = 当时 `origin/main` 状态不同 + 老 session 把 EtJga 分支独有 PR 当成 main PR。

**正确做法**：
1. 跑技能时**记录当时 `origin/<DEFAULT_BRANCH>` 的 HEAD SHA**，写进报告头部
2. 同一周再跑时，必须**对比 SHA**：
   - 若 SHA 相同 → 报告应字符级一致（除文风差异）
   - 若 SHA 不同（main 又前进了几个 commit）→ 新报告头部必须标注"基线漂移：从 `OLD_SHA` 推进到 `NEW_SHA`，新增 N 个 commit"，并列出新增 commit 是否影响 W 内统计
3. 报告头部增加"统计基线"段：
   ```markdown
   > **统计基线**：`origin/main @ <SHA前7位>`（采集时间 `YYYY-MM-DD HH:MM UTC`）
   > **与上次跑同周报告的差异**：`OLD_SHA` → `NEW_SHA`，本次新增 N 个 commit 影响本周统计
   ```
4. 这样任何人重跑都能定位"差异是真改了还是基线漂移了"

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

### 纪律 7：同一周已有报告时，必须先读对照再覆盖

> **根因案例（2026-06-07）**：检测到目标周报告已存在时，技能 Phase 1 默认走"已存在 → 跳过 / 询问"，但 Phase 1.5 空缺补齐分支并未做这一步——如果某个分支已经写过该周报告（即使没合 main），新一次跑会直接覆盖而不对照，导致脉络叙事被悄悄替换。

**正确做法**：
1. 写报告前，先 `git log --all --format="%H %s" -- "doc/report.${ISO_YEAR}-W${WEEK_NUM}.md" | head -5` 找历史版本（任何分支）
2. 若存在历史版本，先 `git show <SHA>:doc/report.${ISO_YEAR}-W${WEEK_NUM}.md` 读出来
3. 对比新数据 vs 历史脉络分类：
   - 历史里的脉络如果在新数据基线上**仍然成立**（PR 在 `origin/main` 上可达） → 必须保留
   - 历史里的脉络如果**已不在新基线上**（PR 在孤儿分支） → 在报告里标"已废弃 / 仅历史分支可见"
   - 历史里**没有**但新基线里**有**的脉络 → 新增
4. 报告头部追加一行："**历史版本对照**：本周报告曾在 `<ORPHAN_BRANCH>` 出现过版本，本次基于 `origin/main` 重写并合并/废弃历史脉络"

这样避免"同一周由不同 session 写出两份不一致报告而无人察觉"。

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

### Phase 1.5: 检查历史空缺周次（盲区补丁）

> **背景**：2026-05-09 用户反馈 "17、18 不见了"——周报技能 Phase 1 只算"本周该不该写"，不查 doc/report.* 找最近一份，导致 W17 W18 连续两周空缺没人察觉。本阶段强制扫描最近 6 周，发现空缺主动询问用户。

#### 1.5.1 扫描最近 6 周

```bash
# 列出 doc/report.YYYY-WXX.md 已存在的周次
ls doc/report.*.md 2>/dev/null | grep -oE 'report\.[0-9]{4}-W[0-9]{2}' | sort -u > /tmp/existing_weeks.txt

# 计算最近 6 周（包括目标周）应有的周次
for i in 0 1 2 3 4 5; do
  CHK_DATE=$(date -d "$MONDAY - $((i * 7)) days" +%Y-%m-%d)
  CHK_YEAR=$(date -d "$CHK_DATE" +%G)
  CHK_WEEK=$(date -d "$CHK_DATE" +%V)
  echo "report.${CHK_YEAR}-W${CHK_WEEK}"
done | sort -u > /tmp/expected_weeks.txt

# 找出空缺
comm -23 /tmp/expected_weeks.txt /tmp/existing_weeks.txt > /tmp/missing_weeks.txt
```

#### 1.5.2 处理空缺

如果 `/tmp/missing_weeks.txt` 非空（且不只包含本次目标周）：

```
检测到最近 6 周内有 N 个周报空缺：
- report.2026-W17（2026-04-20 ~ 2026-04-26）
- report.2026-W18（2026-04-27 ~ 2026-05-03）

是否在生成本周（W19）周报的同时补齐这些空缺？
[Y] 全部补齐（推荐，每周一次性同步）
[N] 只生成本周
[S] 选择性补齐（让我选）
```

**选择 Y 时**：用并行子智能体逐周补齐（每周走完整 Phase 2-5 流程），最后由父智能体统一同步索引 + commit。

**选择 N 时**：跳过补齐，但在最终输出里**显式提醒** "本次只生成 W19，历史 W17/W18 仍空缺，建议下次手动跑 `/weekly` 补齐"。

#### 1.5.3 不要静默跳过

**禁止**没有发现空缺就跳过；必须在输出里说一句"已扫描最近 6 周，无空缺"或"发现 N 个空缺，已按用户选择处理"。让用户知道这个盲区已被覆盖。

---

### Phase 2: 数据收集

依次执行 6 组 git 命令收集原始数据 → 见 [reference/data-collection.md](reference/data-collection.md)

**命令速查**：

| 步骤 | 目的 | 关键点 |
|------|------|--------|
| 2.0 | 边界准备 | 默认主干 + `MONDAY/SUNDAY` 日期字符串 |
| 2.1 | 提交总量 | `git log "$DEFAULT_BRANCH" --date=short` + 日期文本过滤 |
| 2.2 | 去重文件/行数 | 禁止 `--shortstat` 累加，用 `git diff --shortstat FIRST^..LAST` |
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

### Phase 7.5: 归档本周 changelog 碎片到 CHANGELOG.md

> **背景**：`changelogs/` 目录里每个 PR 提交时落一个碎片（CLAUDE.md 规则 4），原本只在 `release-version` 技能发版时才合并。但发版节奏 ≠ 周报节奏，过去出现过 19 天积压 353 个碎片的情况。本阶段把"归档"和"周报"对齐，杜绝积压。
>
> **判定**：仅当 `changelogs/` 目录存在且至少有 1 个匹配 `^[0-9]{4}-[0-9]{2}-[0-9]{2}_*.md` 格式的碎片文件时执行；否则跳过本阶段。

#### 7.5.1 预检（dry-run）

```bash
# 先 dry-run 显示将合并多少碎片，给用户一个数量预期
bash scripts/assemble-changelog.sh --dry-run 2>&1 | head -3
```

如果脚本输出"没有碎片文件需要合并"，**跳过 7.5.2 / 7.5.3**，直接进 Phase 8。

#### 7.5.2 真正合并

```bash
bash scripts/assemble-changelog.sh
```

脚本行为：
1. 扫描 `changelogs/*.md`
2. 按文件名日期分组
3. 在 `CHANGELOG.md` 的 `## [未发布]` 段顶部插入 `### YYYY-MM-DD` 块（按日期降序）
4. `git rm` 已合并的碎片文件

#### 7.5.3 输出与提示

合并完成后，向用户输出一行精简反馈：

```
已归档 N 个 changelog 碎片到 CHANGELOG.md [未发布]（待下次发版 promote 成正式版本号）
```

注意事项：
- **不要 commit**：本阶段只修改文件，由用户/外层流程统一 commit（与 Phase 5 / Phase 7 输出一致）
- **不要按周过滤**：当前 `assemble-changelog.sh` 是无差别合并所有积压。若想精确按本周过滤，需要先扩展脚本加 `--week-start` / `--week-end` 参数（属于未来优化，本阶段不做）
- **静默模式**：用户没有要求时不要询问"要不要合并"，直接执行（碎片合并是无破坏性的，最坏情况也只是 [未发布] 段长一点）

#### 7.5.4 例外情况

| 场景 | 处理 |
|------|------|
| `scripts/assemble-changelog.sh` 不存在 | 跳过本阶段，不报错 |
| `changelogs/` 目录不存在 | 跳过本阶段，不报错 |
| `CHANGELOG.md` 不存在或没有 `## [未发布]` 标记 | 脚本会报错并退出 1，本阶段输出"changelog 合并失败：CHANGELOG.md 缺 [未发布] 标记，请人工检查"，继续 Phase 8 |
| 当前在 detached HEAD 或 git rebase 进行中 | 跳过本阶段（避免污染 rebase 状态） |

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
8. **风格**：正式技术周报风格，表格中的分类标记用文字分级，禁止使用 emoji
