---
name: weekly-update-summary
description: 'Generates business-facing weekly project reports for executives, product managers and business owners. Aggregates git history with this week''s daily reports, CDS acceptance verdicts, defect ledger and production releases, then produces a structured Chinese-language weekly report (business value, quality gate, daily trail, evidence links, next-week priorities) saved to doc/report.YYYY-WXX.md and published as a weekly magazine edition. Trigger words: "生成周报", "写周报", "weekly report", "本周总结".'
---

# 自动化周报生成

> **版本**：v2.0.0 | **状态**：已落地 | **触发**：`/weekly`、"生成周报"、"写周报"、"weekly report"、"本周总结"

按可核查来源梳理一周内**本项目已采集的事实**（git 提交与 PR、每日日报、验收结论、缺陷台账、线上发布）聚合成一份**面向老板 / 产品经理 / 业务经理**的周报。

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

### 纪律 0：先重建同一事项的连续进展，再写业务解读

先按仓库 `scripts/reporting/README.md` 维护跨周期台账，沿用稳定事项 ID，把同一成果的开发、返修、验证、上线及阻塞事件关联到它。不得按每个提交、PR、日报条目重复计成果。日报是线索，不因被周报/月报引用而产生新成果。

Phase 2.7 必经连续证据采集，读取 `deliveryEvidence`，默认自动续用Git common-dir私有台账；可显式指定 `--evidence-ledger/--ledger-out`。该段不可用时明确展示证据缺口，不生成确定的成果/效率结论。使用Phase 5的 `edition.py collect/build/verify` 唯一入口，直接把事实填入原周刊模板；`evidence.py render`仅用于事实诊断，不作为最终周刊交付。

每项重要结论保留事项 ID、当前版本、上期与本期状态、来源及下一步（执行人/期限未知则待确认）。功能完成、验证完成、上线完成三个维度独立报告，合并、CI 通过、预览部署都不能替代它们。旧版本验证不能覆盖后续修改；无新事件的旧成果不再包装为新增。未解决阻塞即使本周没有提交也要延续。

效率、工时与收益只采用有单位、周期、方法、样本范围及来源的测量；缺证据写不可用，不从提交数或代码量外推。只有相邻且等长、口径一致的周期可比较。管理月度汇总使用同一台账 `--cadence monthly`，只提供事实参考；员工个人月报的评价、认可、建议及提交继续由本人完成。

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
7. **浅克隆现在由采集器自己挡**（2026-09-07 落地）：`collect_week_context.py` 启动即断言
   `git rev-parse --is-shallow-repository`，是浅克隆就 **exit 2** 并打印修法，不再往下采。
   确有理由在浅克隆上采集时加 `--allow-shallow` 显式放行，此时报告必须注明数字为下限。
   采集结果里多一段 `repoDepth` 记录本次判定。

   **闸有两个调用点，同一份判据**：Phase 2.0 用 `--check-shallow-only` 在 git 统计之前先过一次
   （否则 2.0-2.6 已经按截断值算完，闸再红也来不及）；Phase 2.7 正式采集时再自动过一次兜底。
   两处走的都是脚本里那一个 `assert_not_shallow()`，不另写第二份判据。**2.0 红过就得从 2.0 整段
   重跑**——`--unshallow` 补的是本地历史，不会回头改写你已经记下的数字。

   **2.0 的退出码三分 + 默认拒绝**：`0` 查过没问题 / `2` 查明是浅克隆 / `3` **没查成**（深度未知）／
   其余一律当作「闸没跑起来」拒绝。放行的出口只有 `0` 一个，「没查成」和「没跑成」都不许当「没问题」。
   `2` 那条补救分支跑完 `--unshallow` 后**必须重新问一次闸**——`--unshallow` 会因离线 / 鉴权 / 网络
   失败，拿「补救命令跑过了」当「问题已解决」，等于又开了一个静默放行的口子。`--allow-shallow` 是唯一的显式担责开关，两个调用点
   都认它。**两处对「没查成」的处理有意不同**：2.0 硬失败（它守的 2.0-2.6 全是深度敏感的 git 统计），
   2.7 只警告并把判定写进 `repoDepth`（采集器自己那六段数据不依赖仓库深度，在这里也硬失败只会
   让老 git 环境连不相干的数据都采不到）。

   **为什么把它写进脚本而不是写进本文档**：W33 / W34 / W35 / W36 连续四周踩同一个坑——
   容器里的 clone 只有几百个提交，提交数与逐日分布安静地少算约 11%，事后靠人工发现再
   `git fetch --unshallow` 重算。每一期报告的正文都写下了「下期应该断言」，四期无一执行。
   写进报告正文的待办没人执行，写进采集脚本才拦得住：采集是所有数字的唯一入口。
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

