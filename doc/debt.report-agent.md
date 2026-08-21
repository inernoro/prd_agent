# 周报与日报 · 债务台账

> **版本**：v1.0 | **日期**：2026-07-31 | **状态**：开发中

**一句话**：周报家族的欠账合成一册：日报统计依赖合并方式、周报详情页不并入统一阅读器的原因与债务。
**谁该读**：维护周报与日报生成的人。
**读完能做什么**：按子项定位欠账，并预判合并策略变化的影响。

---

> 本台账由 2 份同模块台账合并而成，内容原样保留、只做归位；原文件已回收，引用已改指本文。

## 周报 Agent 日报能力

日报统计依赖合并方式：改用快进或变基合并会让落地日期错位，本文记这条边界与非阻塞优化。

| 字段 | 内容 |
|---|---|
| 模块 | 日报技能（`daily-report-summary` + `reference/publish.py`） |
| 状态 | open（功能已可用，2026-05-31；以下为已知边界与后续优化） |
| 关联 | `.claude/skills/daily-report-summary/`、`create-visual-test-to-kb`、文档空间「日报知识库」 |
| 提出 | 用户 2026-05-31：日报技能 + 视觉验收联动，提示词精简、逻辑沉淀进技能 |


### 已知边界

#### 1. committer date 在 fast-forward / rebase 合并下的口径漂移

本仓库 PR 全部走 **merge commit**，merge 的 committer date 即「落地主干」时间，按 `--first-parent <main>` + `%cd` 日期文本过滤当天提交，口径准确。

但若仓库改用 **fast-forward / rebase 合并**：被合并的提交保留更早的 committer date，可能让「当天 ff 落地」的提交按更早日期归档——表现为当天显示零活动而实际已发版，且与 merge 穿透统计不一致。

**后续修法**：遇到 ff/rebase 流程，改用 GitHub PR 元数据的落地 SHA 日期判定归属（参照 `weekly-update-summary` 纪律 3），不要只信 commit 的 committer date。

#### 2. 视觉取证依赖预览环境 + 浏览器登录凭据

Phase 4.5 取证走 `create-visual-test-to-kb` 的 Playwright harness，依赖：预览环境就绪 + `MAP_AI_USER` / `MAP_ACCEPT_PASS` 浏览器登录凭据。无凭据 / 环境未就绪时跳过取证，报告显式注明「本期无截图」，不伪造证据。

**后续修法**：把日报取证凭据纳入 CDS 远端环境注入清单，让取证默认可用。

#### 3. 同日重复发布产生多条同名条目（已修，2026-07-30）

`publish.py` 曾按库 find-or-create 但条目不做同日去重，同一天重复跑会生成多条标题相同的条目。

**已落地**：新增 `--replace-same-date`——先建新条目、校验正文落库成功，**再**删同 `dailyDate` + 同 `kind` 的旧条目。顺序不可反（先删后建时中途失败会把当天日报整个删没）；`state=None`（验证接口不可达）时保留旧条目不删，宁可留一条重复也不误删唯一完好版本。

#### 4. 按日历日采集导致「当天晚些时候的提交」永久漏报（已修，2026-07-30）

**现象**：日报由定时任务每天早上跑（实测 09:10 +0800），旧口径按 `%cd --date=short` 过滤**当天日历日**。于是当天 09:10 之后落地的提交既不在当天报告里（已经跑完了），也不在第二天报告里（日期桶不对），永久漏报。

**实测损失**：07-28 / 07-29 两天漏掉 8 个主干条目、36 个真实提交，含 4 个 feat（周报技能 v2、知识库正文链接卡死修复、录音存储就绪修复等当周最大的几项）。漏报无声无息——每期报告单看都正常，只有把相邻两期的覆盖区间拼起来才看得见洞。

