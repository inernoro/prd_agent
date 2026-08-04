---
name: weekly-update-summary
description: 'Generates business-facing weekly project reports for executives, product managers and business owners. Aggregates git history with this week''s daily reports, CDS acceptance verdicts, defect ledger and production releases, then produces a structured Chinese-language weekly report (business value, quality gate, daily trail, evidence links, next-week priorities) saved to doc/report.YYYY-WXX.md and published as a weekly magazine edition. Trigger words: "生成周报", "写周报", "weekly report", "本周总结".'
---

# 自动化周报生成

> **版本**：v2.0.0 | **状态**：已落地 | **触发**：`/weekly`、"生成周报"、"写周报"、"weekly report"、"本周总结"

把一周内**本项目产生的全部事实**（git 提交与 PR、每日日报、验收结论、缺陷台账、线上发布）聚合成一份**面向老板 / 产品经理 / 业务经理**的周报。

## 读者是谁（决定一切写法，v2 最重要的一条）

**读者不是工程师。** 他们不读代码、不认识 `llmgw` / `RawGatewayUsageParser` / `ensureOpen`，也不关心哪个文件改了几行。他们问的永远是这四个问题：

| 读者的问题 | 周报里必须能直接答上 | 数据来源 |
|---|---|---|
| 这周到底做成了什么，用户/客户能多干什么了？ | 业务价值看板（能力口径，不是文件口径） | git + 日报 |
| 做完的东西验了没有？靠谱吗？ | 质量闸（验收通过率、未通过项、缺陷） | CDS 验收中心 + 缺陷台账 |
| 每天都在忙什么？ | 一周脉络 + 逐日日报深链 | 日报知识库 |
| 上周说要做的，做到了吗？下周做什么？ | 落地对照 + 下周优先级 | 上周周报 |

**判定口诀：把周报给一个没进过代码仓库的人看，他能不能独立答出上面四问？** 不能 → 不合格，回去改。

> v1 的失败模式（2026-07-29 用户反馈）："非技术人员看得一脸蒙蔽，完全不懂本周的细节步骤，包括验收报告，本周产生的一切信息，周报其实都应该囊括进去。" 根因：v1 只有 git 一个数据源，且叙事按「模块/PR」组织而非按「业务能力」组织。v2 补齐四源聚合 + 业务优先叙事 + 术语翻译。

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

### 纪律 8：读者交付默认 html 周刊版，doc/ 的 md 是机器底稿

周报有两个产物，职责不同、**都要产出**：

| 产物 | 模板 | 去向 | 角色 |
|------|------|------|------|
| **html 周刊版（读者交付，默认）** | `reference/report-template-html.html` | 知识库「周报知识库」（`daily-report-summary/reference/publish.py --report-html --store 周报知识库`），出分享链 | 用户实际阅读的版本（用户 2026-07-07 指定：不再让人读 md 版式） |
| md 底稿 | `reference/report-template.md` | `doc/report.YYYY-WXX.md` | 机器底稿：Phase 1.5 空缺扫描、Phase 3 上周对比、doc-sync 索引、幂等对照都依赖它，**不可省** |

html 周刊版硬约束（publish.py `--report-html` 发布前校验，与日报同一套）：
- **自包含**：内联 CSS，无外部 http 资源；图片仅允许知识库 upload 返回的站内 URL
- **禁 `<script>`**：知识库沙箱 iframe 不给 allow-scripts，动效一律纯 CSS
- **必带 `<meta viewport>`**：否则移动端按 980px 桌面视口缩放、整页变小
- **禁 `data:image`**：插图一律内联 `<svg>`、图表纯 CSS
- **`<a href>` 导航链接允许**（不是加载型资源）：日报深链与验收报告深链都靠它，是 v2 的关键载体
- **每个 `<a href>` 必须带 `target="_blank" rel="noopener noreferrer"`**（血泪，2026-07-29）：
  知识库把正文渲染在**自增高的 sandbox iframe** 里（`FilePreview.tsx`，父页用 ResizeObserver
  持续把 iframe 高度跟内容同步）。链接若不开新标签，点击会**在这个 iframe 内导航**到整个 MAP SPA，
  而 SPA 是 `100vh` 布局——内容高度反过来依赖 iframe 高度，与自增高逻辑互相喂高，
  ResizeObserver 每帧触发一次，主线程被打满，**整页卡死**（用户实测控制台 210 条
  `ResizeObserver loop completed with undelivered notifications`，间隔 16ms）。
  阅读器侧已加父页点击拦截兜底（`FilePreview` 一律新标签打开），但**生成端仍必须写 target**：
  周刊在知识库之外（分享页、下载后本地打开）没有那层兜底。
