# 知识库 · 债务台账

> **版本**：v1.1 | **日期**：2026-07-31 | **状态**：开发中

**一句话**：知识库全家的欠账合成一册：两套实现并存、无语义检索、划词评论与改写、双链引用网络、跨库同步、版本管理、阅读器收口、两套关系可视化并存。
**谁该读**：接手知识库任一子能力的工程师；关心文档能否被智能体用上的产品。
**读完能做什么**：按子能力定位欠账，并挑出优先级最高的一项来还。

---

> 本台账由 8 份同模块台账合并而成，内容原样保留、只做归位；原文件已回收，引用已改指本文。

## 主台账
| 字段 | 内容 |
|---|---|
| 模块 | 知识库（AI Toolbox `KnowledgeBaseIds` + 文档空间 `document_stores`） |
| 状态 | open |
| 关联 | `prd-api/src/PrdAgent.Api/Controllers/Api/AiToolboxController.cs`、`prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreController.cs`、`prd-admin/src/pages/ai-toolbox/components/*.tsx` |

## 背景

2026-05-21 review 发现两个层面的债务：

1. AI Toolbox 的【快速创建向导】(`QuickCreateWizard.tsx`) 第 3 步「测试调优」面板的"知识库"区块**长期是禁用占位符**（"即将上线"），而完整版编辑器 `ToolEditor.tsx` 早就把上传 + 注入跑通了。本次 PR 把占位符替换为可用 UI（复用 `ToolEditor` 同一套 `uploadAttachment` + `attachmentId → KnowledgeBaseIds` 路径），但同时暴露了更深层的架构与功能债务。

2. 系统并存**两套"知识库"实现**，命名相同语义不同，长期没整合。

---

## 已知工程债务

| ID | 说明 | 优先级 | 触发条件 | 状态 |
|---|---|---|---|---|
| K-1 | **两套"知识库"并存**：AI Toolbox 绑定的是附件集合（每条附件自带抽取好的正文，拼 prompt 时整篇拼接），而独立的「文档空间」走 `document_stores` + `document_entries` 集合，有更完整的多类型、订阅源、版本、view event 等能力。两套数据流不通，AI Toolbox 选不到文档空间里已经管理好的文档。建议规划"统一知识库"模型：AI Toolbox 改为引用 `documentEntryId`（或一个虚拟 store 包一组 attachment），并写一次迁移把存量 attachment 落入 document_stores。 | **P2** | 用户开始把同一份文档既上传到智能体又导到文档空间，或要求"我已经在文档空间里有这堆 PDF，直接关联给智能体" | open |
| K-2 | **语义检索：底座已落地，缺一个 embedding 供应商凭据**（2026-08-10 更新）。已完成：网关 embedding 通路（compute-then-send 单次解析、响应按 index 归位）、embedding 进入专属池不可用时的失败关闭名单、`document_embeddings` 向量存储（float32 二进制 + 盖 Model/Dimension，跨模型判为不兼容）、切块与增量索引哈希（哈希拌入模型标识）、Stub 平台的 OpenAI 兼容 `/v1/embeddings` 自测通道。**卡在哪**：本部署已配置的两个平台里没有任何 embedding 模型——OpenRouter 的 399 个模型零 embedding，需要新接一个供应商并提供 key（属外部输入，工程侧造不出来）。**注意**：原条目建议的 MongoDB Atlas Vector Search 在本部署上不成立，跑的是自建 `mongo:8.0` Community + `redis:7-alpine`，两者都没有向量检索能力；现方案是向量存 Mongo + 作用域先过滤 + 进程内余弦，按真实规模（最大的 MAP 库 330 篇 4.24MB ≈ 5 千余块）够用。剩余未做：建索引 Worker、检索服务、回答引用注入、前端挂库与引用渲染。选型与「绑定多个」的结论见 [debt.platform.embedding-provider.md](./debt.platform.embedding-provider.md)。 | **P1**（等 key 到位即可续做） | 拿到任一 OpenAI 兼容 embedding 供应商的 key | partial |
| K-3 | **AI Toolbox 占位符里曾误导用户**：替换前的快速创建向导写"即将上线"，让用户以为功能即将就绪，但底层数据通路（DTO、Model、Controller 注入）早已 ready。这种"前端 UI 写 wip 标签 vs 后端早已 ready"的不一致没有自动巡检手段，未来类似情况可能继续出现。建议在 `navCoverage.test.ts` 类似的 CI 守卫里加一条："禁止 UI 出现「即将上线」/「敬请期待」字样的 disabled 按钮 —— 要么标 TODO 接通，要么去掉。" | P3 | 下次新 PR 又留下"即将上线"占位符 | open |
| K-4 | **`uploadAttachment` 与 `documentstore/entries/upload` API 不互通**：AI Toolbox 走 `POST /api/ai-toolbox/upload-attachment`（返回 `attachmentId`），文档空间走 `POST /api/document-store/stores/{id}/entries/upload`（返回 `entryId`）。两个端点各有 mime 解析、文本抽取、缓存逻辑，未来文档解析能力升级（如新增 Excel 智能化抽取）需双改。建议合并到一个上传 service。 | P3 | 升级 PDF/Word 抽取库 / 新增 Excel 表格化抽取时双向同步 | open |
| K-5 | **不存"原始 KB 选择来源"**：AI Toolbox 智能体的 `KnowledgeBaseIds` 只存 `attachmentId`，不区分"用户当时是直接上传文件" vs"从文档空间选了一个 entry"。一旦 K-1 落地后会丢失这层语义，难以反向追溯。建议增加 `KnowledgeBaseSources: List<{type: "attachment"\|"document-entry", id}>` 结构存原始引用。 | P3 | K-1 立项后 | blocked-on-K-1 |
| K-6 | **缺少"按 documentType 过滤"的技能权重**：[design.knowledge-base.multi-doc.md](./design.knowledge-base.multi-doc.md) 的“风险与边界”仍将类型过滤列为后续方向。当前技能只能 `contextScope=all/current/prd/none`，不能说"我这个技能只看 product 类型的文档"。整合 K-1 时一起做。 | P3 | K-1 立项后 | blocked-on-K-1 |
| K-7 | **访问统计无应用层消费**：`document_store_view_events` 集合已经在记数据（含 `ViewDedupWindow` 去重），但没有"热度排序"、"用户协同推荐"、"最近访问的知识库快速接入智能体"之类的应用。 | P4 | 用户反馈"找不到我之前上传过的文档"时 | open |
| K-9 | **下载「原始文件」格式在跨域对象存储上会降级**：2026-07-31 下载弹窗新增「当前文章 / 整个知识库」范围与三种格式后，选「原始文件」时前端对 `fileUrl` 发 `fetch`。该地址多为对象存储/CDN 公网 URL（`TencentCosStorage`），不带 `Access-Control-Allow-Origin`，浏览器会拦掉；当前实现降级为导出抽取正文（`.md`/`.txt`），用户拿不到真正的 PDF/Word 原件，且降级是静默的（只体现在整库导出的失败计数里）。彻底解决需后端加一个同源下载代理端点（`GET /api/document-store/entries/{id}/raw`，带鉴权透传对象存储流）。 | P2 | 用户反馈「选了原始文件却下到 .md」或需要批量取回原始附件时 | open |
| K-8 | **二进制文档抽取能力有限**：Excel/CSV 当前按纯文本对待，无表格结构化提取；代码仓库（如 GitHub repo）无自动同步接口（SyncWorker 框架已有，但 GitHub 集成代码未确认完整）。 | P3 | 用户要求把 Excel 报表 / GitHub README 作为知识源时 | open |

---

## 还债计划草稿

**短期（本 PR 已交付）**：
- 把 `QuickCreateWizard.tsx` 占位符替换为可用 UI，复用 `ToolEditor.tsx` 的上传/拼装通路。

