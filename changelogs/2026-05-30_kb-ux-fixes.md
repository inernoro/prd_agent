| fix | prd-admin | 划词评论选区"自动撤销"修复：MarkdownViewer 用 memo 包裹，避免父级 re-render（liveSelection 变化）导致 ReactMarkdown 按新内联组件标识 remount 正文 DOM、清空原生选区 |
| fix | prd-admin | 知识库选中条目（含分享链 ?entry）自动展开其所有祖先文件夹 + 滚动到可见，解决子文件夹归档后看不到"当前在读哪一篇" |
| feat | prd-admin | 文档列表更新时间默认显示，且永远固定在每行最右边 |
| fix | prd-admin | GitHub 目录订阅父条目"打不开/空白"修复：FilePreview 渲染目录卡片（仓库/路径/分支 + 跳 GitHub），对存量数据立即生效 |
| feat | prd-admin | 验收报告新增「证据关系图」：工具栏按钮（非文章正中）打开 ReactFlow 模态，把报告「## 步骤 N」解析成节点+截图缩略图、按顺序连边，构成探案证据板（手势遵循 gesture-unification 标准 B） |
| fix | create-visual-test-to-kb | 验收报告排序"最新不在最前"修复：归档复用已存在库时补设 templateKey（历史库为 null 导致排序退化字典序）；撤销按模块自动建子文件夹（会把最新报告藏进文件夹、与最新最前打架），报告改平铺根级配合 created-desc |
| fix | prd-admin | 文档列表显示时间跟随排序键（created-desc 显示创建时间），消除"按创建排序却显更新时间"的错位 |
| feat | prd-admin | 文档列表条目改两行布局：第一行图标+标题（不再被徽章挤成 prd-age...），第二行徽章（状态/标签/NEW）+时间；文件夹保持单行 |
| fix | prd-admin | 证据关系图清晰度优化：节点放大(320px)+纵向单列自上而下、连边加粗、缩略图点击弹全屏大图灯箱、默认缩放不过度缩小、模态加大(95vw)，解决"太小看不清" |