- 版式即「米多智能体周刊」（刊系归属见 `.claude/rules/report-design-system.md`）。**v2 章节顺序**：刊头 + 期号 dateline + 统计基线行 + 封面故事 + **质量闸**（四宫格 + 类别拆分表 + 未通过清单 + 提醒 callout）+ **业务价值看板**（`.cap` 卡片，六段式）+ 一周脉络（逐日挂日报深链）+ 上周方向落地对照 + 下周优先级三卡 + **术语表** + 附录 A 验收表 + 附录 B PR 表 + 附录 C 工程数据页脚
- verdict 三色是 v2 新增语义色，勿改：`--green` 通过 / `--amber` 有条件通过 / `--red` 未通过
- 内容与 md 底稿同源同数（纪律 5：数字全部来自 git 与 Phase 2.7 采集器），格式只改皮不改骨
**防漏数据对账清单（html 周刊版成稿后、发布前逐项打勾；任一不过不许发布）**：

- [ ] **附录 A 验收表列全**：行数 = 头部「验收份数」，每行带结论徽章 + 类别 + 深链（禁止节选）
- [ ] **附录 B PR 表列全**：行数 = 头部「PR 收口」数（禁止节选、禁止"以 doc 为准"糊弄），带「分类」列，表下注明归属口径
- [ ] **质量闸每个数字都能在 `collect_week_context.py` 输出里找到出处**，未通过与有条件通过逐条列出且每条有「下一步」
- [ ] **一周脉络 7 天齐全**，每天挂当天日报可点击深链；缺日报的天有明确说明（纪律 9）
- [ ] **每条业务能力都标了验收背书**（通过 / 有条件通过 / 未通过 / 本周未验收），「本周未验收」的要显著标注为证据空白
- [ ] **正文无未翻译的英文缩写、文件名、类名、函数名**；出现的内部代号都能在术语表里查到（纪律 11）
- [ ] md 底稿「业务价值看板」的每一条都能在 html 的 `.cap` 卡片里找到对应（逐条指认，不得因版面丢条）
- [ ] 下周优先级每条为「动作——依据」两段式；与上周落地对照、md 底稿同数同结论
- [ ] baseline 行含统计基线 SHA + 采集时间 + **四源可用性说明**；触发纪律 3.5/7 时追加基线漂移 / 历史版本对照行

- 发布命令（复用日报发布脚本的刊系参数）：

```bash
# BASELINE_SHA 必须在这里先取值 —— 它就是报告头部「统计基线」那个 SHA，同一个值两处用。
# 不先赋值直接引用，shell 会展开成空串，而 publish.py 对 weekly-report 允许空 --last-commit
# 且只打一行告警，于是「发布成功但元数据没写上」，看不出问题（Codex #1319 P1）。
BASELINE_SHA=$(git rev-parse "origin/${DEFAULT_BRANCH}")

python3 .claude/skills/daily-report-summary/reference/publish.py \
  --base https://main-prd-agent.miduo.org \
  --impersonate inernoro \
  --title "周报-${ISO_YEAR}-W${WEEK_NUM}-本周纵深" \
  --daily-date "${MONDAY}" \
  --report-html /tmp/weekly-${ISO_YEAR}-W${WEEK_NUM}.html \
  --store "周报知识库" --kind weekly-report --tags "周报,本周纵深" \
  --replace-same-date \
  --last-commit "${BASELINE_SHA}"
# --replace-same-date：同一周重跑（补数据 / 改结论 / 修错字）时**原地更新**那条，
#   不叠第二篇。缺了它，每重跑一次就在库里多一条同周周刊，读者不知道该信哪篇。
#   匹配键是 dailyDate(=MONDAY) + kind(=weekly-report)，故只会命中同一周的周刊，不会误伤别周。
#   这是本命令里**唯一有实际保护作用**的开关。
# --last-commit：**只是出处记录（provenance），不是水位线**。周报侧目前没有任何消费方读它——
#   `collect_week_context.py` 的 collect_prev_weekly 只返回上期标题与 entryId，
#   唯一的水位线读取方 coverage_window.py 跑在**日报**的 store + kind 上。所以它今天的作用
#   仅是「把这期基于哪个 SHA 算的」写进条目元数据备查，**不能**指望它让下期自动续采
#   （Codex #1319 P2）。要真有续采能力，得先给周报侧接一个消费方，见 doc/debt.acceptance-center-cds.md。
# 无密钥 / 无文档空间时退化：加 --local --out <path>，落本地文件（仅自查，不算交付）
```