**中期（K-1 + K-2 一并立项）**：
- 起 `spec.unified-knowledge-base.md`：定义统一模型 + 迁移策略 + RAG 接入边界
- LLM Gateway 增加 embedding ModelType 调度路径
- 选定向量存储方案（建议 MongoDB Atlas Vector Search，省得自建索引）
- 现有 `attachments` → 新 `knowledge_chunks` 集合的数据迁移脚本

**长期（K-3、K-4、K-7、K-8）**：
- 在统一 KB 落地后顺势处理 wip 标签 CI 守卫、上传 service 合并、访问统计应用、文档类型扩展。

---

## 待办：github_directory 父条目结构修正（2026-05-30）

现象：GitHub 目录订阅的**父条目**被建成 `IsFolder=false`、无 `DocumentId/AttachmentId` 的"可点击叶子"，点开走 `GetEntryContent` 返回空内容 → 前端"打不开/空白"。子文件健康，但因 `ParentId=null` 全部平铺在根级（父子关系只存在 `Metadata["github_parent_id"]`，而树构建只认 `ParentId`）。

已修（本次）：前端 `FilePreview.tsx` 对 `github_directory` / `application/x-github-directory` 渲染目录卡片（仓库/路径/分支 + 跳 GitHub），消除"空白打不开"。**对全部存量数据立即生效，无需迁移。**

未修（债务，需后端 + 数据迁移，避免动 GitHub 同步 worker 引入回归）：
1. `DocumentStoreController.AddGitHubSubscription` 创建父条目时设 `IsFolder=true`（点击即展开，不取内容）。
2. `GitHubDirectorySyncService` 子条目创建时设 `ParentId = parentEntry.Id`（真正嵌套）。
3. 存量回填脚本：父条目 `IsFolder=true` + 子条目 `ParentId ← github_parent_id`。
4. 需真实 GitHub 订阅 + worker 跑一轮验证，确认同步/增量/删除路径不因结构变化回归。

## 相关文档

- [design.knowledge-base.store.md](./design.knowledge-base.store.md) —— 文档空间设计
- [design.knowledge-base.multi-doc.md](./design.knowledge-base.multi-doc.md) —— 多文档知识库设计（含 Phase 3 RAG 未做的明确标记）
- `.claude/rules/no-rootless-tree.md` —— 借用法则
- `.claude/rules/codebase-snapshot.md` —— 现有快照里"RAG/embedding 未实现"的说法在此处固化

---

## 待办：手机端 Notion 化后续波次（2026-07-13 更新，转录结果页/上传进度/声纹播放器波次已落地）

已落地（分支 `claude/kb-mobile-redesign-plan-de2clg`，2026-07-10）：上传录音 → ASR 转录 → AI 流式摘要 → 「摘要 + 转录全文」转录笔记的全链路（后端 transcribe kind + 前端 TranscribeFlowDrawer 四阶段清单卡，移动端底部弹层），音/视频条目正文顶部常驻「开始转录 / 查看转录笔记」入口卡，`/document-store` 登记移动端 full 兼容。端到端自测通过（真实语音样本，摘要与全文均正确落库）。

已落地（2026-07-12，见 `changelogs/2026-07-12_kb-fab-regroup-record.md`）：
1. **浏览器现场录音**（计时 + 电平波形 + 暂停/继续），录完自动进转录摘要链路；无权限或已有文件时保留上传音频兜底——原「未做」第 1 项已完成。
2. **整理方式**：智能摘要/会议纪要/访谈整理/待办清单/自定义（SSOT 注册表 + `transcribe-styles` 端点），完成后可「换个整理方式」重新整理（restyle 免重跑 ASR，原地更新摘要节并走版本快照）。
3. **录音数据保险箱**：分片实时落 IndexedDB，断网/崩溃/忘关不丢数据，进页提示恢复并转录；上传失败可一键重试；静音录音完成前拦截确认。
4. **静音录音防误存**：转写提示词加 NO_SPEECH 哨兵 + 拒答模式守卫，避免模型对话式回复被存成笔记。
5. 音频页新增歌词滚轮跟读播放器（无时间戳退化为静态全文）；音频结果区统一（录音/上传同页）。
6. 右下角新增菜单由弧形调色盘改为竖排列表（分组「上传与导入」可展开/收起），修复移动端动作项互相遮挡。

已落地（2026-07-13，见 `changelogs/2026-07-13_kb-audio-flow-polish.md` + `changelogs/2026-07-13_kb-audio-usability-fixes.md`）：
1. 上传成功自动跳转到刚上传的文档（多文件跳第一个）；外层列表页新增同款「+」FAB（新建知识库/写文章/录音转笔记/上传与导入），动作先弹「归属到哪个知识库」选库，按当前 tab 作用域列库（团队 tab 可写团队库）；下线外层旧「新建」悬浮按钮（原与统一「+」菜单撞位）。
2. 转录完成摘要改为 markdown 渲染（限高内滚）+「编辑笔记」直达编辑态；转录流式输出支持贴底自动滚动（stick-to-bottom：贴底才自动滚、上滑即打断、浮出「回到底部」）；转录完成结果区新增双页签「整理结果 / 转录原文」（原文来自 `run.transcriptText`，老任务给指引）。
3. 上传改 XHR 带实时进度（浮动进度卡 文件名+百分比+第 n/共 m，转录抽屉上传阶段进度条）；上传白名单补齐音频/视频/图片/Office 扩展名，超 20MB 前端预检即时报错。
4. 音频播放器声纹化（跨域拿不到真实波形时渲染语音条式声纹：确定性伪随机 + 进度着色 + 点按跳播），去掉顶部大图标与文件名块；转录笔记/字幕/再加工产物顶部新增「来源文件」chip 一键跳回源音频/源文档。
5. restyle 权限改为按笔记可写判定（协作者可整理别人发起的转录）；转录复用在途 run 时纳入整理方式匹配（风格不同则新建，修复复用默认 run 出错风格）；`latest-run` 端点支持 status/requireOutput 过滤，修复一次整理失败后面板永远打不开。
6. 移动端 markdown 编辑改单栏（原双栏 live 被挤成两条窄柱无法编辑）；双皮肤棘轮回绿（本轮新增 10 处 rgba 白透明硬编码全部换 token）。

已落地（2026-07-20，见 `changelogs/2026-07-20_quick-recording-and-transcribe-focus.md`）：
1. 知识库右下角悬浮加号双击直接进入快捷录音（单击仍保留原新增菜单）；录音时可下拉选择目标知识库，完成后默认保存录音与可编辑原文，用户可明确取消或主动一键整理；无麦克风/拒绝权限时仍保留该下拉，不再连带隐藏。
2. 转录默认仅执行原文识别，新增独立的原文校对接口，后续整理以用户修订后的原文为依据（而非未经校对的 ASR 原始输出）；文档页签按「原文 / 整理类型」命名承载播放、逐句校对与可选整理结果。
3. 新增录音顺序分片上传会话：录音过程中持续保存服务端分片，支持幂等完成与整段上传降级；前端增加实时保护状态和已上传体积展示，网络失败时自动保留本机保险箱并走原上传链路。
4. 快捷录音自动启动意图改为绑定知识库并在首次执行时消费（修复转录完成跳库/重新进库时重复开始录音）；转录整理增加独立状态轮询兜底（修复移动端因流事件丢失长期停在「写入中」）；移动端进入已转录文档隐藏新增悬浮按钮（避免遮挡正文）。
5. 会议纪要整理升级为方案评审结果通知模板，支持会议邀请或已有纪要作为补充资料并保留不同意见归属；支持粘贴多行资料即时识别方案时间地址与参与人员。