### 纪律 5：有来源的事实先成稿，归属歧义再澄清

在用户已经要求生成时直接完成可审阅刊物，不停在脉络提案。采用稳定事项ID、原始证据和三个独立阶段；归属不清的来源留在待归属区，不用标题相似硬合并。只有会改变任务范围的缺失信息才询问，同时完成不依赖答案的工作。

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
- 版式沿用「米多智能体周刊」的纸墨CSS、报头和地球刊徽，章节由`edition.py`填充：管理结论、风险、下一步、连续三阶段、测量依据、一周脉络、来源和活动附录。原模板样例只供版式参考，不复制其业务结论与数字。
- MD和HTML由同一事实生成；原始活动统计与事项交付数分开，未取得的数据不能写0。

**发布前核对**：

- [ ] 正文与台账经`edition.py verify`重算一致，每个重要结论有可点击来源与原文。
- [ ] 未通过/有条件来源逐条保留；无法归属事项的失败仍显示，闭环状态未知不能写已解决。
- [ ] 一周七日日报逐日挂链；缺失日期明确列出。
- [ ] 旧成果不复算新增，功能、验证、上线独立，旧验证不覆盖新修改。
- [ ] 测量缺证据写不可用，外部源缺失不等于无风险。
- [ ] HTML/MD/JSON/台账/模板摘要和精确SHA水位线属于同一bundle。

唯一发布入口见Phase 5.5，默认同日期与刊系原地更新。周报现在会读取上期和本期已核验台账续采；旧条目无台账仅作历史线索，不能声称历史完整。禁止再使用没有bundle的旧直发命令。

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
1. 从 `collect_week_context.py` 的 `acceptance` 段取本周全部报告（按带时区观测/发生时间归属Asia/Shanghai周期，不能把createdAt当实际执行时间）
2. 来源附录列出验收份数、各verdict与明确分母；报告通过率仅描述该批报告，不代替功能验证完成率
3. **每一条 `fail` 和 `conditional` 都必须单独列出**并说明影响与后续动作——这是老板最想看的一栏
4. 需要点进去的，用 `report deeplink` 取 CDS 深链（`--deeplinks` 开关）；深链需 CDS 登录，报告里注明
5. verdict 用中文口径写：`pass` = 通过、`conditional` = 有条件通过、`fail` = 未通过

**禁止**（v1 最严重的缺陷）：整份周报不提验收，或只写"已验收"三个字而不给通过率与失败清单。失败及范围限制必须在正文可见，不能仅埋进附录。

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

**唯一豁免：能力条目的「用量口径」行**（`llm:visual-agent` 这类 token）。它是机器可读契约，
是 Phase 2.7 采集器把「本周上线了什么」和「产品里有没有人用」接起来的**唯一连接键**。
不豁免的话，要么周报自查判自己不合格，要么日后有人按本纪律把这行删掉——两种都会让采用度静默失效。
写成人也读得懂的可见行（而不是隐藏注释），正是因为不可见的标签一旦漂移没人会发现。

### 纪律 12：本周产生的一切信息都要收口（六源缺一不可）

周报的覆盖面 = git + 日报 + 验收 + 缺陷/发布 + 团队与用量 + 上线采用。任一源缺失必须在 baseline 行写明"因何缺失"，不许静默省略。

| 源 | 回答什么 | 缺失时怎么写 |
|---|---|---|
| git（主干提交与 PR） | 做了什么 | 不可缺，缺则整个周报不成立 |
| 日报知识库 | 每天发生了什么 | 「日报源不可达：<原因>，本周脉络仅据 git 重建」 |
| CDS 验收中心 | 做完的验没验过 | 「验收源不可达：<原因>，本周质量结论无法给出」 |
| 缺陷台账 + 正式发布台账 `/api/releases/runs` | 质量趋势与是否真发出去 | 「缺陷/发布源不可达：<原因>」 |
| MAP 团队洞察 `/api/executive/team-insights` | 谁做的、团队健不健康、AI 花了多少钱 | 「团队洞察不可达：<原因>，本周无人力与成本视角」 |
| 采用度 `/api/executive/adoption` | 前几周说上线的能力，这周有没有人用 | 「采用度不可用：<原因>」；无标签周次单独列，**不是**采用率 0 |

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

