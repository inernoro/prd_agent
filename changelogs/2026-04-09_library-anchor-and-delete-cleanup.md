| fix | prd-api | 删除知识库/文档时级联清理 document_sync_logs、ParsedPrd 正文、attachments 附件、likes/favorites/share_links；删除文件夹或 GitHub 目录订阅时递归清理子条目 |
| fix | prd-admin | 删除知识库/文档/文件夹前弹出液态玻璃二次确认（systemDialog），明确列出将清除的数据范围 |
| fix | prd-admin | 修复智识殿堂文档内锚点链接 bug：锚点/站内链接不再强制新开标签页，改为 SPA 内 scroll；外链保留 target=_blank |
| fix | prd-admin | 智识殿堂支持从 URL hash 深链：复制 `/library/{id}#章节` 打开后自动滚动到对应章节 |
| feat | prd-admin | 智识殿堂 LibraryDocReader 新增：顶部搜索框（标题+正文第一行模糊匹配）、标题显示模式切换（文件名 ↔ 正文第一行） |
| feat | prd-admin | DocBrowser 与 LibraryDocReader 的 Markdown 渲染器升级：支持 KaTeX 数学公式、heading 带稳定 slug ID、任务列表专属样式 |