已落地（2026-07-21，见 `changelogs/2026-07-21_recording-upload-dedup.md`）：
1. 修复上传并发 `/complete` 竞态：完成前原子认领会话（Uploading→Completing），杜绝重复音频条目与文档数双计。
2. 修复弱网下 `/complete` 响应丢失导致整文件重复上传：客户端回退前先回读会话状态并幂等重试 `/complete`，服务端已完成则复用同一条目。

已落地（2026-07-24，见 `changelogs/2026-07-24_live-transcription.md`）：录音链路由「录完再转录」升级为**实时转写**（录音过程中持续展示识别原文）：
1. 前端边录边转写：本机 PCM 保险箱 + 服务端分片双重保护；建连超时、会话建立前溢出、达到大小上限、暂停/恢复边界等场景均降级为完整文件转写且不丢开头/结尾/暂停期采样。
2. llmgw 新增模型池多候选实时 ASR 网关端点（WebSocket 中继 + 会话归属校验），流式供应商不可用时按 5 秒窗口持续切候选并保留滚动窗口降级预览，复用统一 appCaller 限流/预算/租户上下文与生命周期日志治理；正式 Nginx 与 CDS 预览代理已支持该 WebSocket 升级。
3. prd-api 录音归档改为确定性条目 + 可恢复租约（含主动续期与过期保护）、跨实例定向领取、分片并发去重与旧偏移一致性校验，对象存储异常时转入 Mongo 耐久队列并在恢复后幂等补齐。
4. 完成与恢复路径做了多轮并发/竞态收敛（服务端接管与本机保险箱恢复互斥、晚到原文与延迟归档补写、权限复核跟随知识库当前读写状态撤权即失效等），完整清单见 changelog 逐条（约 90 条 fix/test，均为同一实时转写主链路的加固）。

未做（原计划剩余波次，待排期）：
1. 手机端文章页 Notion 化大标题头（返回/分享/更多三键 + 大标题块），当前沿用既有移动工具栏。
2. 手机端详情页底部常驻「问 AI」输入条（复用 ReprocessChatDrawer 多轮对话后端）。
3. 转录中细分阶段的时间预估（当前只有阶段名，无「预计还需 N 秒」，见 expectation-management 约束 1）。

### 整理结果为空的质量缺口（2026-07-31）

- 现象：业务需求会议录音能够生成原文，但“一键整理”里的业务内容、会议结论或待办可能为空，并显示“本段录音未提及待办事项”。
- 本轮边界：先完成录音过程、结果落点、列表定位和播放体验修复，不在缺少该次真实 run、提示词及模型响应证据时调整提炼逻辑。
- 后续取证：按 `runId` 对照 `transcriptText`、`styleKey/styleContext`、最终发送给 LLM 的消息与 `generatedText`，区分原文缺失、整理提示约束过强、模型漏提炼和前端摘要截取四类原因后再修。

### 云端录音归档环境缺口（2026-07-31）

- 现象：CDS 预览环境中短录音可以约 2 秒完成转录，但云端副本长期停在待归档队列；归档重试退避后，下一次尝试可能延后到 16 分钟或更久。
- 已确认根因：Cloudflare R2 上传持续返回签名不匹配错误，属于对象存储凭据或签名配置问题，不是录音时长、ASR 性能或浏览器刷新导致。
- 本轮缓解：本机保险音频、服务端分片和原文继续可用；页面读取会话错误状态后明确显示“已排队重试”，并允许用户播放、编辑或离开页面，同一条录音的状态变化只做后台局部刷新。
- 关闭条件：部署负责人校正 R2 凭据与端点配置后，使用真实 5 秒录音验证首次归档成功，确认日志不再出现签名不匹配，页面自动从待重试切换为正式音频。
- **已关闭（2026-08-03，changelog 碎片已归档进 `CHANGELOG.md`）**：修复真实录音大小上传 Cloudflare R2 时的签名不一致，并将代表性音频写读删纳入就绪门禁；同步阻止用小文本探针或仅检查请求参数替代真实录音对象存储验收，避免同类回归被弱验收放过。
- **已落地（2026-08-04，changelog 碎片已随 #1344 发版归档进 `CHANGELOG.md`）**：
  1. 实时转写断线自动重连（避免录音中途停止出字）；归档退避缩短至十五分钟并支持手动立即重试；允许用户接管长期停滞的归档租约立即重新排队；超十分钟未完成自动显示可恢复状态与手动重试入口。
  2. 语音识别保留原生说话人信息并写入带时间轴的转录原文；结果页新增说话人改名、整场词云、原文关键词定位与录音问答入口。
  3. 说话人分段链路多轮加固：先确认完整原文再独立增强角色分段（避免假静音或角色识别失败丢失有效录音）；优先走专属转录模型池，原生识别失败自动回退通用音频转写；上游未返回角色时按本地声纹与发言间隔保守区分并补齐时间轴；本地分离改用声学距离聚类支持三角色，压缩未分配文字的角色编号避免跳号。
  4. 修复 Safari 录音 MIME 参数导致 R2 签名失败，存储健康检查覆盖真实浏览器格式；会议纪要兼容方案评审结果与评审意见格式，未明确时不擅自判定通过。

## 知识库划词评论

知识库里选中一段文字就地评论这个能力的已知边界与待偿还项。

### 总览

模块范围：前端文档阅读器（批注浮层 / 批注栏 / 输入框三件套）、后端最近批注聚合接口、验收技能的批注回读脚本（文件见文末「实现来源」）。

本次落地了「边读边看」批注栏 + 批注栏/内联布局切换 + 划词就地输入 + 批注头像/名字显示 +
后端最近批注聚合接口 + 验收技能回读脚本。以下为主动声明的已知边界。

### 已知边界（待后续偿还）

| # | 边界 | 现状 | 后续方向 |
|---|------|------|----------|
| 1 | 图片批注 | 仅文字锚点 + 全文评论；右键图片/框选图片区域批注未实现 | 新增 image-anchor 数据模型（坐标框）+ 前端图片框选交互 |
| 2 | inline 布局展开卡片定位 | 绝对定位在高亮末行下方，可能与下方正文视觉重叠（MVP） | 改为 in-flow 占位插入，或碰撞规避 |
| 3 | margin 批注栏卡片排序 | 按 createdAt 排序，非按锚点在正文中的垂直位置对齐（无 Docs 式连线） | 计算每组锚点 top，按位置排序 + 可选连线 |
| 4 | 批注栏  TOC | 有评论时默认批注栏取代 TOC，「收起」临时切回；未做并存 | 评估窄屏并存 / 可拖拽分栏 |
| 5 | 回读闭环 | read_comments.py 为按需轮询（GET recent-comments） | 监听式 webhook/SSE 主动推送 |
| 6 | 布局偏好存储 | localStorage（设备本地，符合 no-localstorage 例外清单） | 如需跨设备同步，迁移到 user_preferences |
| 7 | 同一短语多处分别评论 | 完全相同的选中文字在文档不同位置被分别评论时，按归一化文本合并为一张卡（两处的评论混在一起），正文只高亮其中一处，回复用首处偏移。**产品决定保持现状**（2026-06-06 用户拍板，低频场景）。group key = 归一化文本 是 overlay 高亮解析/连线/激活态共享的身份，按出现位置拆分属较大重构 | 如需精确区分：group key 带 contextBefore/offset，overlay 改为逐出现位置解析锚点 |

### 相关

- 设计：本次为增量交付，无独立 design 文档；交互 mock 见会话记录
- 接口：`GET /api/document-store/stores/{storeId}/recent-comments?since=&limit=`
- 鉴权：AgentApiKey `document-store:read`（write 蕴含 read），与归档脚本同一把 MAP_DOC_STORE_KEY

## 知识库划词 AI 局部编辑

知识库划词后让 AI 局部改写这块的已知边界与未排期的第二波候选。

### 总览

模块范围：前端划词动作条与两个浮层（AI 改写 / 配图）、后端改写 SSE 端点与动作清单、动作注册表 SSOT，外加一条网关调用方登记（文件见文末「实现来源」）。