**已落地**：采集窗口改为 `(上期 metadata.lastCommit, 本期 HEAD]` 的**提交 SHA 区间**（纪律 2）。SHA 而非日期/时间戳的三个理由：免疫时区错位（git `%cd` 用提交自带时区、容器多为 UTC）、免疫同秒多提交的边界重叠、中断自动续上（漏跑三天则窗口自然横跨三天）。新增 `reference/coverage_window.py` 读水位线，三级兜底 `sha → since → today`；`publish.py --last-commit` 回写水位线。

**遗留边界（本次未回收的历史空洞）**：过去的覆盖是**日历日桶**而非连续区间，因此历史上的未报道集合在 DAG 上**不连续**——07-28 下午的 4 个条目是 07-29 水位线 `b239edcff` 的**祖先**，任何以该水位线为起点的 SHA 区间都无法包含它们；而若把水位线前移到 `ffc920f34`，区间又会把 07-29 早间已报道的 72 个提交重复计入。故 2026-07-30 的补记期采用**显式枚举 8 个未报道条目**的方式一次性补齐，不走区间。此后水位线保证连续，该情形不会再出现。

**监控建议（未做）**：加一条自检——相邻两期的 `coverFrom`/`lastCommit` 必须首尾相接（本期 `coverFrom` == 上期 `lastCommit`），断链即告警。目前断链只会在 stderr 留一行 `[水位线]` 告警，无人看日志就发现不了。

#### 5. 水位线机制的残留边界（2026-07-30 收口，PR #1300）

PR #1300 经九轮 Codex 评审、21 条意见全部采纳修复。核心不变量已建立并逐条验证：

1. **采集窗口连续** —— 窗口 = `(上期 lastCommit, 本期右端]`，中断自动续上。
2. **正文逐字校验通过才推进水位线** —— 新建与原地更新共用同一段代码，`hasContent` 这种"有没有正文"的弱判据已弃用。
3. **失败只落在「重复」方向，不落在「跳过」方向** —— 所有降级/回滚都朝水位线偏旧收敛；重复报道可见可修，跳过不可逆。

以下为**有意不再继续修**的残留项（用户 2026-07-30 决定收口）。共同特征：均需后端支持，或只在本仓库实际用法中不会出现的路径上触发（日报由定时任务单进程每天跑一次，主干有分支保护）。

| # | 残留项 | 触发条件 | 当前行为 | 彻底修法 |
|---|--------|----------|----------|----------|
| 5.1 | 正文与元数据非原子 | 两次独立 PUT 之间被并发重跑覆盖 | 元数据写后复核正文；确定不一致→回滚元数据并中止；不可复核→告警 | 后端提供原子 upsert，或 `(storeId, kind, dailyDate)` 唯一索引 + CAS |
| 5.2 | 同日并发各建一条 | 两进程同时发现库中无同日条目 | 建后重查 + 只删 `createdAt` 严格早于自己的（不会归零，可能留重复） | 同上：后端唯一索引 |
| 5.3 | 带分享链的重复条目同步部分失败 | 副本正文写成功但元数据失败等 | 按「正文验完才写水位线」顺序锁死失败方向，仅告警不致命 | 需要事务；Codex 建议致命，因主报告此时已发布成功、且残留只会导致重复而非跳过，故保留告警（取舍见 PR #1300 第九轮回复） |
| 5.4 | `since` 模式左端为闭区间 | 上期只记了 `coverTo` 而无 `lastCommit`（本机制上线前的老条目） | 有 `excludeSha` 时按 SHA 精确剔除；无 SHA 时边界仍闭合，上期末条可能被重复统计一次 | 老条目自然淘汰后该分支不再可达 |
| 5.5 | 分享链无法跨条目迁移 | 需要合并同日重复条目时 | 挂着有效分享链的重复条目一律保留不删并告警 | 后端提供「分享链改指向」端点 |

**历史空洞的处理方式（一次性，不可复用）**：2026-07-30 补记期覆盖的 8 个未报道条目是**显式枚举**的，不是区间取的。原因是改造前的覆盖按日历日分桶，未报道集合在提交图上不连续（07-28 下午那批是 07-29 水位线 `b239edcff` 的祖先）。此后水位线保证连续，不会再出现需要枚举补记的情形。