**开跑前先过浅克隆闸（必须在 2.0 那条 `git log` 之前）**：2.0-2.6 全部是 git 统计，浅克隆会让它们
安静地少算。闸放在 Phase 2.7 的采集器里太晚——那时候提交数、逐日分布已经按截断值算完了。
所以在任何 git 统计之前先跑一次：

```bash
gate() { python3 .claude/skills/weekly-update-summary/scripts/collect_week_context.py --check-shallow-only "$@"; }
# 明知浅克隆、或深度查不动却仍要采集时，用它显式担责（报告须注明提交类数字为下限）：
#   gate --allow-shallow && echo "已担责放行"

gate; rc=$?
if [ "$rc" -eq 2 ]; then                                   # 查明是浅克隆：补历史，然后重新验
  git fetch --unshallow || { echo "git fetch --unshallow 失败（离线 / 鉴权 / 网络），深度仍不足，停。" >&2; exit 1; }
  gate; rc=$?                                              # 不许假设补救成功——补完再问一次闸
fi

if [ "$rc" -eq 0 ]; then                                   # 唯一放行出口
  echo "仓库深度已确认，可以开始 2.0"
else
  echo "浅克隆闸未放行（退出码 $rc）。3=没查成；其它=闸自己没跑起来（python 缺失 / 被杀 / 崩溃）。停。" >&2
  exit 1
fi
```

**两条都是「不假设」**：

1. **默认拒绝——只有 `0` 放行，其余一律停。** 早先写成 `case` 且漏了 `*)` 分支时，bash 在没匹配上
   任何分支的情况下是**成功**退出的，于是「闸自己没跑起来」被当成了通过。所以这里不写白名单式的
   逐码判断，只留一个放行出口，将来再多出什么退出码也不会变成静默通过。
2. **补救之后必须重新验，不能拿「补救命令跑过了」当「问题已解决」。** `git fetch --unshallow` 会因
   离线、鉴权、网络抖动而失败，而写成 `&& echo ...` 时失败只是让那句提示不打印，脚本照样往下走进
   2.0，产出的正是这道闸要防的截断数字。补完再问一次闸，让**状态**而不是**动作**决定能不能放行。

**退出码必须分流，不能只判「非零」**：`0` 是查过没问题、`2` 是查明浅克隆、`3` 是**没查成**
（git 失败、超时、或老于 2.15 的 git 不认这个 flag）。把 3 当成 0 放行，闸就会在查不动的时候
安静通过；把 3 当成 2 去 `--unshallow`，则是在拿一个没成立的判断做补救动作。真要在深度未知
或已知浅克隆的情况下采集，用 `--allow-shallow` 显式担责——它在 2.0 和 2.7 都生效，此时报告
必须注明提交类数字为下限。

**它红过之后，2.0-2.6 必须整段重跑**：`git fetch --unshallow` 只补全了本地历史，不会回头
改写你已经记下来的数字。只重跑采集器（2.7）而留着 2.0-2.6 的旧值，正是这道闸要防的那种
「一半新一半旧」的报告。

**命令速查**：

| 步骤 | 目的 | 关键点 |
|------|------|--------|
| 2.0 | 边界准备 + **浅克隆闸** | 默认主干 + `MONDAY/SUNDAY` 日期字符串；**闸必须排在这一步的 `git log` 之前**；退 2 就先 unshallow 再从 2.0 整段起跑 |
| 2.1 | 提交总量 | `git log "$DEFAULT_BRANCH" --date=short` + 日期文本过滤 |
| 2.2 | 去重文件/行数 | 禁止 `--shortstat` 累加，用 `git diff --shortstat FIRST^..LAST` |
| 2.3 | PR 列表与深读 | 只取本周实际 merge 到主干的 PR |
| 2.4 | 贡献者统计 | 从本周 commit 集合提取 author |
| 2.5 | 提交类型分布 | 从本周 commit 集合按标准前缀归类 |
| 2.6 | 每日提交分布 | 标注每天重点方向 |

---

### Phase 2.7: 采集关联产物（日报 / 验收 / 缺陷 / 发布 / 团队 / 采用）—— v2 新增，不可跳过

git 只知道代码，回答不了纪律 9/10/12 的问题。本阶段用采集器把另外五类事实拉齐：

```bash
python3 .claude/skills/weekly-update-summary/scripts/collect_week_context.py \
  --week-start "$MONDAY" --week-end "$SUNDAY" \
  --prev-week-hint "${PREV_ISO_YEAR}-W$(printf '%02d' $PREV_WEEK_NUM)" \
  --evidence-ledger "$LEDGER" \
  --deeplinks \
  --out /tmp/week-context-${ISO_YEAR}-W${WEEK_NUM}.json --human
```