第一波落地：划词浮层从单一「添加评论」扩展为 评论 / AI 改写 / 配图 动作条；
AI 改写支持润色/精简/扩写/书面化/纠错 + 自定义指令，SSE 流式生成 + diff 对比 + 替换原文（唯一定位校验）/ 插到原文后；
配图内嵌视觉创作 mini 面板（appKey=visual-agent），按选区 + 文档上下文生成并插入选区段落之后。
写回复用既有 `PUT entries/{id}/content`，服务端自动重锚定行内评论 + 重算双链账本。以下为主动声明的已知边界。

### 已知边界（待后续偿还）

| # | 边界 | 现状 | 后续方向 |
|---|------|------|----------|
| 1 | 多处出现的选区定位 | 已升级为 DOM 序号指认（2026-06-12 Bugbot High 修复）：从真实 DOM Range 数"选区前同文出现次数"指认第几处；仅当 DOM 总数与正文统计不一致（评论气泡等副本混入 DOM）时仍禁用替换 | 如需进一步收窄禁用面：DOM 计数时排除浮层/批注 DOM 子树 |
| 2 | 无撤销 | 替换/插入直接走 PUT content 落库，无一键撤销（可通过再次编辑恢复） | 写回前在前端暂存上一版，提供 toast 内「撤销」按钮；或接入条目版本历史 |
| 3 | 并发编辑 | 选区快照与写回之间若他人改了正文，靠"重定位失败即拒绝"兜底，无乐观锁 | PUT content 增加 baseUpdatedAt 预检（409 冲突提示） |
| 4 | 配图定位失败兜底 | 选区无法在正文定位时图片追加到文末（toast 未单独提示落点） | 同 #1 提升定位成功率；失败时明确提示"已插入文末" |
| 5 | 改写动作集 | 首批 5 个内置动作 + 自定义指令；翻译/表格化/Mermaid 图等靠自定义指令 | 按使用数据沉淀高频自定义指令为内置动作（注册表加一行即可） |
| 6 | 仅文本类条目 | PDF/图片等非 `preview=text` 条目不露 AI 入口（改不了正文） | 暂无计划 |
| 7 | 富文本编辑模式 | AI 动作条只在阅读态出现；编辑态（textarea/富文本）内划词无 AI 入口 | 编辑态接 textarea selectionStart/End（offset 精确，无需消歧），成本低收益高 |
| 8 | 后端编译验证 | 开发环境无 dotnet SDK，C# 改动依赖 CDS push 后远端编译验证 | CDS 绿灯后此条自动关闭 |

### 第二波候选（涌现池收敛，未排期）

- 划词追问（解释这段 / 与全库知识对照）：只读也可用，输出进侧栏不改正文
- 划词转双链：选中概念一键 `[[包裹]]` 并建联（联动 mentions 账本）
- AI 改写建议以"行内评论"形式挂在选区上（复用 InlineComment 数据模型，作者审阅后采纳）
- 全文体检：逐段跑纠错/一致性检查，按段落生成批量建议

### 相关

- 接口：`POST /api/document-store/entries/{entryId}/selection-rewrite`（SSE：start/thinking/text/done/error）、`GET /api/document-store/selection-rewrite/actions`
- 单测：划词编辑的定位/替换/插入/前缀拼接 14 例
- 关联台账：[doc/debt.knowledge-base.md](./debt.knowledge-base.md)（划词评论）、[doc/debt.knowledge-base.md](./debt.knowledge-base.md)（双链）

### 待办：划词浮层配色与字体，两项没法在本地证明（2026-08-21 复刻比对留下）

浮层从冷紫换成品牌暖调后，把设计稿画板与实现页并排比过一轮（玻璃/素色两档材质、
双主题），差异要么当场改了、要么记在这里。**下面两条是本地环境物理上验不了的，
只能等真人在预览域名或自己机器上看**——在那之前不许声称字体方向 A「效果达成」。

| 欠账 | 为什么本地证不了 | 还账方式 |
|---|---|---|
| 中文字体链的排序（苹方 → 鸿蒙 → 思源 → Noto → 雅黑 UI）到底有没有改善观感 | 取证容器里这五个字体一个都没装（`fc-list` 只有 DejaVu / Liberation / IPAGothic），中文实际落到 IPAGothic。本地截图里的中文字形跟这条链毫无关系 | 真人在 macOS / Windows 打开预览域名看一眼；或在取证镜像里装思源 + 雅黑再比 |
| Inter 是否真的生效 | 同一容器里 Google Fonts 不可达，`document.fonts` 为空、`fonts.check('16px Inter')` 返回 true 是假阳性。实测「字体链」与「纯 Inter」渲染宽度不同（291.22 vs 232.16），说明本地根本没用上 Inter | 同上；或把 Inter 自托管进 `public/fonts`，顺带去掉对 Google Fonts 的运行时依赖 |

已经改掉、不必再记的偏差：快捷动作 chips / 输入框描边 / 撤销与重试按钮当初仍是中性灰
（稿子是暖色）；浮层在默认「素色」材质下没有兜底底色。**设计稿自身的两个缺口**已回改进稿子：
它只画了玻璃材质与暗色一档，增删计数的颜色画成绿/橙而正文里本来是蓝/红。



文档双链与关系图首版的边界、技术债、用户提过但没承诺的功能，以及要盯的风险。

### v2 进度更新（2026-06-11 晚，commit `28610fc`）

本轮落地 4 件套，§1.1 / §1.2 / §1.3 / §1.4 部分已**消除**：

| § | 事项 | 状态 |
|---|---|---|
| 1.1 | 编辑器 `[[` 自动补全 | 是 `WikilinkAutocomplete.tsx` 已挂入 DocBrowser 编辑模式，调 `/api/mentions/stores/:id/suggest`，上下键 + Enter + Esc 全通 |
| 1.2 | 编辑器 `@` 触发 | 是 同组件同时识别 `@`，中文 IME 友好 |
| 1.3 | 悬停预览卡 | 是 `WikilinkHoverCard.tsx` + `MarkdownViewer` 派发 `wikilink:hover` 事件，蓝链浮 280px 预览（标题 + 摘要 + 「双链目标」徽章 + 「点击跳转 · 鼠标移开关闭」） |
| 1.4（部分） | 「文档不存在」虚链 UX 兜底 | 是 MarkdownViewer 查 `wikilinkCache` 判断目标是否存在，不存在→橙色虚线下划线 + 悬停浮橙色提示卡 |
| 1.4（完整） | AI 自动补链（保存时扫描"提到 X 但没标 [[]]"） | 否 转 v3，见 §1.4 |

剩余条目按下述 §1 / §2 / §3 / §4 处理，编号保持不变以兼容历史引用。

> **关联文档**：[design.knowledge-base.mention-network.md](./design.knowledge-base.mention-network.md)（本设计的主文档，本文是其遗留事项台账）

### 一、MVP 已知边界（2026-06-11 上线时明确告知用户）

#### 1. 编辑器 `[[` 自动补全 — 是 已消除（v2，2026-06-11，commit `28610fc`）
落地组件：编辑器里的双链自动补全下拉。

#### 2. 编辑器 `@` 触发 — 是 已消除（v2，2026-06-11，commit `28610fc`）
同组件同时识别 `@`，中文 IME 友好。

#### 3. wikilink 悬停预览卡 — 是 已消除（v2，2026-06-11，commit `28610fc`）
落地：`MarkdownViewer` 派发 `wikilink:hover` / `wikilink:unhover`，`WikilinkHoverCard.tsx` 全局监听并查 `lib/wikilinkCache.ts` 渲染卡片。蓝链 = 存在卡，橙链 = 「文档不存在」卡。

