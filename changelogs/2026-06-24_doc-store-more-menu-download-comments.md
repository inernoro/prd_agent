| fix | prd-admin | 修复知识库顶栏「更多」下拉被 PageHeader 的 overflow-hidden 裁切/遮挡，新增可复用 AnchoredMenu（createPortal 到 body + 锚点定位 + 视口夹取/上翻 + 点外/ESC 关闭），知识库卡片「更多」同步改用 |
| feat | prd-admin | 知识库顶栏「更多」新增「下载全部文档（ZIP）」，逐篇导出正文为 .md、二进制附件下载原文件后打包，带进度 toast |
| polish | prd-admin | 知识库划词评论改为「默认内联，点击某条 → 右侧批注栏展开，关掉即回内联」，移除「批注栏/内联」布局切换开关（activeCommentKey 单独驱动），删除不再使用的 docReaderPrefsStore |