> **为什么 `--replace-same-date` 必须写死在命令里**（2026-08-02 实测）：`publish.py` 的去重是
> **opt-in**（`--replace-same-date` 是 `store_true`），日报技能的命令传了、周报技能的没传 ——
> 同一条「重跑不叠篇」的规则在两处各写一遍然后漂移了（`predicate-and-wiring-discipline.md` 形状 3）。
> 实测后果：W31 周刊发布后重跑一次，库里立刻多出一条同周周刊，只能手工 `DELETE /entries/{id}` 收拾。
> **重跑是常态**（改结论、修错字、补元数据），所以它是默认必带，不是可选项。
>
> **`--last-commit` 则不要夸大**：它今天只是出处记录，周报侧无人消费（见上方注释）。写它是为了
> 日后接续采能力时有数据可用，以及排查「这期基于哪个 SHA 算的」；把它说成「防漏采」是无根之木。

### 纪律 9：必须关联本周的每日日报（逐日，一天都不能少）

周报不是日报的替代品，是日报的**索引与拔高**。读者想知道"周三到底发生了什么"时，必须能一键点进那天的日报。

**正确做法**：
1. 跑 `scripts/collect_week_context.py`（见 Phase 2.7）拿 `dailyReports`
2. 一周脉络的**每一天**都要挂当天日报的可点击链接（`shareUrl`，匿名可达）
3. 缺哪天必须**显式写出来**：`missingDates` 非空时，在报告里写「07-25 无日报（当日仅 1 次提交）」之类的说明，**禁止装作齐全**
4. 日报链接用日期 + 标题的形式给，不要只给裸 URL

**禁止**：只在文末堆一排链接。链接必须长在对应那天的脉络里，读者读到哪天就能点开哪天。

### 纪律 10：必须关联本周的验收报告，并给出质量结论（不许只报喜）

验收是"做完的东西到底靠不靠谱"的唯一客观证据。周报必须把本周所有验收报告的**结论**摊开。

**正确做法**：
1. 从 `collect_week_context.py` 的 `acceptance` 段取本周全部报告（按 `createdAt` 日期文本落在周内）
2. 头部质量闸必须给三个数：**验收份数 / 通过率 / 未通过（fail）份数**
3. **每一条 `fail` 和 `conditional` 都必须单独列出**并说明影响与后续动作——这是老板最想看的一栏
4. 需要点进去的，用 `report deeplink` 取 CDS 深链（`--deeplinks` 开关）；深链需 CDS 登录，报告里注明
5. verdict 用中文口径写：`pass` = 通过、`conditional` = 有条件通过、`fail` = 未通过

**禁止**（v1 最严重的缺陷）：整份周报不提验收，或只写"已验收"三个字而不给通过率与失败清单。**通过率低于 80% 必须在封面故事里点名**，不许埋进附录。

### 纪律 11：业务优先叙事 —— 技术细节降级为引用，黑话必须翻译

**每一段正文先回答"这对业务意味着什么"，再（可选）说"技术上怎么做的"。**

1. **能力口径，不是文件口径**：写「模型网关现在可以正式对外发布，外部团队能直接接入」，不写「llmgw serving 收口 maintenance release shadow gate」。
2. **黑话必须翻译**：正文首次出现内部代号时，用「业务名（内部代号）」的形式。报告必须带一张**术语表**（见下表，按本周实际出现的词裁剪）：