#### 4. AI 自动补链（推荐气泡）— 警告 仅完成 UX 兜底（虚链提示），AI 推荐部分仍未做
v2 已落「文档不存在」橙色虚链 + 悬停提示，但**主动 AI 扫描"提到 X 但没标 `[[]]`"** 仍未做。完整实现：
- 在 `AppCallerRegistry` 加 `document-store.suggest-wikilinks::chat`
- 新增 `LinkSuggestService`（参考 `LlmGateway` 调用样例）
- 在 `UpdateEntryContent` 异步触发（不阻塞保存）
- 前端 `BacklinksPanel` 旁挂一个「待确认链接」组件
- 用户「采纳」时回写正文 `[[xxx]]`，再次保存触发 `MentionService.ResyncDocumentMentionsAsync`

#### 5. 跨库引用未支持
`MentionService.ResyncDocumentMentionsAsync` 只在同库 `StoreId` 内按标题匹配。跨库引用需要扩展协议（如 `[[storeA::标题]]`）+ Resolver 路由。

#### 6. 跨实体引用未支持（缺陷 / PR / 周报）
`Mention` 模型已通用化（FromType / ToType 都是字符串），但解析器层 hard-code 了 `Document`。扩展路径：
- 抽象 `IMentionResolver` 接口（GetTitle / GetSummary / GetUrl）
- DI 注册各实体的 resolver
- `MentionService.ResyncMentionsAsync` 接受实体类型参数

#### 7. 别名（aka）未实现
文档 model 没有 `Aliases: List<string>` 字段。MVP 只支持精确标题匹配。

#### 8. 改名时不会更新已有 wiki 链接
改了文档标题，其他文档正文里的 `[[旧标题]]` 不会自动改成 `[[新标题]]`。但**双链反向解析仍然走 ID（不走标题字面）**，所以"被引用"卡片不会丢，只是正文里的 anchor 文字停留在旧标题。改进：保存或改名时遍历 mentions 找到引用方，自动重写正文（需要权衡：是否要修改用户没保存的内容）。

#### 9. 宇宙图无 AI 推荐"虚线"连接
原型设计稿里有"AI 检测到这两篇可能也该连"的虚线，未在 MVP 实现。

#### 10. 宇宙图节点 ≥ 500 性能未压测
当前一次性返回全图数据 + 一次性力导向计算。10000 节点级别可能卡顿。需要：
- 节点数 ≥ 阈值时切换 WebGL 渲染（PixiJS / Sigma.js）
- 分层加载（按 category 折叠成"超级节点"）
- 力导向用 web worker 异步算

#### 11. 宇宙图无时间轴回放
原型设计稿里有"看知识网怎么长出来"的功能，未实现。

#### 12. 宇宙图无按团队分色
现按 `category` 字段哈希取色。"按用户" / "按团队"维度需要后端在 graph 接口里额外返回 createdBy + ownerTeamId。

#### 13. 宇宙图设置面板的滑块改不触发立即重绘
当前 stateRef + onChange 改 ref，但渲染循环本身在跑，所以下一帧就生效。**已生效**，无 bug，但设置面板里的"已选值"label 没显示当前数值。改进：把 Display / Forces 滑块也走 useState 而非 ref。

#### 14. UniverseGraphPage 没有 `[stay-on-page]` 防滥用
宇宙图持续 60fps 跑物理引擎，CPU 占用偏高。用户切走 tab 时应自动 pause requestAnimationFrame。

#### 15. MongoDB 索引未建
`mentions` 集合的 `{scopeId}`, `{toType, toId}`, `{fromType, fromId}` 索引未建。当前数据量小，不影响；到 1 万 mentions 以上时需手动建（遵循 `no-auto-index` 规则，不能自动建）。

#### 16. 标题撞名时取最早创建的
同库内多篇同名文档时，`MentionService` 取 `GroupBy(Title).First()` 即"最早创建的"。可能链错。改进：取「最近更新的」可能更符合用户预期；或在 UI 层提示用户选择。

### 二、技术债务

#### T1. WikiLinkParser 不识别 markdown 代码块内的 `[[xxx]]`
正则全文匹配，包括代码块和行内代码。用户写 markdown 代码示例时可能误伤。改进：用 remark AST 走 mdast → 只在 paragraph / list-item 等正文节点扫。

#### T2. 上下文截取按字符不按 UTF-16 surrogate pair
对 emoji 等 surrogate pair 字符在 60 字符截取边界可能切坏。改进：用 `Intl.Segmenter` 或 grapheme-splitter。

#### T3. 反向链接面板没分页
一篇热门文档可能被 100+ 篇引用，全部一次性渲染。改进：分页或「显示前 10 条 / 展开更多」。

#### T4. MentionsController 没区分 read-only 共享访问
当前权限走 `[AdminController]` + 内部 `CanReadAsync`。如果未来加分享链接公开访问（非登录用户），需要新增 public 端点（参考 `DocumentStoreController` 的 publicShare 系列）。

#### T5. 双链/graph 接口读权限比文档列表更严（产品库/PM/识途库用户拿不到引用图）— 待专项修复
**现象**（Codex #923 P2，2026-06-25）：`MentionsController.CanReadAsync` 只放行 `owner / IsPublic / SharedTeamIds`，而 `DocumentStoreController.CanReadStoreAsync` 还放行 **产品知识库（`ProductKnowledgeRef`）/ PM 项目库（`PmProjectId`）/ 识途库（`ShituCategoryRef`）** 成员与对应全局管理权限。结果：这些库的用户能 `ListEntries` 加载全部文档，却在并行的 `getStoreGraph(storeId)` 上恒拿 403 → 文档星系显示「引用未知 + 无连线」，尽管他们对该库有合法读权限。

**影响面**：仅产品库/PM/识途库类型的非 owner/非团队成员；owner 与 public/团队共享库不受影响（如本仓库 prd_agent doc 库走 owner，正常）。前端已对 graph 403 做了显式降级（「引用关系加载失败 / 引用未知」chip，不再静默 0 引用），所以是「功能缺失」而非「静默错误」。

**推荐修法（SSOT，不留漂移）**：把 `CanReadStoreAsync` 那套读权限判定（`IsTeamShared` / `IsPmProjectMemberAsync(write:false)` / `IsProductKnowledgeMemberAsync` / `IsShituKnowledgeReadableAsync` / `GetEffectivePermissionsAsync`）抽成共享 helper（如 `DocumentStoreAccess` 服务或扩展方法），`MentionsController` 与 `DocumentStoreController` 共用，避免在两个控制器重复 ~80 行安全逻辑。改后走 `/cds-deploy` 远端编译 + 用一个产品/PM 库账号验证 graph 不再 403。

**为何暂缓**：属后端权限模型对齐（安全敏感），与本 PR 的星系前端 UI 是两个范畴；本地无 dotnet 需走 CDS 验证。2026-06-25 用户裁定「先记债务，之后专项处理」。

### 三、用户提出但暂未承诺的功能

- 拖文档进编辑器变成链接（`@` 的另一种触发方式）
- 工具栏「插入文档引用」按钮
- 选中文字 → 浮出「链到文档」（像微信选中弹「复制/翻译」）
- 双击宇宙图节点直接弹出文档预览侧抽屉（不离开宇宙）

### 四、风险监控

- **滥用风险**：恶意用户可能在文档里写一大堆 `[[]]` 撑账本。当前 `MentionService` 用 HashSet 去重，单文档对单 to 只保留一条；但 1 篇文档可链到 1000 个不同 to 仍然成立。需限流：单文档 mentions 上限（如 200）+ 告警。
- **隐私风险**：反向链接面板会暴露「谁引用了我」。如果跨用户/跨团队可见 mentions，可能泄露对方在编辑什么文档。MVP 通过 `CanReadAsync` 控制 store 级访问，OK；但跨库引用 v2 时需要重新审计权限路径。
- **性能风险**：参考 §1 的 10、15 项。