### 后续优化（非阻塞）

- 「按来源 / 标签订阅」与已读状态，向「个人早报」演进。
- 自动化定时：用户 2026-05-31 暂不做 cron；如需，走 Claude Code on the web 的定时触发（在环境侧配置，不入仓库），技能逻辑不变。

## 周报 Agent 详情页

周报详情页评估后明确不并入统一阅读器，本文记原因、债务与重新评估的条件。

| 字段 | 内容 |
|---|---|
| 模块 | 周报详情页（report-agent） |
| 状态 | open · 已评估不合 |
| 关联 | `prd-admin/src/pages/report-agent/ReportDetailPage.tsx`（900+ 行）、`prd-admin/src/components/doc-browser/DocBrowser.tsx`、`prd-api/src/PrdAgent.Core/Models/ReportTeam.cs`、`prd-api/src/PrdAgent.Core/Models/ReportWeekly*.cs` |
| 创建 | 2026-05-28 |


### 背景

2026-05-28 做"统一文档阅读器"时盘点了所有左右分栏阅读型页面。**周报详情页 `ReportDetailPage.tsx` 评估后明确不融合 DocBrowser**，本文件记录原因与未来若要做需要的前置条件。

注意区分两个"周报"概念：

| 名字 | 实际是什么 | 是否已融合 DocBrowser |
|------|----------|---------------------|
| 更新中心-周报 (`WeeklyReportsTab`) | 知识库 `document_stores` 里一个 store 的列表+正文 | 是 2026-05-28 已融合（appearance="cards"）|
| **周报详情 (`ReportDetailPage`)** | report-agent 业务实体 `WeeklyReport` + `TeamReportListItem` 矩阵 | 否 **本文件登记的债** |

二者底层数据完全不同，长得也不像，只是名字撞了。

---

### 为什么不融合 DocBrowser

`ReportDetailPage` 是 **report-agent 的领域页面**，不是文档阅读器。它的左右分栏装的是业务实体，不是文件：

- **左侧 sidebar**：`SiblingReportsSidebar`——成员 × 周次矩阵，每条带「草稿/已提交/已审阅」状态徽章、提交日期、审阅人头像、点赞数。**不是 folder/file 树**，是业务实体列表
- **右侧主区**：多 tabs（内容 / 计划对比 / 评论），每个 tab 独立内容
- **右栏 panel**：「快速面板」含团队总结、贡献者卡片、关键脉络 mermaid 图、提交分布柱状图
- **顶部 actions**：「编辑」「提交审阅」「分享」「导出」按钮（按角色和状态变化）

DocBrowser 的核心契约是 `entries: DocBrowserEntry[]` + `loadContent(id) → text`——这是"一个文件树渲染器"。`WeeklyReport` 是"一份带工作流的业务报告"，强行映射会丢失：
- 状态机（草稿/提交/审阅）
- 跨实体关联（成员、团队、周次）
- 多 tabs
- 右栏复合面板

降级的代价 > 复用的收益。

---

### 已知工程债务