| 内部代号 | 写给业务读者的说法 |
|---|---|
| LLM Gateway / llmgw | 模型网关（统一管理所有 AI 大模型调用的中枢，对外可独立售卖/接入） |
| CDS | 部署平台（把代码自动变成可访问的在线环境） |
| MAP / prd-agent | 本产品主系统 |
| PR | 一次代码改动的提交单元 |
| verdict / pass / fail | 验收结论 / 通过 / 未通过 |
| canary | 灰度试探（小流量先跑，确认没问题再全量） |
| 影子比对 / shadow | 新旧两套逻辑同时跑、比对结果是否一致，用于零风险切换 |
| 双主题 | 白天/夜间两套界面配色 |
| 熵减 | 文档与台账的定期清理对账 |

3. **技术细节走引用**：具体实现、字段、修复手法一律不进正文，放进「技术明细附录」或直接链接 `doc/design.*` / PR。正文提到时写「详见附录 PR 表」。
4. **每条业务价值必须能落到"谁受益"**：内部团队 / 外部客户 / 运维 / 未来可售卖能力，四选一或多选，写出来。

**判定**：正文里出现未翻译的英文缩写、文件名、类名、函数名 → 不合格。

### 纪律 12：本周产生的一切信息都要收口（四源缺一不可）

周报的覆盖面 = git + 日报 + 验收 + 缺陷/发布。任一源缺失必须在 baseline 行写明"因何缺失"，不许静默省略。

| 源 | 回答什么 | 缺失时怎么写 |
|---|---|---|
| git（主干提交与 PR） | 做了什么 | 不可缺，缺则整个周报不成立 |
| 日报知识库 | 每天发生了什么 | 「日报源不可达：<原因>，本周脉络仅据 git 重建」 |
| CDS 验收中心 | 做完的验没验过 | 「验收源不可达：<原因>，本周质量结论无法给出」 |
| 缺陷台账 + 正式发布台账 `/api/releases/runs` | 质量趋势与是否真发出去 | 「缺陷/发布源不可达：<原因>」 |

**第四源写名字时必须写「正式发布台账」，不许写成「部署版本」。** 两者是不同的东西：
任何分支部署成功后 CDS 都会生成不可变部署版本（分支预览也算），拿它当「线上发布」
会把数字吹大好几倍。baseline 行、页脚、术语表、附录**四处**的来源署名要一致——
只改数字不改署名，等于把正确的数字挂在被判定作废的来源名下，下一份周报照抄署名就又错回去。

**「不可用」和「是 0」是两回事，绝不许混写。** 采集器给的 `releases.available=false`
意味着**没测到**（台账拿不到、项目标识对不上），此时正文只能写「发布数据不可用：<reason>」；
只有 `available=true && attempts=0` 才可以写「本周未发布」。把前者写成后者，是在用一句
确定的假话替换一个诚实的空白——读者会据此认为这周没上线任何东西。
同理 `coverage.complete=false` 时，本段数字是**下限**，必须带口径说明；
`coverage.advisories` 只是提示，不改口径、也不许拿来给数字打折扣。

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

### Phase 2.7: 采集关联产物（日报 / 验收 / 缺陷 / 发布）—— v2 新增，不可跳过

git 只知道代码，回答不了纪律 9/10/12 的问题。本阶段用采集器把另外四类事实拉齐：

```bash
python3 .claude/skills/weekly-update-summary/scripts/collect_week_context.py \
  --week-start "$MONDAY" --week-end "$SUNDAY" \
  --prev-week-hint "${PREV_ISO_YEAR}-W$(printf '%02d' $PREV_WEEK_NUM)" \
  --deeplinks \
  --out /tmp/week-context-${ISO_YEAR}-W${WEEK_NUM}.json --human
```

采集器输出（每段独立降级，失败只标 `available:false`，不阻断周报）：

| 段 | 内容 | 用在报告哪里 |
|----|------|-------------|
| `dailyReports` | 本周逐日日报：日期 / 标题 / 匿名分享深链 / 缺失日期清单 | 一周脉络逐日挂链（纪律 9） |
| `acceptance` | 本周验收报告：标题 / verdict / tier / PR 号 / 通过率 / 深链 | 质量闸 + 未通过清单（纪律 10） |
| `defects` | 本周新报缺陷 + 存量未关 + 平均解决时长 | 质量闸趋势行 |
| `releases` | 正式发布 run：尝试 / 成功 / 失败 / 成功率 | 质量闸交付行 |
| `previewDeploys` | 分支预览产生的不可变部署版本数 | 仅附录参考，**禁止**写成「线上发布」 |
| `prevWeekly` | 上周周报条目（供落地对照引用） | 上周方向落地对照 |