## 知识库跨库同步

跨库同步首版只做新增与更新、不传播删除，也只搬文本不搬二进制附件，本文记这些有意的取舍。

| 字段 | 内容 |
|---|---|
| 模块 | 知识库跨环境 / 本地库库 同步（`DocumentStoreSyncController` + `SyncManagerPanel`） |
| 状态 | open（首版已交付，2026-06-04；以下为已知边界） |
| 关联 | `prd-api/.../Controllers/Api/DocumentStoreSyncController.cs`、`prd-admin/src/pages/document-store/SyncManagerPanel.tsx`、集合 `document_store_sync_links`、`DocumentStore.SyncToken`、设计文档 [design.knowledge-base.store-sync.md](./design.knowledge-base.store-sync.md) |
| 提出 | 用户需求：两个环境（或同环境两个库）之间互相同步知识库内容，令牌永久有效、支持单向/双向、手动触发 + 改动检测 |

### 已知边界（首版有意不做，后续可补）

1. **不传播删除**：同步只做「新增 / 更新」幂等 upsert，永不删除对端条目。一侧删了文档，另一侧仍保留（符合「不丢数据」，但两侧会渐渐不一致）。后续可加「软删除标记 + 同步删除」开关。
2. **只同步文本正文**：Markdown / 文本条目同步正文；二进制附件（PDF / 图片 / 音视频）只在 bundle 里标 skipped，不搬文件体（与现有 export/import 一致）。需要搬附件得走附件存储跨环境复制。
3. **双向冲突 = 本地优先（无字段级合并）**：`both` 方向用「上次同步的两侧签名快照」判定哪侧改了；两侧都改的真冲突，共享条目以本地为准覆盖对端（用户已确认「不自动合并冲突」）。无三方合并、无 diff 选择。
4. **变更检测为库级粒度**：`待同步 / 同步完成` 基于整库签名（lineage|UpdatedAt|title 哈希）与上次同步快照对比，不是条目级。极端情况下「A 改一条、B 改另一条」会被判为两侧都改走冲突分支，而非各自合并。
5. **令牌为 per-store 永久令牌**：存在 `DocumentStore.SyncToken`，无 TTL（用户明确要求不过期）。撤销靠「撤销令牌 / 撤销配对」手动操作。令牌泄露 = 对端可读写该库，需用户自行保管链接。
6. **跨环境需网络互通**：remote 配对要求两个环境能互相 HTTP 访问（受 `ISafeOutboundUrlValidator` SSRF 约束，私网地址会被拒）。本地库库配对无此要求，走 DB 直读写。
7. **同步为同步阻塞调用**：`run` 端点同步执行 build/apply（含跨环境 HTTP），大库可能较慢。未来可改 Run/Worker 异步 + 进度 SSE（呼应 CLAUDE.md §6）。
8. **页面教程未补步**：文档空间新增「跨环境同步」页签，`document-store-page-guide` 暂未加对应 Tour 步骤（`.claude/rules/onboarding-tips.md`）。后续可补一步指向 `library-tabs` 锚点讲解同步入口。
9. **PM 项目库 / 产品知识库在同步 UI 与发现里缺席**（Codex PR #730 评审，多次）：后端 `LoadWritableStoreAsync` 已允许 PM 项目成员、产品成员 write-sync 这类库（与 `DocumentStoreController.CanWriteStoreAsync` 对齐），运行/改方向/删除（`LoadManageableLinkAsync` 凭 id）也都放行。但有两处只按「owner + 团队共享」口径，**有意排除** `PmProjectId` / `ProductKnowledgeRef` 非空的库：
   - 前端「启动链接 / 生成连接链接」选择器（拉 `mine` + 团队共享列表，列表端点本就排除隐藏库）；
   - 后端 `ListAllLinks` 的共享本地配对发现（候选集 = owner + 团队共享 store id，见 round-12 收窄）。
   结果：有权限的用户能凭 id 管理这些库的本地配对，但在「跨环境同步」页签既选不到、也看不到。完整补法需聚合「我可写的全部库（含隐藏的项目库/产品库）」——新增一个 `scope=writable-all` 后端端点（同时供选择器和 ListAllLinks 候选集复用），或前端额外拉项目/产品 KB 列表合并。属跨 Agent 聚合，留作后续；当前以 owner+团队共享为准（覆盖常规知识库主场景）。

### 后续可做（按价值排序）

- [ ] 删除传播（软删除标记 + 双向删除开关）
- [ ] 附件二进制跨环境搬运
- [ ] 同步异步化（Run/Worker + 进度 SSE），大库不阻塞
- [ ] 条目级变更检测 + 两侧各改不同条目时自动各自合并（不再一律走冲突）
- [ ] 冲突可视化：列出冲突条目让用户逐条选「用本地 / 用对端」
- [ ] 页面教程补「跨环境同步」一步

## 知识库版本管理

知识库版本管理的已落地范围与边界，含从文学创作那次「版本回滚删掉图片」吸取的教训。

> 模块：知识库（document-store）版本控制 / 图片插入 / 大小统计
> 最近更新：2026-06-16

### 背景

2026-06-16 客户演示反馈三类问题，本轮处理：

1. 插入图片/保存正文时整页刷新回到顶部，多图时定位丢失；github 订阅文档插入图片后图片"刷新一下消失"。
2. 知识库修改后没有版本，希望存历史版本（参考"文学创作版本曾导致图片丢失"，要更谨慎、可用独立存储、加测试）。
3. 希望看到知识库大小 / 图片大小。

### 本轮已落地

- **图片插入不刷新（根因修复）**：`DocBrowser` 的内容重拉 effect 以 `loadedContentKey=${entryId}:${updatedAt}` 为缓存键。
  此前每次本地保存会把父级 `entries[].updatedAt` 改新 → `selectedEntryData` 变化 → effect 用新 key 触发
  `loadEntryContent`（`setPreview(null)` 闪烁 + 滚动回顶 + 重新拉取，github 文档还可能拉回旧正文把图片盖没）。
  修复：保存路径统一走 `commitLocalSave`，用服务端返回的 `updatedAt` 把 `loadedContentKey` 推进到同一版本，
  effect 命中缓存键短路，不再重拉。`onSaveContent` 返回类型加 `{ updatedAt? }`。
- **版本控制**：独立集合 `document_entry_versions` + `DocumentVersionService`。`UpdateEntryContent` 每次保存
  先留改动前基线、再留新内容（hash 去重，留存上限 100）。新增端点：
  `GET entries/{id}/versions`、`GET entries/{id}/versions/{vid}`、`POST entries/{id}/versions/{vid}/restore`。
  恢复 = 把目标版本文本写回当前正文（恢复前先把当前内容快照保留），全程**只写文本、不删除任何图片资产**。
- **大小统计**：`GET stores/{id}/size` 聚合正文/附件/图片/历史版本字节与数量；前端标题栏徽章展示。

### 吸取「文学创作版本删图片」教训（已规避）

文学创作旧坑根因：版本切换时按 `ArticleInsertionIndex != null` **批量删除 image_asset**，且只按 SHA256 引用计数，
导致回看旧版本图片没了（见 [doc/report.2026-W12.md](./report.2026-W12.md) PR #303）。

知识库版本**从机制上不会重演**：KB 正文里的图片是 markdown 外链 URL（COS / 外部），不是受版本管理的 image_asset。
版本快照只存文本；恢复 = 写回文本，URL 始终有效，**不触发任何资产删除**。单测
`DocumentVersionLogicTests.ImageMarkdown_PreservedInSnapshot_TextOnly_NoAssetTouched` 固化该不变量。

### 已知边界 / 后续可补

