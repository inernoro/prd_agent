| refactor | prd-admin | 重写 map 周报标签页：弃用 GitHub 订阅流程，改为从任一已有知识库挑选 + 前端文件名关键词过滤，配置存 sessionStorage |
| feat | prd-admin | map 周报标签页进入后自动选中最新的一篇（按 git commit time 倒序，若缺失则回退到同步时间） |
| feat | prd-admin | map 周报列表为本周有新提交的条目显示绿色 NEW 徽标，时间来源区分 "git" vs "同步" |
| feat | prd-api | GitHubDirectorySyncService 同步时从 GitHub commits API 拉取文件最近提交时间，存入 Metadata.github_last_commit_at；历史条目在下次同步命中 skip 分支时自动回填 |
| fix | prd-admin | 修复 DocBrowser 文件树滚动"不跟手"：移除 overscroll-behavior:contain（父级已 overflow:hidden，无需再拦截），TreeNode 的 transition-all 收窄为 transition-colors，避免滚动时 layout transition 造成漂移感 |
| fix | prd-admin | 修复 map 周报页目录树与预览内容联动滚动：改用纯 inline-style 2-pane 布局，强制 minHeight:0 + overflowY:auto 独立滚动 |
| fix | prd-admin | 修复 DocBrowser 强制 minHeight:calc(100vh-160px) 撑破父级导致 AppShell 主滚动的问题 |
| fix | prd-admin | 清理分支上遗留的 TS 编译错误（未用 import、listDocumentEntries 参数个数、EntryPreview 导入路径） |
| chore | doc | 统一 doc/ 命名：3 个 output-*.md 样本文件重命名为 report.skill-eval-sample-*.md，同步更新 report.skill-doc-evaluation / index.yml / guide.list.directory |
| rule | CLAUDE.md | 新增强制规则 #10：doc/ 下所有 .md 必须以 6 类前缀（spec/design/plan/rule/guide/report）开头，禁止 output-*.md / 裸文件名 / 子目录 |
| chore | doc | 批量统一 163 个 md 文件的 H1 标题格式：剥离 37 种混乱后缀（设计方案/设计文档/架构设计/技术设计/设计稿/方案/操作手册/规范/约定/规格说明/实施计划/...），统一追加 ` · 类型`，类型从文件名前缀映射（spec→规格 / design→设计 / plan→计划 / rule→规则 / guide→指南 / report→报告，周报→周报）；已含类型关键词的跳过追加避免重复 |
| fix | doc | 顺手修 2 个 H1 层级不规范文件：rule.doc-maintenance.md 的 `## ` 提升为 `# `，guide.prd-agent-operations.md 保留 YAML frontmatter 不动（H1 正常在 frontmatter 之后） |