| ID | 说明 | 优先级 | 触发条件 | 状态 |
|---|---|---|---|---|
| RD-1 | **DocBrowser 缺 leftSidebar slot 系统**：要让 DocBrowser 装得下"成员×周次矩阵 + 状态徽章 + 头像"，至少要把左侧 sidebar 整个改成可注入 slot（`renderEntryRow?: (entry, ctx) => ReactNode`），同时保留默认的 file 渲染。改造面大，破坏现有契约。 | P3 | 团队要做"统一一切左右分栏页"项目 | open |
| RD-2 | **DocBrowser 缺 rightPanel slot 系统**：周报右栏的「快速面板」（团队总结/贡献者/mermaid/柱状图）是周报独有，DocBrowser 现在只有"右侧渲染当前选中文档"。需要给 DocBrowser 加 `renderRightPanel?: (selectedId) => ReactNode` 或更激进的"三栏布局" prop。 | P3 | 同 RD-1 | open |
| RD-3 | **DocBrowser 缺 entryBadges 系统**：周报每条左侧条目需要带「草稿/已提交/已审阅」状态徽章、审阅人头像组、点赞数、评论数。当前 DocBrowser 只支持 `lastChangedAt` NEW 徽章 + 本次新增的 `isEntryFresh`。要支持业务级 badges 需要 `renderEntryBadges?: (entry) => ReactNode`。 | P3 | 同 RD-1 | open |
| RD-4 | **若以上 3 个 slot 都加齐，DocBrowser 会膨胀成"万能左右分栏框架"**：违反 SSOT 原则——「DocBrowser 是文档浏览器」这个边界会模糊。届时应该考虑反向重构：把 DocBrowser 拆成 `<SplitPaneReader>`（左右分栏 + 拖拽 + 主题）+ `<DocEntryList>`（文档专用左侧）+ `<DocEntryPreview>`（文档专用右侧），周报和殿堂各自组合自己的 EntryList/Preview。 | P2（架构隐患） | RD-1/2/3 任一开始动 | open |

---

### 重新评估的条件

下面任一条件满足时，才值得重新启动融合评估：

1. report-agent 决定彻底重写，主动来对齐 DocBrowser
2. 团队启动"统一所有左右分栏页"项目（含殿堂、周报、未来的新阅读页），愿意承担 RD-4 的反向重构成本
3. 周报详情的 sidebar / rightPanel 业务变化已经超过 5 处独立实现，维护成本超过融合成本

**当前不满足任一条件 → 维持现状，不动**。

---

### 反面参考

否 "把周报详情塞进 DocBrowser"——RD-1/2/3 全堵在那，硬塞会丢领域语义
否 "给 DocBrowser 加 5 个 slot prop"——RD-4 警告：组件膨胀成万能框架，谁都改不动

正确路径：等业务自然演进到 RD-4 触发条件，再做一次反向重构。

---

### 关键更新脉络 timeline 渲染器分裂（2026-06-04）

