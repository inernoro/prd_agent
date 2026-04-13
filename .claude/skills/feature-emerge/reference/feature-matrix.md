# 市面文档产品功能矩阵

> 被 SKILL.md 引用。涌现设计时用于对标定位。

## 产品定位速查

| 产品 | 核心定位 | 杀手锏 |
|------|---------|--------|
| **Notion** | 全能工作区 | Block 编辑器 + 内嵌数据库 + 多视图 |
| **Confluence** | 企业知识库 | 审批工作流 + 3000+ 插件生态 |
| **Google Docs/Drive** | 协同编辑 | 实时协同标杆 + OCR 搜索 + 生态 |
| **Gitbook** | 开发者文档 | Git 同步 + Change Request 审阅 |
| **语雀** | 团队知识管理 | 内容类型最丰富（思维导图/画板/演示文稿） |
| **飞书文档** | 办公协作 | 与 IM/日历/审批深度集成 |
| **Obsidian** | 个人知识库 | 本地优先 + 知识图谱 + 1000+ 插件 |
| **BookStack** | 自托管 Wiki | 固定 4 级层级、简洁清晰 |

## 10 维功能对比

### 1. 文档组织

**共性标配**：树状层级 + 标签 + 收藏 + 拖拽排序 + 侧边栏导航

**差异亮点**：
- Notion：数据库视图（看板/日历/画廊/时间线），同一数据多种视图
- Obsidian：纯本地文件夹 + YAML 元数据标签，组织自由度最高
- BookStack：书架→书→章→页固定 4 级，结构清晰但灵活性低
- 语雀：知识库级别独立 + "小记"快速笔记入口

**对我们的启示**：DocumentStore（空间）→ DocumentEntry（条目）两级结构足够。后续可加"目录/分组"实现三级。标签系统已内置（Tags 字段）。

### 2. 内容类型

**共性标配**：富文本 + Markdown + 代码块 + 表格 + Mermaid 图表

**差异亮点**：
- Notion：Block 编辑器，页面可混合文本/数据库/嵌入
- 语雀/飞书：原生思维导图、画板、演示文稿、多维表格
- Gitbook：代码块最优体验（语法高亮、行号、复制、代码组）
- Obsidian：通过插件生态支持任意内容类型

**对我们的启示**：当前已有 ParsedPrd（Markdown 解析）+ Attachment（文件存储）。优先支持 Markdown/纯文本/PDF/Word/Excel 的导入存储。Block 编辑器是重投入，暂不考虑。

### 3. 协作功能

**共性标配**：评论/批注 + 版本历史 + 权限控制 + 分享链接

**差异亮点**：
- Google Docs：实时协同 + "建议模式"业界标杆
- Confluence：审批工作流最成熟
- Gitbook：Git 分支 → "变更请求"，类似 PR 的文档审阅
- 飞书：与 IM/日历/审批深度集成

**对我们的启示**：实时协同投入巨大（CRDT/OT），不做。分享链接（已有 ShareLink 模式可复用）和版本历史是务实选择。

### 4. 搜索与发现

**共性标配**：全文搜索 + 过滤器 + 最近访问 + 搜索预览

**差异亮点**：
- Google Drive：最强搜索，OCR 识别图片/PDF 内文字
- Confluence：CQL 复杂查询语言
- Obsidian：正则 + 逻辑运算 + 路径过滤

**对我们的启示**：MongoDB text index 可提供基础全文搜索。结合 Attachment.ExtractedText，可搜索 PDF/Word 文档内容。高级搜索需 Atlas Search 或 Elasticsearch。

### 5. 导入/导出

**共性标配**：PDF 导出 + Markdown 导入 + API 访问

**差异亮点**：
- Obsidian：文件即数据，Vault = 本地文件夹，无需"导出"
- Google Takeout：完整数据导出
- Gitbook：Git 同步，文档即代码仓库
- Notion：支持从 Confluence/Evernote/Trello 多竞品导入

**对我们的启示**：导入 Markdown/PDF/Word + 导出 Markdown/原文件 是 P0。批量导入是 P1。

### 6. 知识图谱/双向链接

**共性标配**：页面互链是基础能力