**鉴权**：MAP 侧读 `DAILY_DOC_STORE_KEY` / `MAP_DOC_STORE_KEY` / `AI_ACCESS_KEY`；CDS 侧一律经 `cdscli`（禁止手拼 host，CLAUDE.md 规则 11）。

**强制**：采集结果里 `acceptance.tally.fail > 0` 时，这些未通过项**必须**出现在报告正文（封面故事或质量闸），不许只留在附录。

**「线上发布」只认正式发布台账**（2026-07-29 review 纠正）：任何分支部署成功后 CDS 都会生成
不可变部署版本（`cds/src/routes/branches.ts` 的 version-create），**分支预览也算在内**。拿
`deployment-version list` 当「线上发布次数」会把预览部署充成正式发布，数字虚高数倍。正式发布的
唯一台账是 `/api/releases/runs`（采集器的 `releases` 段），口径含失败重试，故要同时给
**尝试 / 成功 / 失败 / 成功率**四个数——只报成功数会掩盖发布失败率。`previewDeploys` 仅作附录参考。

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

### Phase 4: 分析与分类（v2：先业务后技术）

阅读全部 commit message、PR 列表与 Phase 2.7 的采集结果，执行分析。

#### 4.0 从「技术脉络」翻译成「业务能力」（v2 核心步骤）

v1 直接把 PR 按模块聚类就开写，产出的是工程视角。v2 必须多做一次翻译：

1. 先按功能主题把 PR 聚成技术脉络（同 v1）
2. **再把每条技术脉络翻译成一条业务能力陈述**，模板：
   > **谁**（内部团队 / 外部客户 / 运维 / 产品）现在**能做什么**（以前不能做 / 以前很麻烦），**因此**（省了什么、赚了什么、避免了什么风险）。
3. 翻译不出业务价值的脉络（纯重构 / 纯清理 / 纯文档），归入「地基工作」一段合并带过，**不占正文篇幅**，但要在附录 PR 表保留
4. 交叉验证：把翻译结果与本周日报的「新增功能」段对照，日报讲过的用户可见变化，周报不能漏

#### 4.1 脉络确认检查点

1. 按业务影响排序，形成 5~8 条**业务能力**候选（不是 8~15 条技术脉络——业务读者记不住那么多）
2. 每条标注：业务能力名 + 谁受益 + 一句话价值 + 关联 PR 列表 + 是否有验收报告背书
3. **向用户展示候选列表，等待确认后才进入 Phase 5**

> **例外（自动运行）**：用户在触发时明确说了「不用问我 / 你觉得好就好 / 自动跑」，或本次为定时任务（scheduled task）自动触发时，跳过等待确认，直接进入 Phase 5，并在最终交付消息里说明「已按自动模式跳过脉络确认」。除此之外禁止跳过。

#### 分类与排序详细规则

分类表、排序规则、价值主张、新功能展开、脉络图数据生成 → 见 [reference/categories.md](reference/categories.md)

---

### Phase 5: 生成报告

两个产物都要生成（纪律 8）：

1. **md 底稿**：使用模板生成完整报告，写入 `$REPORT_FILE` → 见 [reference/report-template.md](reference/report-template.md)
2. **html 周刊版（读者交付）**：整页复制 [reference/report-template-html.html](reference/report-template-html.html)，用本周真实数据替换周次/统计/各栏目正文，落 `/tmp/weekly-{ISO_YEAR}-W{WEEK_NUM}.html`

#### v2 章节顺序（业务优先，两个产物同构）

顺序即优先级——业务读者从上往下读，读到一半停下也已拿到关键信息：

| # | 章节 | 回答 | 数据来源 |
|---|------|------|---------|
| 1 | **本周一句话** | 老板只读这一句也不亏 | 综合 |
| 2 | **质量闸**（验收通过率 / 未通过清单 / 缺陷 / 发布次数） | 靠不靠谱、有没有真发出去 | Phase 2.7 |
| 3 | **业务价值看板**（5~8 条能力，谁受益 + 价值 + 验收背书） | 做成了什么 | Phase 4.0 翻译结果 |
| 4 | **一周脉络**（逐日 + 当天日报深链） | 每天在忙什么 | git + `dailyReports` |
| 5 | **上周方向落地对照** | 说到做到了吗 | 上周周报 |
| 6 | **下周优先级** | 接下来干什么 | 综合 |
| 7 | **术语表** | 黑话翻译（纪律 11） | 按本周出现的词裁剪 |
| 8 | **附录：验收报告清单 + PR 全量表 + 技术明细引用** | 要深挖时去哪看 | Phase 2.7 + git |

