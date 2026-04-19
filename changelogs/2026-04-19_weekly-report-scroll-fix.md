| refactor | prd-admin | 重写 map 周报标签页：弃用 GitHub 订阅流程，改为从任一已有知识库挑选 + 前端文件名关键词过滤，配置存 sessionStorage |
| feat | prd-admin | map 周报标签页进入后自动选中最新的一篇（按 lastChangedAt/updatedAt/createdAt 倒序），不强依赖"本周" |
| fix | prd-admin | 修复 map 周报页目录树与预览内容联动滚动：改用纯 inline-style 2-pane 布局，强制 minHeight:0 + overflowY:auto 独立滚动 |
| fix | prd-admin | 修复 DocBrowser 强制 minHeight:calc(100vh-160px) 撑破父级导致 AppShell 主滚动的问题 |
| fix | prd-admin | 清理分支上遗留的 TS 编译错误（未用 import、listDocumentEntries 参数个数、EntryPreview 导入路径） |