**若 Phase 2.0 是靠 `--allow-shallow` 担责放行的，这条命令也必须带上 `--allow-shallow`**，否则采集器
会在这里重新断言、以退出码 2 停下，整条「明知浅克隆也要采」的路径走不完。担责是一次性的决定，
两个调用点要一致；此时报告必须注明提交类数字为下限。

采集器输出（每段独立降级，失败只标 `available:false`，不阻断周报）：

| 段 | 内容 | 用在报告哪里 |
|----|------|-------------|
| `dailyReports` | 本周逐日日报：日期 / 标题 / 匿名分享深链 / 缺失日期清单 | 一周脉络逐日挂链（纪律 9） |
| `acceptance` | 本周验收报告：标题 / verdict / tier / PR 号 / 通过率 / 深链 | 质量闸 + 未通过清单（纪律 10） |
| `defects` | 本周新报缺陷 + 存量未关 + 平均解决时长 | 质量闸趋势行 |
| `releases` | 正式发布 run：尝试 / 成功 / 失败 / 成功率 | 质量闸交付行 |
| `previewDeploys` | 分支预览产生的不可变部署版本数 | 仅附录参考，**禁止**写成「线上发布」 |
| `prevWeekly` | 上周周报条目（供落地对照引用） | 上周方向落地对照 |
| `teamInsights` | 规则判定的头条 + 逐人产出/质量/积压/调用/成本 + 关注项 | 团队与用量（含质量闸的积压分布行） |
| `adoption` | 前 N 周能力条目的用量口径 token → 本周实际用量（五态） | 上线 → 采用；`unlabeledWeeks` 必须显式列出 |

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

### Phase 4: 连续事项与来源核对

先读取Phase 2.7实际采集的`deliveryEvidence.ledger/report`。正文只采用这些事实；日报原文、PR、验收与正式发布均保留直接来源与完整版本。标题相似不自动关联，短SHA、verdict或预览不能推出功能完成或正式上线。

风险、失败和外部阻塞优先。同功能多次修复只显示同一事项本期变化；旧成果没有新证据时写延续，不重新当新增。禁止从每日提交分布推“停摆”“效率稳定/提升”，无测量时标不可用。业务解读若缺独立来源保持待核实，不硬凑5~8条能力，也不让语言模型覆盖事实状态。

### Phase 5: 原周刊模板的唯一生成入口

不再把手写摘要粘到静态HTML样例里。`edition.py`实际读取`reference/report-template-html.html`的CSS、MAP报头与地球刊徽，并由同一事实生成MD与HTML：

```bash
REPORT_WORK=$(mktemp -d /tmp/project-weekly.XXXXXX)
python3 scripts/reporting/edition.py collect \
  --start "$MONDAY" --end "$SUNDAY" --cadence weekly \
  --mainline "$DEFAULT_BRANCH" --git-head "$BASELINE_SHA" \
  --base "$MAP_BASE" --impersonate "$REPORT_USER" --project "$PROJECT" \
  --out "$REPORT_WORK/context.json"
python3 scripts/reporting/edition.py build \
  --context "$REPORT_WORK/context.json" --start "$MONDAY" --end "$SUNDAY" \
  --cadence weekly --out "$REPORT_WORK/edition"
python3 scripts/reporting/edition.py verify --bundle "$REPORT_WORK/edition/bundle.json"
```

`DEFAULT_BRANCH`必须是已fetch的`origin/<默认主干>`，`BASELINE_SHA`固定同一SHA。原Phase2的Git日期文本统计仅作活动附录；事项事实/非Git源按带时区实际时间与Asia/Shanghai归桶。原始PR对象可用`--pull-requests`输入；已核查的产物关联可用`--evidence-input`，不猜标题。采集器默认在Git common-dir私有路径持久化台账，自动合并本期和上期已发布台账；可用`--ledger-out`显式指定仓库外文件。

输出`report.html/report.md/report.json/ledger.json/context.json/bundle.json`。报头下是管理结论、风险与下一步、三阶段连续进展、效率/工时/收益证据、七日日报脉络、来源索引和六源活动附录。缺证据不报0，无提交仍须延续未闭环事项。历史样例中的业务数字不得复制到本周。

MD底稿需要入库时只复制已核验的`report.md`到既有`$REPORT_FILE`，保留输入摘要、范围、来源及台账基线；不另写一套结论。