周报正文里的「关键更新脉络」是一段 mermaid ` ```timeline ` 代码块。2026-06-04 把它从 mermaid 横向布局（节点多就挤、字小、看不清）换成自研纵向时间线组件 `prd-admin/src/components/ui/UpdateTimeline.tsx`（按天分组卡片墙 + 主轴线 + 当天计数 + 变更类型色 + hover）。

**已知边界**：全站有 **3 个 markdown 渲染器**对 mermaid 处理不一致，本次只接了第一个：

| 渲染器 | mermaid timeline 现状 | 谁在用 |
|--------|----------------------|--------|
| `MarkdownViewer`（FilePreview/DocBrowser/LibraryDocReader） | 是 走 `UpdateTimeline` 新组件 | 知识库、智识殿堂、**更新中心-周报 WeeklyReportsTab** |
| `MarkdownContent` | 否 仍走 `MermaidDiagram`（旧横向） | pm-agent 周报/会议/健康诊断/复盘、周报海报、cds-agent、技能页 |
| `RichTextMarkdownContent` | 否 完全不处理 mermaid，按原始代码块渲染 | report-agent 周报详情、日报 |

后果：**同一篇带「关键更新脉络」的周报，在不同入口长得不一样**（更新中心=新时间线 / pm-agent=旧 mermaid / report-agent=原始文本）。

**为什么先不统一**：2026-06-04 用户明确「先只保留当前范围」。改动收窄 = 零回归（只拦 timeline，其它 mermaid 图和别处代码块原样不动，已有单测守 `parseMermaidTimeline` 对非 timeline 返回 null 回退）。

#### 已知债务

| ID | 说明 | 优先级 | 触发条件 | 状态 |
|---|---|---|---|---|
| UTL-1 | 把 `MarkdownContent` 的 mermaid timeline 也接到 `UpdateTimeline`（同 `parseMermaidTimeline` 判定，只拦 timeline），覆盖 pm-agent / 周报海报 / cds-agent / 技能页。低风险。 | P3 | 用户反馈"pm-agent 周报里的脉络还是旧样式" | open |
| UTL-2 | `RichTextMarkdownContent` 当前 `ReactMarkdown` 无 `code` 渲染器，timeline 显示为原始代码块。若要统一，需新增 `code` 组件分流（timeline→UpdateTimeline，其它 mermaid→MermaidDiagram，普通代码→高亮）。改动稍大。 | P3 | 同 UTL-1，且 report-agent 周报详情需要图形化脉络 | open |
| UTL-3 | 三个渲染器对 mermaid 的处理本就分裂（这是 timeline 之前就存在的历史问题）。根治应抽一个共享 `renderCodeBlock(lang, code)` SSOT，三处共用。届时 timeline / mermaid / 高亮逻辑只维护一份。 | P2（架构） | UTL-1/2 任一开始动 | open |

类型色推断（`CHANGE_TYPES` 关键词注册表）是启发式的，个别条目可能归错类（如标题不含关键词→默认紫）。如需精确，应让周报生成侧在 timeline 数据里显式带类型标记，而非靠前端猜。

---

### 评论图文（2026-07-28 图文评论上线时留尾）

背景：周报评论已支持粘贴/选择图片 + 图文结合（`ReportCommentComposer` + `ReportCommentAttachmentGrid`，后端 `ReportComment.AttachmentIds` + `comments/images` 上传端点）。以下为主动收窄未做的边界：

| ID | 说明 | 优先级 | 触发条件 | 状态 |
|---|---|---|---|---|
| CIMG-1 | 编辑已发评论时不能增删图片（编辑仅改文字；纯图评论因编辑保存要求非空文本而无法进入"改文字"路径） | P2 | 用户要求"改评论里的图" | open |
| CIMG-2 | 评论输入器不支持拖拽文件上传（已支持粘贴 + 文件选择两通道） | P3 | 用户反馈拖图无响应 | open |
| CIMG-3 | 删除评论不清理孤儿附件（与缺陷评论一致的既有取舍；附件仅 5MB 图片，暂不回收） | P3 | 存储量治理专项 | open |

---

### 评论 @ 提醒 + 企微群推送（2026-08-19 上线时留尾）

背景：周报评论支持 @ 成员后，被 @ 的人会收到站内通知，同一条消息（引用原文 + 评论内容）按团队 Webhook 配置推到企微/钉钉/飞书群（事件 `comment_mention`）。企微群里能否真的 @ 亮那个人，取决于成员身份映射里有没有填企微 userid。以下为主动收窄未做的边界：

| ID | 说明 | 优先级 | 触发条件 | 状态 |
|---|---|---|---|---|
| MENT-1 | 编辑已发评论时不重新解析 @：编辑后新增的 @ 不会触发通知与群推（发布时解析一次，落 `ReportComment.MentionedUserIds`） | P2 | 用户反馈「改了评论加了 @ 但对方没收到」 | open |
| MENT-2 | 团队内重名成员（两个「张三」）只会命中其中一个——正文里的 `@张三` 无法区分是谁 | P3 | 团队出现重名且反馈 @ 错人 | open |
| MENT-3 | 钉钉/飞书不做真 @（只发 `@显示名` 文本）。真 @ 需要另一套映射：钉钉 atMobiles 要手机号、飞书要 open_id | P2 | 团队主要用钉钉或飞书且要求红点提醒 | open |
| MENT-4 | 企微 userid 要管理员在「团队成员 → 身份映射」手工填，没接企微通讯录同步，也没有「填错了会怎样」的校验（填错就是 @ 不到人，群消息照发） | P2 | 成员多、手工维护成本高 | open |
| MENT-5 | 回复某人的评论不通知被回复人（只有正文里显式 @ 才通知） | P3 | 用户反馈「回复了我却没提醒」 | open |
| MENT-6 | 站内通知走 `AdminNotification` 通知中心，不是独立私信/未读会话；同一条评论对同一个人幂等（key 含 commentId），不会重复打扰 | P3 | 需要独立消息中心时 | open |
