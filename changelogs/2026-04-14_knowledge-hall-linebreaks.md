| fix | prd-admin | 智识殿堂文档阅读器（LibraryDocReader）补齐 remark-breaks 插件，保留单行换行符，避免纯文本/排版文档被 markdown 合并成一整段 |
| fix | prd-admin | 文档空间 /document-store 的 DocBrowser 同步补齐 remark-breaks 插件，修复 ASCII 框图/步骤箭头被压成一段的问题 |
| fix | prd-admin | 修复 LibraryDocReader/DocBrowser 代码块判断逻辑：原代码用 `language-` 类名判断 inline，导致未指定语言的 fenced code block（架构图/树形结构等）被错当成 inline 渲染成一颗颗药丸。改为按"内容含换行"判断块级，未指定语言时降级为 text 高亮 |