### Phase 5.5: 由原知识库发布器核验发布

```bash
# 实现、回归或任务禁止生产发布时，使用只读本地展示：
python3 scripts/reporting/edition.py publish --bundle "$REPORT_WORK/edition/bundle.json" --local
# 用户已授权发布周刊时：
python3 scripts/reporting/edition.py publish --bundle "$REPORT_WORK/edition/bundle.json" \
  --base "$MAP_BASE" --impersonate "$REPORT_USER"
```

这条入口调用原`daily-report-summary/reference/publish.py`，默认「周报知识库」/`kind=weekly-report`，同日原地复用条目。发布前重新核验原模板、正文及事实文件；正文读回一致后才写`deliveryEvidenceLedger/deliveryEvidenceDigest`与采集水位线，并再次读回。失败pending条目不能成为下期检查点。篡改正文、日期、台账或SHA后不允许仅改hash冒充通过，必须重建。

此前纪律8的直接发布命令仅供理解旧参数，不再作为新刊物入口；缺bundle只能显式标记为历史未核查重发。正文和台账必须同源，不能把模型新增句子混入已核验刊物。

### 项目管理月度汇总

仓库目前没有独立月报技能；本技能支持把同一项目台账按自然月汇总，使用上面相同collect/build入口的`--cadence monthly`与月初/月末日期。采用太阳刊徽，按事件实际日期重新归属，不能把四份周报相加为四份新成果。历史范围不足时明确来源截止时间，不能称完整月份。

发布刊系为`project-monthly-report`，默认「项目月度汇总知识库」。它是管理事实参考；员工个人月报的评价、认可、建议和提交继续由本人完成，不调用员工报告API。若用户指的是其他月报技能，先定位该技能再复用事实契约。

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

### Phase 6.5: 定时任务模式下的通知纪律

本技能常由定时任务无人值守触发。那种模式下，**整轮只发一条推送**：

- 发在「出现了需要人拍板的事」那一刻，把当时已知的结论与最终状态一并写进去；
- 合并成功、CI 变绿、评审收敛这类进度**本身不值得单独响一次**——它们只是过程；
- 只有中途冒出必须人介入的新情况（合并被卡、评审提出判断不了的分歧、任务根本跑不起来）
  才允许追加第二条；
- 整轮没有需要人决定的事，就**一条都不发**。

> **背景**（2026-09-06 W36 那轮）：先在 PR 评审迭代期间发了一条（认证迁移 09-17 到期，
> 有硬期限，该发），合并后又发了一条完成通知——第二条的绝大部分内容与第一条重复，
> 唯一新信息是「已合并」。用户当场问「为什么要给我发 3 条信息？你处理了三次吗？」。
> 通知是打断，重复的打断会累积成噪音，把真正该看的那条淹掉。

---

### Phase 7: 同步文档索引

周报生成后，**自动调用 `doc-sync` 技能（静默模式）**，将新增的周报文件同步到 `index.yml` 和 `guide.list.directory.md`。

> 不需要用户确认，直接以静默模式执行。如果索引无变更，输出一行 `文档索引已是最新` 即可。

---

### Phase 7.5: 保留范围

生成周刊只读取changelog作为线索，不顺带合并碎片、修改CHANGELOG或执行发布。此类工作必须由用户单独授权的发布/归档流程处理。

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
6. **边界口径**：原Git活动附录保留`%cd --date=short`文本口径；连续事项、验收等带时区事件按Asia/Shanghai归属，createdAt仅为观测时间，日报dailyDate为刊物日期
7. **PR 展示**：不要再使用 `#FIRST ~ #LAST` 作为头部或附录标题
8. **风格**：正式周刊风格，分类与结论用文字分级 + 语义色，禁止使用 emoji
9. **不许只报喜**：验收未通过、缺陷零改善、连续顺延项，都必须写进正文并给下一步——这是业务读者判断"该不该介入"的唯一依据
10. **六源缺一要声明**：日报 / 验收 / 缺陷 / 发布 / 团队洞察 / 采用度任一不可达，在 baseline 行写明原因（纪律 12），禁止静默省略
11. **不可用 ≠ 0**：`available=false` 只能写「数据不可用 + 原因」，只有 `available=true && attempts=0` 才写「本周未发布」（纪律 12）
12. **发布口径固定走正式发布台账**：`releases` 段来自 `/api/releases/runs`，与分支预览部署（`previewDeploys`）是两码事，禁止把预览次数写成"上线次数"
