| refactor | prd-admin | 重写 map 周报标签页：弃用 GitHub 订阅流程，改为从任一已有知识库挑选 + 前端文件名关键词过滤，配置存 sessionStorage |
| feat | prd-admin | map 周报标签页进入后自动选中最新的一篇（按 git commit time 倒序，若缺失则回退到同步时间） |
| feat | prd-admin | map 周报列表为本周有新提交的条目显示绿色 NEW 徽标，时间来源区分 "git" vs "同步" |
| feat | prd-api | GitHubDirectorySyncService 同步时从 GitHub commits API 拉取文件最近提交时间，存入 Metadata.github_last_commit_at；历史条目在下次同步命中 skip 分支时自动回填 |
| fix | prd-admin | 修复 DocBrowser 文件树滚动"不跟手"：移除 overscroll-behavior:contain（父级已 overflow:hidden，无需再拦截），TreeNode 的 transition-all 收窄为 transition-colors，避免滚动时 layout transition 造成漂移感 |
| fix | prd-admin | 修复 map 周报页目录树与预览内容联动滚动：改用纯 inline-style 2-pane 布局，强制 minHeight:0 + overflowY:auto 独立滚动 |
| fix | prd-admin | 修复 DocBrowser 强制 minHeight:calc(100vh-160px) 撑破父级导致 AppShell 主滚动的问题 |
| fix | prd-admin | 清理分支上遗留的 TS 编译错误（未用 import、listDocumentEntries 参数个数、EntryPreview 导入路径） |
