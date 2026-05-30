| fix | prd-admin | 划词评论选区"自动撤销"修复：MarkdownViewer 用 memo 包裹，避免父级 re-render（liveSelection 变化）导致 ReactMarkdown 按新内联组件标识 remount 正文 DOM、清空原生选区 |
| fix | prd-admin | 知识库选中条目（含分享链 ?entry）自动展开其所有祖先文件夹 + 滚动到可见，解决子文件夹归档后看不到"当前在读哪一篇" |
| feat | prd-admin | 文档列表更新时间默认显示，且永远固定在每行最右边 |
| fix | prd-admin | GitHub 目录订阅父条目"打不开/空白"修复：FilePreview 渲染目录卡片（仓库/路径/分支 + 跳 GitHub），对存量数据立即生效 |
| feat | prd-admin | 验收报告新增「证据关系图」：工具栏按钮（非文章正中）打开 ReactFlow 模态，把报告「## 步骤 N」解析成节点+截图缩略图、按顺序连边，构成探案证据板（手势遵循 gesture-unification 标准 B） |