**差异亮点**：
- Obsidian：`[[wikilink]]` + 反向链接面板 + Graph View 知识图谱可视化
- Notion：Synced Blocks（跨页面同步）+ Relation（数据库关联）
- 语雀：简单知识图谱可视化

**对我们的启示**：双向链接需新模型（DocumentLink），是 P3。知识图谱可视化前端投入大，P4。但文档间的简单引用关系（DocumentEntry.Metadata 中存 relatedEntryIds）可快速实现。

### 7. 模板系统

**共性标配**：自定义模板 + 内置模板库

**差异亮点**：
- Notion：数据库级模板（新建条目自动套用）+ Template Button
- Confluence：蓝图系统，支持变量和结构化创建
- Obsidian：Templater 插件，JavaScript 脚本模板

**对我们的启示**：可在 DocumentStore 上添加 `templateContent` 字段，新建条目时预填。轻量级实现。

### 8. 下载/导出格式

| 格式 | 覆盖率 | 难度 |
|------|--------|------|
| PDF | 所有产品都支持 | 中（需要渲染引擎） |
| Markdown | 大部分支持 | 低（ParsedPrd.RawContent 直出） |
| HTML | 所有产品都支持 | 低（Markdown → HTML） |
| DOCX | 部分支持 | 中（需 Pandoc 或类似库） |
| 原文件 | 所有产品都支持 | 无（Attachment.Url 直接下载） |

**对我们的启示**：Markdown 原文 + 原文件下载 是零成本 P0。PDF 导出需要 Markdown-to-PDF 渲染，P1。

### 9. API 与集成

**共性标配**：REST API + Webhook + OAuth/SSO

**对我们的启示**：当前 DocumentStoreController 已提供 REST API。后续可加 Webhook 通知文档变更事件。

### 10. AI 功能

| 功能 | 产品覆盖 | 对我们的价值 |
|------|---------|-------------|
| AI 写作助手 | Notion AI / Gemini / 飞书 My AI | 有 ILlmGateway，可快速实现 |
| 文档摘要 | 几乎所有 | P1，直接调 LLM |
| Q&A 知识问答 | Notion AI Q&A / GitBook Lens / NotebookLM | P2，需要 Sections 分块 + RAG |
| 自动标签/分类 | Google Drive 自动分类 | P1，调 LLM 提取关键词 |
| 翻译 | 几乎所有 | 有 LLM 即可 |

**对我们的独特优势**：已有 ILlmGateway + 模型池调度，可以比竞品更灵活地选择最适合的模型处理不同任务。

## 涌现优先级矩阵

基于"价值/成本"比排序：

| 优先级 | 功能 | 价值 | 成本 | 依赖 |
|--------|------|------|------|------|
| **P0** | 文档内容上传（文本+文件） | ⭐⭐⭐⭐⭐ | ⭐ | DocumentService + Attachment |
| **P0** | 文档下载（Markdown/原文件） | ⭐⭐⭐⭐⭐ | ⭐ | ParsedPrd.RawContent |
| **P1** | AI 自动摘要 | ⭐⭐⭐⭐ | ⭐⭐ | ILlmGateway |
| **P1** | AI 自动标签 | ⭐⭐⭐⭐ | ⭐⭐ | ILlmGateway |
| **P1** | 公开分享链接 | ⭐⭐⭐⭐ | ⭐⭐ | ShareLink 模式 |
| **P1** | 全文搜索 | ⭐⭐⭐⭐ | ⭐⭐⭐ | MongoDB text index |
| **P1** | 批量导入 | ⭐⭐⭐ | ⭐⭐ | 文件上传 |
| **P2** | 文档 Q&A | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | LLM + Sections 分块 |
| **P2** | 版本历史 | ⭐⭐⭐ | ⭐⭐⭐ | 新集合 |
| **P2** | 模板系统 | ⭐⭐⭐ | ⭐⭐ | DocumentStore 字段 |
| **P2** | PDF 导出 | ⭐⭐⭐ | ⭐⭐⭐ | Markdown-to-PDF 渲染 |
| **P3** | 双向链接 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 新模型 + 解析 |
| **P3** | Webhook 通知 | ⭐⭐ | ⭐⭐ | 现有 Webhook |
| **P3** | 知识图谱可视化 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 双向链接 + 前端 |
| **P4** | 协同编辑 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | CRDT/OT（重度） |
