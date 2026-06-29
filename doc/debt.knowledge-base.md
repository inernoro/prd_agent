# debt.knowledge-base

| 字段 | 内容 |
|---|---|
| 模块 | 知识库（AI Toolbox `KnowledgeBaseIds` + 文档空间 `document_stores`） |
| 状态 | open |
| 关联 | `prd-api/src/PrdAgent.Api/Controllers/Api/AiToolboxController.cs`、`prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreController.cs`、`prd-admin/src/pages/ai-toolbox/components/*.tsx` |

---

## 背景

2026-05-21 review 发现两个层面的债务：

1. AI Toolbox 的【快速创建向导】(`QuickCreateWizard.tsx`) 第 3 步「测试调优」面板的"知识库"区块**长期是禁用占位符**（"即将上线"），而完整版编辑器 `ToolEditor.tsx` 早就把上传 + 注入跑通了。本次 PR 把占位符替换为可用 UI（复用 `ToolEditor` 同一套 `uploadAttachment` + `attachmentId → KnowledgeBaseIds` 路径），但同时暴露了更深层的架构与功能债务。

2. 系统并存**两套"知识库"实现**，命名相同语义不同，长期没整合。

---

## 已知工程债务

| ID | 说明 | 优先级 | 触发条件 | 状态 |
|---|---|---|---|---|
| K-1 | **两套"知识库"并存**：AI Toolbox 的 `ToolboxItem.KnowledgeBaseIds` 指向 `attachments` 集合（每条 `Attachment` 自带 `ExtractedText`，prompt 拼装时整篇拼接，见 `AiToolboxController.cs:1197-1212`），而独立的「文档空间」走 `document_stores` + `document_entries` 集合，有更完整的多类型、订阅源、版本、view event 等能力。两套数据流不通，AI Toolbox 选不到文档空间里已经管理好的文档。建议规划"统一知识库"模型：AI Toolbox 改为引用 `documentEntryId`（或一个虚拟 store 包一组 attachment），并写一次迁移把存量 attachment 落入 document_stores。 | **P2** | 用户开始把同一份文档既上传到智能体又导到文档空间，或要求"我已经在文档空间里有这堆 PDF，直接关联给智能体" | open |
| K-2 | **无 RAG / Embedding / 语义检索**：`AiToolboxController.cs:1197-1212` 把所有绑定文档的 `ExtractedText` 全量拼到 system prompt 里。文档稍微多 / 稍微大就会把 prompt 撑爆 token。`design.knowledge-base.multi-doc.md:334` 把这件事标为 Phase 3（未来），但没有项目计划承接。借用法则（`no-rootless-tree.md`）建议借外部 Embedding 服务而不是自建，但需要：(a) LLM Gateway 增加 `embedding` ModelType 调度路径；(b) chunk 切分策略（按段落 / 按 token 数 / 按文档类型）；(c) 向量存储（MongoDB Atlas Vector Search vs 自建索引）；(d) 检索召回 + 重排 + 注入。 | **P1**（中型功能立项） | 出现"上传了 10+ 文档导致对话被截断 / 慢 / 上下文超限"的反馈 | open |
| K-3 | **AI Toolbox 占位符里曾误导用户**：替换前的 `QuickCreateWizard.tsx:1460-1472` 写"即将上线"，让用户以为功能即将就绪，但底层数据通路（DTO、Model、Controller 注入）早已 ready。这种"前端 UI 写 wip 标签 vs 后端早已 ready"的不一致没有自动巡检手段，未来类似情况可能继续出现。建议在 `navCoverage.test.ts` 类似的 CI 守卫里加一条："禁止 UI 出现「即将上线」/「敬请期待」字样的 disabled 按钮 —— 要么标 TODO 接通，要么去掉。" | P3 | 下次新 PR 又留下"即将上线"占位符 | open |
| K-4 | **`uploadAttachment` 与 `documentstore/entries/upload` API 不互通**：AI Toolbox 走 `POST /api/ai-toolbox/upload-attachment`（返回 `attachmentId`），文档空间走 `POST /api/document-store/stores/{id}/entries/upload`（返回 `entryId`）。两个端点各有 mime 解析、文本抽取、缓存逻辑，未来文档解析能力升级（如新增 Excel 智能化抽取）需双改。建议合并到一个上传 service。 | P3 | 升级 PDF/Word 抽取库 / 新增 Excel 表格化抽取时双向同步 | open |
| K-5 | **不存"原始 KB 选择来源"**：AI Toolbox 智能体的 `KnowledgeBaseIds` 只存 `attachmentId`，不区分"用户当时是直接上传文件" vs"从文档空间选了一个 entry"。一旦 K-1 落地后会丢失这层语义，难以反向追溯。建议增加 `KnowledgeBaseSources: List<{type: "attachment"\|"document-entry", id}>` 结构存原始引用。 | P3 | K-1 立项后 | blocked-on-K-1 |
| K-6 | **缺少"按 documentType 过滤"的技能权重**：`design.knowledge-base.multi-doc.md:604` 标"未来（documentType 级别）"。当前技能只能 `contextScope=all/current/prd/none`，不能说"我这个技能只看 product 类型的文档"。整合 K-1 时一起做。 | P3 | K-1 立项后 | blocked-on-K-1 |
| K-7 | **访问统计无应用层消费**：`document_store_view_events` 集合已经在记数据（含 `ViewDedupWindow` 去重），但没有"热度排序"、"用户协同推荐"、"最近访问的知识库快速接入智能体"之类的应用。 | P4 | 用户反馈"找不到我之前上传过的文档"时 | open |
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

- `design.knowledge-base.store.md` —— 文档空间设计
- `design.knowledge-base.multi-doc.md` —— 多文档知识库设计（含 Phase 3 RAG 未做的明确标记）
- `.claude/rules/no-rootless-tree.md` —— 借用法则
- `.claude/rules/codebase-snapshot.md` —— 现有快照里"RAG/embedding 未实现"的说法在此处固化
