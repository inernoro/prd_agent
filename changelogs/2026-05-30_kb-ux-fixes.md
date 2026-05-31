| fix | prd-admin | 划词评论选区"自动撤销"修复：MarkdownViewer 用 memo 包裹，避免父级 re-render（liveSelection 变化）导致 ReactMarkdown 按新内联组件标识 remount 正文 DOM、清空原生选区 |
| fix | prd-admin | 知识库选中条目（含分享链 ?entry）自动展开其所有祖先文件夹 + 滚动到可见，解决子文件夹归档后看不到"当前在读哪一篇" |
| feat | prd-admin | 文档列表更新时间默认显示，且永远固定在每行最右边 |
| fix | prd-admin | GitHub 目录订阅父条目"打不开/空白"修复：FilePreview 渲染目录卡片（仓库/路径/分支 + 跳 GitHub），对存量数据立即生效 |
| feat | prd-admin | 验收报告新增「证据关系图」：工具栏按钮（非文章正中）打开 ReactFlow 模态，把报告「## 步骤 N」解析成节点+截图缩略图、按顺序连边，构成探案证据板（手势遵循 gesture-unification 标准 B） |
| fix | create-visual-test-to-kb | 验收报告排序"最新不在最前"修复：归档复用已存在库时补设 templateKey（历史库为 null 导致排序退化字典序）；撤销按模块自动建子文件夹（会把最新报告藏进文件夹、与最新最前打架），报告改平铺根级配合 created-desc |
| fix | prd-admin | 文档列表显示时间跟随排序键（created-desc 显示创建时间），消除"按创建排序却显更新时间"的错位 |
| feat | prd-admin | 文档列表条目改两行布局：第一行图标+标题（不再被徽章挤成 prd-age...），第二行徽章（状态/标签/NEW）+时间；文件夹保持单行 |
| fix | prd-admin | 证据关系图清晰度优化：节点放大(320px)+纵向单列自上而下、连边加粗、缩略图点击弹全屏大图灯箱、默认缩放不过度缩小、模态加大(95vw)，解决"太小看不清" |
| fix | prd-admin | 文档列表条目层次感：两行内部收紧(gap 0.5)成一组、条目间加淡分隔线+增大行距，相邻条目不再糊在一起 |
| fix | prd-api | 安全(P1)：移除 AgentApiKey 全局 sub claim，owner 身份只在通过 scope 门禁的 AdminController 端点注入，避免 document-store:write key 越权访问任意用户端点 |
| fix | prd-api | scope 写蕴含读：document-store:write 自动满足 document-store.read，修复推荐的 write-only key 在 GET 上 403 |
| fix | prd-api | 移除 DocumentStoreController 里用 NUL 字节做字典分隔符（致全文件被 grep/rg 当二进制），改用元组键 |
| fix | prd-api | ImportStore 复用已存在同名库时补 templateKey；跳过 binary-only 空条目；人工写入持久化 templateCompliant 软标记 |
| fix | prd-admin | 证据图按钮 + 祖先展开 parentMap 合并 searchResults，搜索命中的验收报告也能显示证据图按钮/展开定位 |
| fix | prd-admin | 搜索命中条目正文加载错位修复(High)：内容加载 effect 改用 selectedEntryData(含 searchResults)，避免选中搜索结果时 preview 停在上一篇 |
| fix | create-visual-test-to-kb | kb_sync export 失败显式报错(不再 KeyError) |
| fix | prd-api | 跨环境导入跳过所有无正文非文件夹条目(空壳/二进制)，避免重复同步重复插入 |
| fix | prd-api | templateCompliant 标记同时依据 metadata + 正文 section，避免补正文时把缺 metadata 的报告误标合规 |