**技术细节（提交类型分布、行数、文件数、架构说明）一律降到附录**；正文只在需要佐证规模时引用一两个数字。

---

### Phase 5.5: 发布 html 周刊版到知识库

按纪律 8 的发布命令调 `daily-report-summary/reference/publish.py`（`--store 周报知识库 --kind weekly-report`），**必带 `--replace-same-date` 与 `--last-commit`**（理由见纪律 8 的命令注释：前者防重跑叠篇，后者写水位线给下一期）。发布成功后记录分享链，Phase 6 一并输出。无密钥/环境不可达时退化 `--local` 并在输出里明确说明「周刊版未发布，仅 md 底稿落盘」。

发布后自查一条：库里同一周的周刊**有且只有一条**。多于一条说明开关漏传，先删重复再交付——别把重复条目留给读者去猜哪篇是准的（这正是本周报自己在质量闸里点名的「重复归档」问题，技能自身不能犯）。

---

### Phase 6: 输出与确认

1. 将报告写入 `doc/report.{ISO_YEAR}-W{WEEK_NUM}.md`
2. 向用户展示摘要：

摘要要按**业务读者**的口径给（先结论、先质量，后规模）：

```
周报已生成：
【底稿】doc/report.2026-W30.md
【周刊版】周报知识库 · 周报-2026-W30-本周纵深
【分享链】https://<base>/s/lib/<token>?entry=<eid>

本周一句话：{一句话业务结论}

质量：
- 功能验收通过率 {X}%（{n} 份），整体 {Y}%（含每日巡检）
- 未通过 {n} 条 / 有条件 {n} 条{有 fail 时补：，其中 {说明是巡检还是功能}}
- 未关缺陷 {n}，线上发布 {n} 次

做成了什么（Top 3 业务能力）：
  1. {谁 现在能做什么}
  2. {…}
  3. {…}

关联产物：本周日报 {n} 篇（逐日挂链）、验收报告 {n} 份（逐条挂深链）
```

**禁止**在摘要里以「N 次提交 / N 个文件 / +N 行」开头——那是工程数据，业务读者看不出好坏，一律降到最后或省略。

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
2. **PR 标题**：英文 PR 标题需翻译为简洁的中文描述；内部代号（llmgw / CDS / Exchange 等）在正文里一律换成业务说法，附录里可保留原名
3. **价值主张风格**：从**业务读者**视角描述（谁受益 / 以前 / 现在 / 意味着），避免技术术语（纪律 11）
4. **排版一致性**：严格遵循模板中的表格、分隔线、引用块格式
5. **数字准确性**：所有统计数字必须来自 git 命令输出与 `collect_week_context.py`，不可估算；两者口径不同时（如日报的每日提交数含 PR 分支内提交）必须在 baseline 行说明
6. **边界口径**：时间边界用 `%cd --date=short` 的日期文本，默认主干分支，不做时区换算；验收/日报按其 `createdAt` / `dailyDate` 的日期文本落周
7. **PR 展示**：不要再使用 `#FIRST ~ #LAST` 作为头部或附录标题
8. **风格**：正式周刊风格，分类与结论用文字分级 + 语义色，禁止使用 emoji
9. **不许只报喜**：验收未通过、缺陷零改善、连续顺延项，都必须写进正文并给下一步——这是业务读者判断"该不该介入"的唯一依据
10. **四源缺一要声明**：日报 / 验收 / 缺陷 / 发布任一不可达，在 baseline 行写明原因（纪律 12），禁止静默省略
11. **不可用 ≠ 0**：`available=false` 只能写「数据不可用 + 原因」，只有 `available=true && attempts=0` 才写「本周未发布」（纪律 12）
12. **发布口径固定走正式发布台账**：`releases` 段来自 `/api/releases/runs`，与分支预览部署（`previewDeploys`）是两码事，禁止把预览次数写成"上线次数"