- **github / RSS 每日同步覆盖**：后台定时同步仍可能用远端（无图）正文覆盖本地手动编辑（属罕见、非即时路径）。
  本轮不改同步语义；安全网是版本历史——被覆盖前的用户内容已快照，可在「历史版本」一键恢复。
  后续可补：同步覆盖手动编辑前先 `SnapshotAsync(source=sync)`（`ApplyContentToEntryAsync` 已具备能力，
  但 RSS/GitHub Worker 的写入路径尚未接入版本快照，是当前主要缺口），或给手动编辑过的订阅条目加"本地优先/冲突提示"。
- **大小统计口径**：`totalBytes` = 正文字节 + 附件字节（图片含在附件里）。markdown 里**外链图片 URL** 的真实
  字节无法不发请求得知，故未计入 `imageBytes`（`imageBytes` 仅统计 `Attachment.Type=Image` 的上传图片）。
  ParsedPrd 内容寻址去重时，多 entry 共享同一 Document 会在按 entry 累加正文字节时少量重复/偏差，当前按
  documentId 去重后求和，足够"判断大小量级"，非精确账单级。
- **版本留存上限 100**：超出裁剪最旧。极重度编辑的文档更早的历史会丢；如需永久留存可调大或冷归档。
- **版本 diff**：弹窗目前是「整篇正文预览 + 恢复」，未做逐行 diff 高亮，后续可补。
- **大小徽章刷新**：`refreshKey` 绑 `entries.length`，增删条目即时刷新；同一条文档内容增大不一定即时刷新，
  重进库或增删条目后准确。
- **索引**：`document_entry_versions` 未建索引（项目规则禁止应用自动建索引）。按 `EntryId`/`StoreId` 查询量大时，
  需 DBA 手动建 `{EntryId:1, VersionNumber:-1}` 与 `{StoreId:1}` 索引（见 [doc/guide.platform.mongodb-indexes.md](./guide.platform.mongodb-indexes.md)）。

## 知识库文档阅读器

多个阅读型页面本可统一成一个文档阅读器，本文记为什么这次没融合与重新评估的条件。

| 字段 | 内容 |
|---|---|
| 模块 | 殿堂阅读器（公开知识库浏览） |
| 状态 | open · 已评估不合 |
| 关联 | `prd-admin/src/pages/library/LibraryDocReader.tsx`（720 行）、`prd-admin/src/pages/library/LibraryStoreDetailPage.tsx`（140 行）、`prd-admin/src/components/doc-browser/DocBrowser.tsx` |
| 创建 | 2026-05-28 |

### 背景

2026-05-28 在做"统一文档阅读器"收口时，把 `DocumentStorePage`、`LibraryShareViewPage`、`WeeklyReportsTab` 三处都收敛到了 `DocBrowser` 共享组件（删了 1425 行重复实现）。**殿堂阅读器 `LibraryDocReader.tsx` 是有意保留没动**，本文件记录留债原因与未来融合条件，避免下次 session 又重新评估一次。

---

### 为什么这次没融合

`LibraryDocReader` 是公开知识库（殿堂）的专用阅读器，**视觉刻意做了差异化**：

- 米黄底色 `#FFFBF0`（vs DocBrowser 的深色玻璃）
- 圆体字 `'Nunito', 'Fredoka', sans-serif`
- 厚边框白卡片 + 暖色调（vs DocBrowser 的玻璃灰）
- 图标走 `#F59E0B` 琥珀色（vs DocBrowser 的蓝/灰）

这是**殿堂品牌的视觉差异化**——让用户进到「对所有人公开」的殿堂时，立刻感知到"这是公共陈列馆"而不是"工作台"。强制套 DocBrowser 的深色玻璃风会破坏这种区分。

数据契约是**完全可融合的**（左侧 `DocumentEntry[]`，右侧 markdown content，跟 DocBrowser 完全同构），仅卡在视觉皮肤。

---

### 已知工程债务

| ID | 说明 | 优先级 | 触发条件 | 状态 |
|---|---|---|---|---|
| LDR-1 | **DocBrowser 缺皮肤系统**：当前 `appearance` prop 只有 `inset` / `cards` 两种，都是深色玻璃基线。融合 LibraryDocReader 需要新增 `appearance: 'warm-public'`（或更通用的 theme/skin 体系），把"米黄底 + 暖色调 + 圆体字"封装为 token 集合。改造面：DocBrowser 内所有硬编码颜色（`border-token-subtle`、`bg-token-nested` 等）需走 token 转写，否则切皮就漏。预估 ~1 天。 | P3 | 殿堂被业务要求改造（如加新功能、改交互），或团队决定彻底统一视觉收口 | open |
| LDR-2 | **LibraryStoreDetailPage 是 LibraryDocReader 的直接调用方**：140 行薄壳，融合 LDR-1 后会跟着改 70 行左右（移除自己的数据 fetch + format 转换，直接传给 DocBrowser）。LDR-1 没动它就别动。 | P3 | LDR-1 落地后 | blocked-on-LDR-1 |
| LDR-3 | **后续 DocBrowser 优化拿不到殿堂**：现在私人知识库 / 分享 / 周报三处共享 DocBrowser，任一优化三处同步获益；**殿堂第四处不在内**。如：分享页加了 `?entry=` URL 高亮，殿堂没有；周报加了双卡片布局，殿堂没有。每次 DocBrowser 升级都要同步评估殿堂要不要也加。 | P2（持续累积） | DocBrowser 加大改动时 | open |
| LDR-4 | **殿堂的"克莱风"无 design 文档背书**：当前视觉差异化是隐式约定，没写在任何 design.* 里。如果有新设计师加入团队，可能误把殿堂统一回深色。建议补 `doc/design.library-visual-language.md` 写清"为什么殿堂用暖色 = 公共陈列馆隐喻"。 | P3 | 视觉迭代或新设计师 onboarding | open |

---

### 重新评估的条件

下面任一条件满足时，才值得重新评估"要不要融合"：

1. 殿堂被要求加 DocBrowser 已有但 LibraryDocReader 没有的能力（如全文搜索、文件夹树、字幕生成等）
2. DocBrowser 完成皮肤系统改造（独立项目），融合成本降到 ~半天
3. 用户反馈"殿堂阅读体验和我自己的知识库不一致让我困惑"
4. 团队决定彻底放弃"殿堂 vs 工作台"视觉区分，统一品牌

**当前不满足任一条件 → 维持现状，不动**。

---

### 反面参考

否 "顺手把殿堂也融合了" — 720 行视觉细节，半天改不完；改完会破坏品牌差异化，要回滚成本更高
否 "给 DocBrowser 加 theme prop 同时改三处" — 改造面太大，不该跟"周报融合"打包做

正确路径见 `frontend-architecture.md` 复用原则 + `no-rootless-tree.md` 借用法则。

## 知识库知识星球与宇宙图并存

知识库里并存两套关系可视化（星系与宇宙图），本文记本轮处置、待办与为什么先记债不合并。

> **关联**：星系视图、宇宙图页面、库详情入口三处（文件见文末「实现来源」）。

### 一、背景

知识库目前有两套「图谱」视图，心智完全不同：

| 视图 | 是什么 | 数据 |
|------|--------|------|
| 知识星球 / 3D 星系 | 按 `{type}.{appname}[.{sub}]` 命名层级把文档摆成 3D 星系（根→分类→应用→子模块→文档星） | 纯文档树 + 命名分类，无需引用关系 |
| 宇宙图 / obsidian 群星 | obsidian 风力导向图，靠 `mentions`（双链/反向链接）连边 | 依赖 `mentions` 账本，部分库该接口 403 时是错误页 |

用户 2026-06-26 反馈两点问题：

1. **返回关系混乱**：从星系「返回」会落到宇宙图（obsidian 群星列表），但用户认为这两个不是一回事，不该互为返回目的地。
2. **二选一困惑**：用户分不清某个库该看星系还是宇宙图，期望系统能「智能判别该展示哪一个」。

