| fix | prd-admin | 智识殿堂文档阅读器（LibraryDocReader）补齐 remark-breaks 插件，保留单行换行符，避免纯文本/排版文档被 markdown 合并成一整段 |
| fix | prd-admin | 文档空间 /document-store 的 DocBrowser 同步补齐 remark-breaks 插件，修复 ASCII 框图/步骤箭头被压成一段的问题 |
| fix | prd-admin | 修复 LibraryDocReader/DocBrowser 代码块判断逻辑：原代码用 `language-` 类名判断 inline，导致未指定语言的 fenced code block（架构图/树形结构等）被错当成 inline 渲染成一颗颗药丸。改为按"内容含换行"判断块级 |
| fix | prd-admin | LibraryDocReader/DocBrowser 无语言 fenced 代码块跳过 Prism，改用纯 `<pre>` 渲染，消除 ASCII 框图上 Prism token 背景叠加导致的"多余背景色块"；同步 override `pre` 为 fragment 避免双重包裹 |
| fix | prd-admin | 举一反三：MarkdownContent（共享组件，周报/技能页等 5 处消费）和 ai-toolbox ToolDetail 的 AssistantMarkdown 存在同构 Bug A+B，同步修复（含 `pre` fragment override） |
| fix | prd-admin | 补齐 `remark-breaks` 插件：ArticleIllustrationEditorPage（7 处）、ConfigManagementDialog、VideoAgentPage、SubmissionDetailModal、RichTextMarkdownContent、GroupsPage、DefectDetailPanel、AiChatPage、ArenaPage、LlmRequestDetailDialog、LlmLogsPage、marketplaceTypes，统一单行换行行为 |
| fix | prd-desktop | KnowledgeBasePage 补齐 `remark-breaks` 插件，与管理端统一 |