### 二、本轮处置（2026-06-26，临时收口）

- 星系「返回」一律回到**该知识库详情**，不再回宇宙图（`GalaxyStandalonePage.back()` 去掉按来源分流）。
- 库详情「更多」菜单**收起「关系图谱/宇宙图」入口**，只保留「知识星球（3D 星系）」直达；宇宙图路由 `/document-store/:storeId/universe` 仍在，深链可达（旧链接不破）。
- 即「默认先只展示星系」。

### 三、待办（转后续）

#### 1. 智能判别该库展示星系还是宇宙图 — 待做
判据候选：
- 该库 `mentions` 边数 / 双链密度高（值得力导向图）→ 提供宇宙图；否则只给星系。
- 该库文档命名规范度（多少比例文档能解析出 `{type}.{appname}` 分类）→ 高则星系层级清晰，优先星系。
- 该库 `mentions` 接口是否 403 / 是否启用引用网络 → 否则宇宙图必然是空图/错误页，不该展示。
落点：库详情据此**只暴露合适的那一个入口**，或在一个入口里给「切换视图」子菜单，而非两个并列入口让用户猜。

#### 2. 宇宙图顶栏残留文案 — 待做（被本轮隐藏入口绕过，未根治）
用户截图指出宇宙图返回后左上角「怎么有字」（返回 + 库名 + 竖线分隔的视觉冗余）。本轮通过隐藏入口规避；将来若重新启用宇宙图，需清理其顶栏（与星系顶栏统一风格）。

### 四、为什么记债而不是现在就做

「智能判别」需要先有 `mentions` 密度 / 命名规范度的统计口径，且要决定交互形态（自动二选一 vs 手动切换），属于产品决策 + 数据指标双前置，超出本轮 UI 收口范围。先以「默认只展示星系」消除用户当下的困惑与错误返回，判别逻辑落地后再放开宇宙图。

---

## 录音词云的分词质量 — 已偿还（2026-08-11 换 Intl.Segmenter）

**原欠账**：中文没有空格，词云曾用 2 字滑窗切词。滑窗必然产出骑在词缝上的半截词
（交付+质量→付质、参考+图→考图、看+一下→看一）。

**三次失败的补救**（记下来，免得后来人再走一遍）：按词形猜锚点 → 把真词「质量」顶掉；
按位置抢座 → 平局时相位错开，抢到座的全是半截词；按上下文多样性 → 拦不住「看一」，
因为它在真实语料里两侧都有变化（你看一下 / 我看一下、看一下 / 看一眼），
统计上和真词无法区分。**这是方法的天花板，不是参数没调好。**

**现在的做法**：V8 自带的 `Intl.Segmenter`（词典分词，零依赖零网络）。
它查词典，直接不产生这类切分；单字一律不进词云。

**换来的新代价（有意选的）**：ICU 词典不认识的词会整个丢掉。验收判据是
「无法确定边界时不收录」，所以精度优先于召回。守卫用例把这条损失钉成已知项，
它变红说明分词器换了，需要重新评估召回。

实测丢掉的三类，按要紧程度排：

| 类别 | 实例 | 影响 |
|---|---|---|
| 人名 | 「泽坤」——换分词器前在词云里，之后没了 | **最要紧**。会上被反复叫到的人名恰恰是高价值信息，丢了比多一个半截词更伤 |
| 业务术语 | 待收集 | 团队黑话不在通用词典里，是同一类问题 |
| 普通双字词 | 「下单」「排期」 | ICU 词典覆盖不全，影响相对小 |

**召回怎么补回来（2026-08-12 已落地）**：叠加词典，**不退回双字滑窗**——
滑窗的半截词问题已经证明治不好（见上面三次失败的补救）。词典分三层合并：

| 层 | 谁维护 | 说明 |
|---|---|---|
| 说话人名 | 无人维护 | 笔记本身带 `[说话人]` 标签，直接进词典。人名这条最要紧的损失零配置就补上了 |
| 系统级 | 有设置写权限的人 | 全局表，所有人默认引用。产品名、团队黑话放这里 |
| 个人级 | 每个用户自己 | 只影响自己；还能单独屏蔽系统表里对自己是噪音的词 |

关键约束：**词典只做「加」不做「猜」**。命中的整词先被切走，剩下的才交给分词器，
所以不会引入新的边界猜测，也就不会把已经治好的半截词问题带回来（有守卫用例钉住）。
入口放在词云正下方——发现「某个词该在却不在」正是在看这一屏的时候，
逼用户跑去设置页再回来是绕路。

**还欠什么**：系统级词典目前只能一条一条加，没有批量导入/导出；
个人屏蔽表有后端字段和 API，但界面上还只能加不能屏蔽。

**两条已核实、本 PR 未修的缺陷（Review 九轮提出，范围熔断后按 B 类记账）**：

| 缺陷 | 判据（已在源码核实） | 为什么没在本 PR 修 |
|---|---|---|
| 两个管理员并发加词会互相覆盖 | 写端点是 `.Set(x => x.TranscriptLexicon, terms)` 无条件整表替换。两人从同一份快照各加一个词，后提交的那次把前一次的词抹掉——系统级抹的是所有人共用的表。组件里的保存锁只串行化单个实例，跨客户端不管用 | 要修得上「原子增量端点」或「版本/CAS 校验」，两者都是这条资源上没有过的新语义（乐观并发）。属规则 5.5 的 B 类 |
| 超过 24 字的词条被静默丢掉 | 端点 `.Where(x => x.Length is >= 2 and <= 24)` 过滤后仍返回 `Ok`；前端输入框没有 `maxLength`、按钮只拦 `< 2`，所以能提交。提交后输入框被清空、刷新回来词没了——界面表现是「存成功了又不见了」。个人词典路径同样如此 | 修法很小（输入框加 `maxLength={24}` + 一句提示，约两行，不引入新语义），但熔断已在第 8 个 Review 修复提交命中，且 PR 未合并、缺陷不会流到用户手上。等所有者说继续就修 |

**剩余风险**：极旧浏览器没有 `Intl.Segmenter` 时中文词云会退化为空（英文词仍统计）。
本系统是内部工具、目标浏览器均已支持，暂不做兼容层。

---

## 实现来源

给要跳去看代码的人；只读这篇文档的人可以整块跳过。

| 位置 | 文件 |
|------|------|
| 总览 | `prd-admin/src/stores/docReaderPrefsStore.ts` |
| 划词评论 | `prd-admin/src/components/doc-browser/`（阅读器 + 批注浮层 / 批注栏 / 输入框）、`prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreController.cs`（recent-comments）、`.claude/skills/create-visual-test-to-kb/scripts/read_comments.py` |
| 划词 AI 改写 / 配图 | `prd-admin/src/components/doc-browser/`（SelectionAiPopover / SelectionImagePopover / selectionEdit.ts）、`prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreController.cs`（selection-rewrite SSE）、`prd-api/src/PrdAgent.Infrastructure/Services/SelectionRewriteActionRegistry.cs` |
| 划词编辑单测 | `prd-admin/src/components/doc-browser/__tests__/selectionEdit.test.ts` |
| 双链自动补全 | `prd-admin/src/components/doc-browser/WikilinkAutocomplete.tsx` |
| 星系与宇宙图 | `prd-admin/src/pages/document-store/DocumentGalaxyView.tsx`、`prd-admin/src/pages/document-store/UniverseGraphPage.tsx`、`prd-admin/src/pages/document-store/DocumentStorePage.tsx` |
| 录音词云 | `prd-admin/src/components/doc-browser/transcriptSegments.ts`（`buildTranscriptWordCloud` / `FUNCTION_CHARS` / `STOP_WORDS`）、`prd-admin/src/components/doc-browser/__tests__/transcriptSegments.test.ts`、`prd-admin/src/components/doc-browser/TranscriptKaraoke.tsx` |
